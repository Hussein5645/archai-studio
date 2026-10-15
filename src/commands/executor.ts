import { applyPatches, current, enablePatches, produce, produceWithPatches, type Patch } from 'immer';
import { z } from 'zod';
import { moveNestedLayers } from '@/layers/movement';
import { checkInvariants, type ArchaiDocument, type IdSource } from '@/document';
import { refreshRooms, roomSyncKey, type TextMeasurer } from '@/geometry';
import { refreshConnectors } from '@/diagrams/model';
import type { AssetCatalog } from '@/catalog/types';
import type { Platform } from '@/platform/types';
import { HISTORY_LIMIT, type AppState, type AppStore, type HistoryEntry, type SessionState, type UiState } from '@/store';
import {
  CommandError,
  type AnyCommand,
  type Command,
  type CommandDescription,
  type CommandResult,
  type EffectContext,
  type MutationCommand,
  type MutationContext,
  type ReadContext,
} from './contract';
import type { CommandRegistry } from './registry';
import { applyBoardElevation } from './boardLevel';
import { addLog } from '@/diagnostics';

enablePatches();

export interface ExecutorServices {
  ids: IdSource;
  now: () => string;
  measurer: TextMeasurer;
  platform: Platform;
  catalog: AssetCatalog;
  /** Run document invariants after every mutation (on in development and tests). */
  devChecks?: boolean;
}

interface TransactionFrame {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  selectionBefore: string[];
  commandIds: string[];
}

export type ResultListener = (result: CommandResult, command: AnyCommand) => void;

/**
 * Every change to the open document, as immer patches: committed commands, undo and redo (not
 * document switches, and not `applyRemote`). Online projects send these to the board
 * (src/cloud/live.ts).
 */
export type DocChangeListener = (patches: Patch[], source: 'command' | 'undo' | 'redo') => void;

export const READ_ONLY_MESSAGE = 'View only: you can look at this project but not edit it';

