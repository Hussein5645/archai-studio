/**
 * Autosaves a working copy of the open document to host storage, keeps the session record
 * (recent documents, per-document viewport) current, and restores the last document on boot.
 */
import type { CommandExecutor } from '@/commands/executor';
import { loadDocument, setViewport } from '@/commands/builtin';
import type { ArchaiDocument } from '@/document';
import type { Platform } from '@/platform/types';
import type { AppStore } from '@/store';
import { EXAMPLE_PROJECT_ID, fetchExampleProject } from './example-project';
import { parseDocument, parseDocumentData } from './serialize';
import { WorkingCopyStore } from './workingCopy';
import { finishProjectBoard, prepareProjectBoard, withProjectLoading, type ProjectLoadTask } from './projectLoading';
import { preferences } from '@/ui/preferences';
import { documentKey, forgetRecent, parseSessionRecord, SESSION_KEY, touchRecent, type RecentEntry, type SessionRecord } from './session';

type Listener = () => void;

export class PersistenceService {
  private record: SessionRecord = { version: 1, lastDocumentId: null, recent: [], viewports: {} };
  private readonly listeners = new Set<Listener>();
  private docTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private stopStore: (() => void) | null = null;
  private stopPreferences: (() => void) | null = null;
  private stopCommands: (() => void) | null = null;
  private saveStatus: 'saved' | 'unsaved' | 'saving' | 'error' = 'saved';
  private lastSavedDoc: unknown = null;
  private opening = false;
  private readonly pendingSaves = new Set<Promise<void>>();

  getSaveStatus = () => this.saveStatus;

  private setSaveStatus(status: typeof this.saveStatus): void {
    if (status === this.saveStatus) return;
    this.saveStatus = status;
    this.notify();
  }

  private autosaveEnabled(): boolean {
    return preferences.get().autosave || Boolean(this.entry(this.store.getState().doc.id)?.cloud);
  }

  async saveNow(): Promise<void> {
    await this.flush(true);
    if (this.saveStatus === 'error') throw new Error('Could not save the project. Please try again.');
  }
  private readonly workingCopies: WorkingCopyStore;

  constructor(
    private readonly store: AppStore,
    private readonly executor: CommandExecutor,
    private readonly platform: Platform,
  ) {
    this.workingCopies = new WorkingCopyStore(platform.storage);
  }

  /** Loads the session record and returns it without automatically opening a document. */
  async restoreSession(): Promise<SessionRecord> {
    this.record = parseSessionRecord(await this.platform.storage.get(SESSION_KEY));
    await this.ensureExampleProject();
    this.notify();
    return this.record;
  }

  /** Installs the built-in example project on first boot (or if its storage was cleared) so
   * Recent Projects is never empty; a no-op once it's already stored and listed. */
  private async ensureExampleProject(): Promise<void> {
    const alreadyListed = this.record.recent.some((r) => r.id === EXAMPLE_PROJECT_ID);
    const stored = await this.platform.storage.get(documentKey(EXAMPLE_PROJECT_ID));
    if (stored && alreadyListed) return;
    try {
      let name: string;
      let updatedAt: string;
      if (stored) {
        const parsed = parseDocument(stored);
        if (!parsed.ok) throw new Error(`Stored example project is corrupt: ${parsed.error.message}`);
        name = parsed.document.meta.name;
        updatedAt = parsed.document.meta.updatedAt;
      } else {
        const fetched = await fetchExampleProject();
        await this.platform.storage.set(documentKey(EXAMPLE_PROJECT_ID), fetched.text);
        name = fetched.document.meta.name;
        updatedAt = fetched.document.meta.updatedAt;
      }
      const entry: RecentEntry = { id: EXAMPLE_PROJECT_ID, name, updatedAt, filePath: null, builtin: true };
      // Already-stored (just missing from the list) is appended without disturbing MRU order;
      // a fresh install adds it like any newly created project.
      this.record = stored ? { ...this.record, recent: [...this.record.recent, entry] } : touchRecent(this.record, entry);
      await this.writeSession();
    } catch (error) {
      console.error('Could not seed the built-in example project', error);
    }
  }

  /** Overwrites the example project's working copy with the pristine shipped version, discarding
   * any edits; reloads it live if it's the document currently open. */
  async resetExampleProject(): Promise<void> {
    const { text, document } = await fetchExampleProject();
    await this.platform.storage.set(documentKey(EXAMPLE_PROJECT_ID), text);
    const entry: RecentEntry = { id: EXAMPLE_PROJECT_ID, name: document.meta.name, updatedAt: document.meta.updatedAt, filePath: null, builtin: true };
    this.record = touchRecent(this.record, entry);
    await this.writeSession();
    if (this.store.getState().doc.id === EXAMPLE_PROJECT_ID) {
      this.executor.dispatchSync(loadDocument, { document, filePath: null });
      this.lastSavedDoc = this.store.getState().doc;
    }
  }

