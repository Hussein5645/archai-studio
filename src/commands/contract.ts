/**
 * The command contract. Every meaningful action — from the palette, a shortcut, a toolbar
 * button, the context menu, the application menu, or a future AI agent — goes through this.
 *
 * Two kinds:
 * - `mutation`: synchronous and deterministic; edits Immer drafts of the document and UI state.
 *   The executor records the resulting patches for undo/redo.
 * - `effect`: asynchronous; may talk to the platform (dialogs, files, clipboard, network) and
 *   dispatches mutations to change state. Never edits state directly.
 */
import type { Draft, Patch } from 'immer';
import type { z } from 'zod';
import type { IdSource, ArchaiDocument } from '@/document';
import type { TextMeasurer } from '@/geometry';
import type { AssetCatalog } from '@/catalog/types';
import type { Platform } from '@/platform/types';
import type { AppState, SessionState, UiState } from '@/store';

export type CommandGroup =
  | 'create'
  | 'select'
  | 'transform'
  | 'edit'
  | 'arrange'
  | 'view'
  | 'history'
  | 'document'
  | 'shell';

export interface ReadContext {
  state: AppState;
  doc: ArchaiDocument;
  ui: UiState;
  selection: string[];
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface MutationContext {
  doc: Draft<ArchaiDocument>;
  ui: Draft<UiState>;
  session: Draft<SessionState>;
  ids: IdSource;
  now: () => string;
  measurer: TextMeasurer;
}

export type CommandErrorCode =
  | 'unknown-command'
  | 'invalid-input'
  | 'unavailable'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export class CommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export type CommandResult<R = unknown> =
  | {
      ok: true;
      commandId: string;
      value: R;
      /** Document patches produced by this command (empty for effects and UI-only commands). */
      patches: Patch[];
      /** Ids of elements/definitions/blobs touched by the patches. */
      changedIds: string[];
      historyEntryId: string | null;
    }
  | {
      ok: false;
      commandId: string;
      error: { code: CommandErrorCode; message: string; details?: unknown };
    };

export type Dispatch = <I, O, R>(command: Command<I, O, R> | string, input?: I) => Promise<CommandResult<R>>;
export type DispatchSync = <I, O, R>(
  command: MutationCommand<I, O, R> | string,
  input?: I,
) => CommandResult<R>;

export interface EffectContext {
  getState(): AppState;
  read(): ReadContext;
  dispatch: Dispatch;
  dispatchSync: DispatchSync;
  /** Runs `fn` (which dispatches mutations synchronously) as a single undoable step. */
  transaction<T>(label: string, fn: () => T): T;
  undo(): boolean;
  redo(): boolean;
  ids: IdSource;
  now: () => string;
  measurer: TextMeasurer;
  platform: Platform;
  catalog: AssetCatalog;
}

/** `I` is what callers pass (zod input), `O` what `run` receives (zod output, defaults applied). */
interface CommandBase<I, O> {
  /** Stable kebab-case identifier, e.g. `move-selection`. */
  id: string;
  label: string;
  description?: string;
  /** Extra search terms for the palette. */
  aliases?: string[];
  /** e.g. `Mod+D`, `Delete`, `Shift+ArrowUp`. The only keyboard source of truth. */
  shortcuts?: string[];
  group: CommandGroup;
  input: z.ZodType<O, I>;
  /** Availability; pure. Absent means always available. */
  when?: (ctx: ReadContext) => boolean;
  /** `false` hides the command from the palette (e.g. commands that need numeric input). */
  palette?: boolean;
}

export interface MutationCommand<I, O, R = void> extends CommandBase<I, O> {
  kind: 'mutation';
  /** `record` creates an undo step when the document changed; `none` never does. */
  history: 'record' | 'none';
  /** Set when the command replaces the whole document (open/new); clears undo history. */
  resetsHistory?: boolean;
  run: (ctx: MutationContext, input: O) => R;
}

export interface EffectCommand<I, O, R = void> extends CommandBase<I, O> {
  kind: 'effect';
  run: (ctx: EffectContext, input: O) => Promise<R>;
}

export type Command<I = unknown, O = unknown, R = unknown> = MutationCommand<I, O, R> | EffectCommand<I, O, R>;

// The registry stores heterogeneous commands; `any` is confined to this alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = Command<any, any, any>;

export function defineMutation<I, O, R = void>(
  spec: Omit<MutationCommand<I, O, R>, 'kind'>,
): MutationCommand<I, O, R> {
  return { kind: 'mutation', ...spec };
}

export function defineEffect<I, O, R = void>(
  spec: Omit<EffectCommand<I, O, R>, 'kind'>,
): EffectCommand<I, O, R> {
  return { kind: 'effect', ...spec };
}

/** A structured description of a command, suitable for a palette or an AI tool list. */
export interface CommandDescription {
  id: string;
  label: string;
  description?: string;
  group: CommandGroup;
  aliases: string[];
  shortcuts: string[];
  kind: 'mutation' | 'effect';
  available: boolean;
  palette: boolean;
  inputSchema: unknown;
}