function changedIdsFromPatches(patches: readonly Patch[]): string[] {
  const ids = new Set<string>();
  for (const patch of patches) {
    const [table, id] = patch.path;
    if ((table === 'elements' || table === 'definitions' || table === 'blobs') && typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

function pruneSelection(selection: string[], doc: ArchaiDocument): string[] {
  const pruned = selection.filter((id) => id in doc.elements);
  return pruned.length === selection.length ? selection : pruned;
}

export class CommandExecutor {
  private transactionFrame: TransactionFrame | null = null;
  private readonly listeners = new Set<ResultListener>();
  private readonly docListeners = new Set<DocChangeListener>();
  /** View-only online projects: commands that would change the document are refused. */
  private readOnly = false;

  constructor(
    readonly registry: CommandRegistry,
    readonly store: AppStore,
    readonly services: ExecutorServices,
  ) {}

  // ---- reading -----------------------------------------------------------------------------

  read(state: AppState = this.store.getState()): ReadContext {
    return {
      state,
      doc: state.doc,
      ui: state.ui,
      selection: state.ui.selection,
      hasSelection: state.ui.selection.length > 0,
      canUndo: state.history.past.length > 0,
      canRedo: state.history.future.length > 0,
    };
  }

  isAvailable(command: AnyCommand | string, state?: AppState): boolean {
    const resolved = typeof command === 'string' ? this.registry.get(command) : command;
    if (!resolved) return false;
    return resolved.when ? resolved.when(this.read(state)) : true;
  }

  describe(): CommandDescription[] {
    const ctx = this.read();
    return this.registry.all().map((command) => ({
      id: command.id,
      label: command.label,
      description: command.description,
      group: command.group,
      aliases: command.aliases ?? [],
      shortcuts: command.shortcuts ?? [],
      kind: command.kind,
      available: command.when ? command.when(ctx) : true,
      palette: command.palette ?? true,
      inputSchema: z.toJSONSchema(command.input, { unrepresentable: 'any' }),
    }));
  }

  onResult(listener: ResultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDocChange(listener: DocChangeListener): () => void {
    this.docListeners.add(listener);
    return () => this.docListeners.delete(listener);
  }

  private emitDoc(patches: Patch[], source: 'command' | 'undo' | 'redo'): void {
    if (patches.length === 0) return;
    for (const listener of this.docListeners) listener(patches, source);
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Someone else's change to the open document (an online project's board): applied without
   * history, never reported to `onDocChange`. False when the patches do not fit the document.
   */
  applyRemote(patches: readonly Patch[]): boolean {
    const state = this.store.getState();
    let doc: ArchaiDocument;
    try {
      doc = applyPatches(state.doc, patches as Patch[]);
    } catch {
      return false;
    }
    this.store.setState({ doc, ui: { ...state.ui, selection: pruneSelection(state.ui.selection, doc) } });
    return true;
  }

  /**
   * Replaces the open document's content (an online project rebuilt from the board's version):
   * same document, no `onDocChange`. `resetHistory` drops undo steps that may no longer fit.
   */
  replaceDocument(doc: ArchaiDocument, resetHistory = false): void {
    const state = this.store.getState();
    this.store.setState({
      doc,
      ui: { ...state.ui, selection: pruneSelection(state.ui.selection, doc) },
      ...(resetHistory ? { history: { past: [], future: [] } } : {}),
    });
  }

  // ---- dispatching -------------------------------------------------------------------------

  private resolve(command: AnyCommand | string): AnyCommand | CommandResult<never> {
    const resolved = typeof command === 'string' ? this.registry.get(command) : command;
    if (!resolved) {
      const id = typeof command === 'string' ? command : '?';
      return { ok: false, commandId: id, error: { code: 'unknown-command', message: `Unknown command: ${id}` } };
    }
    return resolved;
  }

  async dispatch<I, O, R>(command: Command<I, O, R> | string, input?: I): Promise<CommandResult<R>> {
    const resolved = this.resolve(command as AnyCommand | string);
    if ('ok' in resolved) return resolved;
    if (resolved.kind === 'mutation') return this.dispatchSync(resolved as MutationCommand<I, O, R>, input);
    return this.runEffect(resolved, input);
  }

  dispatchSync<I, O, R>(command: MutationCommand<I, O, R> | string, input?: I): CommandResult<R> {
    const resolved = this.resolve(command as AnyCommand | string);
    if ('ok' in resolved) return resolved;
    if (resolved.kind !== 'mutation') {
      return {
        ok: false,
        commandId: resolved.id,
        error: { code: 'rejected', message: `${resolved.id} is an effect; use dispatch()` },
      };
    }
    const result = this.runMutation(resolved as MutationCommand<I, O, R>, input);
    this.emit(result, resolved);
    return result;
  }

  private emit(result: CommandResult, command: AnyCommand): void {
    addLog(result.ok ? 'info' : 'error', `${command.label}: ${result.ok ? 'done' : result.error.message}`);
    for (const listener of this.listeners) listener(result, command);
  }

  private validate<I, O>(command: AnyCommand, input: I | undefined): O | CommandResult<never> {
    const parsed = command.input.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        commandId: command.id,
        error: {
          code: 'invalid-input',
          message: `Invalid input for ${command.id}`,
          details: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        },
      };
    }
    return parsed.data as O;
  }

  private runMutation<I, O, R>(command: MutationCommand<I, O, R>, rawInput: I | undefined): CommandResult<R> {
    const validated = this.validate<I, O>(command, rawInput);
    if (typeof validated === 'object' && validated !== null && 'ok' in validated && validated.ok === false) {
      return validated as CommandResult<R>;
    }
    const input = validated as O;
    const state = this.store.getState();
    if (command.when && !command.when(this.read(state))) {
      return { ok: false, commandId: command.id, error: { code: 'unavailable', message: `${command.label} is not available right now` } };
    }

    let value!: R;
    let nextUi: UiState = state.ui;
    let nextSession: SessionState = state.session;
    let nextDoc: ArchaiDocument;
    let patches: Patch[];
    let inversePatches: Patch[];
    try {
      [nextDoc, patches, inversePatches] = produceWithPatches(state.doc, (doc) => {
        const roomKey = roomSyncKey(doc as unknown as ArchaiDocument);
        nextUi = produce(state.ui, (ui) => {
          nextSession = produce(state.session, (session) => {
            value = command.run(this.mutationContext(doc, ui, session), input);
            if (doc.id === state.doc.id && current(doc) !== state.doc) moveNestedLayers(state.doc.elements, doc.elements);
            const sync = this.registry.get('sync-parametric-graphs');
            if (sync?.kind === 'mutation' && command.id !== sync.id && current(doc) !== state.doc) sync.run(this.mutationContext(doc, ui, session), { previous: state.doc });
            // New elements start at the board level.
            if (command.group === 'create' && doc.workspace.boardElevation) applyBoardElevation(state.doc.elements, doc as unknown as ArchaiDocument);
          });
        });
        if (roomSyncKey(doc as unknown as ArchaiDocument) !== roomKey) refreshRooms(doc as unknown as ArchaiDocument);
        // Glued connectors follow the elements they join.
        if (current(doc) !== state.doc) refreshConnectors(doc as unknown as ArchaiDocument);
      });
    } catch (error) {
      if (error instanceof CommandError) {
        return { ok: false, commandId: command.id, error: { code: error.code, message: error.message, details: error.details } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, commandId: command.id, error: { code: 'failed', message, details: error } };
    }

    if (this.services.devChecks && patches.length > 0) {
      const violations = checkInvariants(nextDoc);
      if (violations.length > 0) {
        return {
          ok: false,
          commandId: command.id,
          error: { code: 'failed', message: `${command.id} would break document invariants`, details: violations },
        };
      }
    }

    const docChanged = patches.length > 0;
    if (docChanged && this.readOnly && !command.resetsHistory) {
      return { ok: false, commandId: command.id, error: { code: 'rejected', message: READ_ONLY_MESSAGE } };
    }
    const selectionAfter = pruneSelection(nextUi.selection, nextDoc);
    if (selectionAfter !== nextUi.selection) nextUi = { ...nextUi, selection: selectionAfter };

    let history = state.history;
    let historyEntryId: string | null = null;
    if (command.resetsHistory) {
      history = { past: [], future: [] };
    } else if (docChanged && command.history === 'record') {
      if (this.transactionFrame) {
        this.transactionFrame.patches.push(...patches);
        this.transactionFrame.inversePatches.unshift(...inversePatches);
        this.transactionFrame.commandIds.push(command.id);
      } else {
        const entry: HistoryEntry = {
          id: this.services.ids.next('hist'),
          label: command.label,
          commandId: command.id,
          input,
          patches,
          inversePatches,
          selectionBefore: state.ui.selection,
          selectionAfter,
          at: this.services.now(),
        };
        history = pushHistory(history, entry);
        historyEntryId = entry.id;
      }
    }
    if (docChanged && !command.resetsHistory) {
      nextDoc = { ...nextDoc, meta: { ...nextDoc.meta, updatedAt: this.services.now() } };
      if (!nextSession.dirty) nextSession = { ...nextSession, dirty: true };
    }

    // A committed change supersedes any gesture preview (normally the gesture's own command).
    this.store.setState({ doc: nextDoc, ui: nextUi, history, session: nextSession, ...(docChanged ? { preview: null } : {}) });
    if (docChanged && !command.resetsHistory && nextDoc.id === state.doc.id) this.emitDoc(patches, 'command');
    return { ok: true, commandId: command.id, value, patches, changedIds: changedIdsFromPatches(patches), historyEntryId };
  }

  private mutationContext(
    doc: MutationContext['doc'],
    ui: MutationContext['ui'],
    session: MutationContext['session'],
  ): MutationContext {
    return { doc, ui, session, ids: this.services.ids, now: this.services.now, measurer: this.services.measurer };
  }

  private async runEffect<I, O, R>(command: AnyCommand, rawInput: I | undefined): Promise<CommandResult<R>> {
    const validated = this.validate<I, O>(command, rawInput);
    if (typeof validated === 'object' && validated !== null && 'ok' in validated && validated.ok === false) {
      return validated as CommandResult<R>;
    }
    if (command.when && !command.when(this.read())) {
      return { ok: false, commandId: command.id, error: { code: 'unavailable', message: `${command.label} is not available right now` } };
    }
    let result: CommandResult<R>;
    try {
      const value = (await (command as Command<I, O, R>).run(this.effectContext() as never, validated as O)) as R;
      result = { ok: true, commandId: command.id, value, patches: [], changedIds: [], historyEntryId: null };
    } catch (error) {
      if (error instanceof CommandError) {
        result = { ok: false, commandId: command.id, error: { code: error.code, message: error.message, details: error.details } };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        result = { ok: false, commandId: command.id, error: { code: 'failed', message, details: error } };
      }
    }
    this.emit(result, command);
    return result;
  }

  private effectContext(): EffectContext {
    return {
      getState: () => this.store.getState(),
      read: () => this.read(),
      dispatch: (command, input) => this.dispatch(command, input),
      dispatchSync: (command, input) => this.dispatchSync(command, input),
      transaction: (label, fn) => this.transaction(label, fn),
      undo: () => this.undo(),
      redo: () => this.redo(),
      ids: this.services.ids,
      now: this.services.now,
      measurer: this.services.measurer,
      platform: this.services.platform,
      catalog: this.services.catalog,
    };
  }

  /**
   * Runs a mutation against an arbitrary base document without committing anything. Used by
   * interactive drags to show live previews while recording a single command on release.
   */
  preview<I>(command: MutationCommand<I, unknown, unknown> | string, input: I, base: ArchaiDocument): ArchaiDocument {
    const resolved = this.resolve(command as AnyCommand | string);
    if ('ok' in resolved || resolved.kind !== 'mutation') return base;
    const parsed = resolved.input.safeParse(input);
    if (!parsed.success) return base;
    const state = this.store.getState();
    try {
      return produce(base, (doc) => {
        const roomKey = roomSyncKey(doc as unknown as ArchaiDocument);
        produce(state.ui, (ui) => {
          produce(state.session, (session) => {
            resolved.run(this.mutationContext(doc, ui, session), parsed.data);
            if (current(doc) !== base) moveNestedLayers(base.elements, doc.elements);
            const sync = this.registry.get('sync-parametric-graphs');
            if (sync?.kind === 'mutation' && resolved.id !== sync.id && current(doc) !== base) sync.run(this.mutationContext(doc, ui, session), { previous: base });
          });
        });
        if (roomSyncKey(doc as unknown as ArchaiDocument) !== roomKey) refreshRooms(doc as unknown as ArchaiDocument);
        // Glued connectors follow the elements they join.
        if (current(doc) !== base) refreshConnectors(doc as unknown as ArchaiDocument);
      });
    } catch {
      return base;
    }
  }

  // ---- transactions & history ---------------------------------------------------------------

  transaction<T>(label: string, fn: () => T): T {
    if (this.transactionFrame) return fn();
    const state = this.store.getState();
    this.transactionFrame = { label, patches: [], inversePatches: [], selectionBefore: state.ui.selection, commandIds: [] };
    let frame: TransactionFrame;
    try {
      return fn();
    } finally {
      frame = this.transactionFrame;
      this.transactionFrame = null;
      if (frame.patches.length > 0) {
        const after = this.store.getState();
        const entry: HistoryEntry = {
          id: this.services.ids.next('hist'),
          label: frame.label,
          commandId: 'transaction',
          input: { commands: frame.commandIds },
          patches: frame.patches,
          inversePatches: frame.inversePatches,
          selectionBefore: frame.selectionBefore,
          selectionAfter: after.ui.selection,
          at: this.services.now(),
        };
        this.store.setState({ history: pushHistory(after.history, entry) });
      }
    }
  }

  undo(): boolean {
    const state = this.store.getState();
    const entry = state.history.past[state.history.past.length - 1];
    if (!entry || this.transactionFrame || this.readOnly) return false;
    let doc: ArchaiDocument;
    try {
      doc = applyPatches(state.doc, entry.inversePatches);
    } catch {
      // Someone else changed what this step touched (online projects): it cannot be undone.
      this.store.setState({ history: { past: state.history.past.slice(0, -1), future: state.history.future } });
      return false;
    }
    this.store.setState({
      doc,
      ui: { ...state.ui, selection: pruneSelection(entry.selectionBefore, doc), editingTextId: null },
      history: { past: state.history.past.slice(0, -1), future: [entry, ...state.history.future] },
      session: { ...state.session, dirty: true },
    });
    this.emitDoc(entry.inversePatches, 'undo');
    return true;
  }

  redo(): boolean {
    const state = this.store.getState();
    const entry = state.history.future[0];
    if (!entry || this.transactionFrame || this.readOnly) return false;
    let doc: ArchaiDocument;
    try {
      doc = applyPatches(state.doc, entry.patches);
    } catch {
      this.store.setState({ history: { past: state.history.past, future: state.history.future.slice(1) } });
      return false;
    }
    this.store.setState({
      doc,
      ui: { ...state.ui, selection: pruneSelection(entry.selectionAfter, doc), editingTextId: null },
      history: { past: [...state.history.past, entry], future: state.history.future.slice(1) },
      session: { ...state.session, dirty: true },
    });
    this.emitDoc(entry.patches, 'redo');
    return true;
  }
}

function pushHistory(history: AppState['history'], entry: HistoryEntry): AppState['history'] {
  const past = [...history.past, entry];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}