  /** Loads the session record and, when there is one, the last open working copy (or specified target id). */
  async restore(targetId?: string | null): Promise<boolean> {
    await this.restoreSession();
    const idToOpen = targetId !== undefined ? targetId : this.record.lastDocumentId;
    if (!idToOpen) return false;
    return this.openStored(idToOpen);
  }

  /** Opens a working copy by document id (used by "recent documents"). */
  async openStored(id: string, task?: ProjectLoadTask): Promise<boolean> {
    if (task) return this.openStoredWithin(id, task);
    if (this.opening) return false;
    return withProjectLoading(this.entry(id)?.name ?? 'Project', (loading) => this.openStoredWithin(id, loading));
  }

  private async openStoredWithin(id: string, task: ProjectLoadTask): Promise<boolean> {
    this.opening = true;
    try {
      await this.flushPending();
      return await this.readStored(id, task);
    } finally {
      this.opening = false;
    }
  }

  private async readStored(id: string, task: ProjectLoadTask): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.workingCopies.load(id, (done, total) => task.update('Reading project', 0.05 + 0.2 * done / Math.max(1, total)));
    } catch (error) {
      console.error(`[Persistence] Failed to read document ${id}:`, error);
      return false;
    }
    if (raw === null) {
      this.record = forgetRecent(this.record, id);
      await this.writeSession();
      return false;
    }
    task.update('Checking project', 0.3);
    await task.paint();
    const parsed = parseDocumentData(raw);
    if (!parsed.ok) {
      console.error(`[Persistence] Failed to parse document ${id}:`, parsed.error);
      return false;
    }
    const entry = this.record.recent.find((r) => r.id === id);
    await prepareProjectBoard(parsed.document, task, this.executor.services.catalog);
    const loaded = this.executor.dispatchSync(loadDocument, { document: parsed.document, filePath: entry?.filePath ?? null });
    if (!loaded.ok) {
      console.error(`[Persistence] Failed to load document ${id}:`, loaded);
      return false;
    }
    const viewport = this.record.viewports[id];
    if (viewport) this.executor.dispatchSync(setViewport, viewport);
    this.lastSavedDoc = this.store.getState().doc;
    this.setSaveStatus('saved');
    await finishProjectBoard(this.store.getState().doc, task);
    this.record = touchRecent(this.record, {
      id: parsed.document.id,
      name: parsed.document.meta.name,
      updatedAt: parsed.document.meta.updatedAt,
      filePath: entry?.filePath ?? null,
      ...(entry?.builtin ? { builtin: true } : {}),
      ...(entry?.cloud ? { cloud: entry.cloud } : {}),
    });
    await this.writeSession();
    return true;
  }

  start(): void {
    this.stopStore?.();
    this.stopPreferences?.();
    this.stopCommands?.();
    this.stopCommands = this.executor.onResult((result) => {
      if (result.ok && result.value && ['save-document', 'save-document-as'].includes(result.commandId)) void this.saveNow().catch((error: unknown) => console.error('Could not save working copy', error));
    });
    this.stopPreferences = preferences.subscribe(() => {
      if (!this.autosaveEnabled()) {
        if (this.docTimer) clearTimeout(this.docTimer);
        this.docTimer = null;
      } else if (this.store.getState().doc !== this.lastSavedDoc) this.scheduleDocSave();
    });
    let previous = this.store.getState();
    this.stopStore = this.store.subscribe((state) => {
      // Opening an existing copy is not an edit: avoid immediately serialising it again.
      if (!this.opening) {
        if (state.doc !== previous.doc || state.session.filePath !== previous.session.filePath) {
          if (state.doc !== this.lastSavedDoc) this.setSaveStatus(state.session.filePath && !state.session.dirty ? 'saved' : 'unsaved');
          if (this.autosaveEnabled()) this.scheduleDocSave();
        }
        if (state.ui.viewport !== previous.ui.viewport) this.scheduleViewportSave();
      }
      previous = state;
    });
  }

  stop(): void {
    this.stopStore?.();
    this.stopStore = null;
    this.stopPreferences?.();
    this.stopPreferences = null;
    this.stopCommands?.();
    this.stopCommands = null;
    if (this.docTimer) clearTimeout(this.docTimer);
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
  }

  /** Writes any pending changes immediately (e.g. before the window closes). */
  async flushPending(): Promise<void> {
    if (this.docTimer || this.viewportTimer) await this.flush();
    await Promise.all([...this.pendingSaves]);
    if (this.saveStatus === 'error') throw new Error('Could not save the current project. Try saving again before switching projects.');
  }

  async flush(force = false): Promise<void> {
    if (this.docTimer) {
      clearTimeout(this.docTimer);
      this.docTimer = null;
    }
    if (this.viewportTimer) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    }
    if (force || this.autosaveEnabled()) await this.saveDocument();
    await this.saveViewport();
  }

  /** Stable between session writes, so it is safe for `useSyncExternalStore`. */
  recent(): RecentEntry[] {
    return this.record.recent;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entry(id: string): RecentEntry | undefined {
    return this.record.recent.find((r) => r.id === id);
  }

  /** Stores a project's working copy and lists it without opening it (online projects). */
  async storeDocument(document: ArchaiDocument, extra: Pick<RecentEntry, 'cloud'> = {}): Promise<void> {
    await this.workingCopies.save(document);
    const lastDocumentId = this.record.lastDocumentId;
    const record = touchRecent(this.record, { id: document.id, name: document.meta.name, updatedAt: document.meta.updatedAt, filePath: extra.cloud ? null : (this.entry(document.id)?.filePath ?? null), ...extra });
    this.record = { ...record, lastDocumentId };
    await this.writeSession();
  }

  /** Records which server version an online project's cached copy is. */
  async setCloud(id: string, cloud: NonNullable<RecentEntry['cloud']>): Promise<void> {
    if (!this.record.recent.some((r) => r.id === id)) return;
    this.record = { ...this.record, recent: this.record.recent.map((r) => (r.id === id ? { ...r, cloud } : r)) };
    await this.writeSession();
  }

  /** A stored project's working copy (to upload or copy it), or null. */
  async loadStored(id: string): Promise<ArchaiDocument | null> {
    const raw = await this.workingCopies.load(id);
    if (raw === null) return null;
    const parsed = parseDocumentData(raw);
    return parsed.ok ? parsed.document : null;
  }

  async forget(id: string): Promise<void> {
    if (id === EXAMPLE_PROJECT_ID) return;
    this.record = forgetRecent(this.record, id);
    await this.workingCopies.delete(id);
    await this.writeSession();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleDocSave(): void {
    if (this.docTimer) clearTimeout(this.docTimer);
    // A new (or just switched-to) document is written at once: a reload or a second tab in the
    // debounce window would otherwise not find it and start another copy.
    if (this.store.getState().doc.id !== this.record.lastDocumentId) {
      this.docTimer = null;
      void this.saveDocument();
      return;
    }
    this.docTimer = setTimeout(() => {
      this.docTimer = null;
      void this.saveDocument();
    }, 400);
  }

  private scheduleViewportSave(): void {
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.viewportTimer = null;
      void this.saveViewport();
    }, 800);
  }

  private saveDocument(): Promise<void> {
    const pending = this.writeDocument();
    this.pendingSaves.add(pending);
    const cleanup = () => { this.pendingSaves.delete(pending); };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private async writeDocument(): Promise<void> {
    const state = this.store.getState();
    if (state.doc === this.lastSavedDoc && this.record.lastDocumentId === state.doc.id) return;
    // The Home screen's placeholder document is not a project: never list it.
    if (state.ui.screen === 'home' && !this.record.recent.some((entry) => entry.id === state.doc.id)) return;
    this.setSaveStatus('saving');
    try {
      await this.workingCopies.save(state.doc);
      const existing = this.record.recent.find((r) => r.id === state.doc.id);
      this.record = touchRecent(this.record, {
        id: state.doc.id,
        name: state.doc.meta.name,
        updatedAt: state.doc.meta.updatedAt,
        filePath: state.session.filePath,
        ...(existing?.builtin ? { builtin: true } : {}),
        ...(existing?.cloud ? { cloud: existing.cloud } : {}),
      });
      await this.writeSession();
      this.lastSavedDoc = state.doc;
      this.setSaveStatus(this.store.getState().doc === state.doc ? 'saved' : 'unsaved');
    } catch (error) {
      this.setSaveStatus('error');
      console.error('Autosave failed', error);
    }
  }

  private async saveViewport(): Promise<void> {
    const state = this.store.getState();
    this.record = { ...this.record, viewports: { ...this.record.viewports, [state.doc.id]: state.ui.viewport } };
    await this.writeSession();
  }

  private async writeSession(): Promise<void> {
    await this.platform.storage.set(SESSION_KEY, JSON.stringify(this.record));
    this.notify();
  }
}
