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
import { documentKey, forgetRecent, parseSessionRecord, SESSION_KEY, touchRecent, type RecentEntry, type SessionRecord } from './session';

type Listener = () => void;

export class PersistenceService {
  private record: SessionRecord = { version: 1, lastDocumentId: null, recent: [], viewports: {} };
  private readonly listeners = new Set<Listener>();
  private docTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private stopStore: (() => void) | null = null;
  private lastSavedDoc: unknown = null;
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
  async openStored(id: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.workingCopies.load(id);
    } catch (error) {
      console.error(`[Persistence] Failed to read document ${id}:`, error);
      return false;
    }
    if (raw === null) {
      this.record = forgetRecent(this.record, id);
      await this.writeSession();
      return false;
    }
    const parsed = parseDocumentData(raw);
    if (!parsed.ok) {
      console.error(`[Persistence] Failed to parse document ${id}:`, parsed.error);
      return false;
    }
    const entry = this.record.recent.find((r) => r.id === id);
    const loaded = this.executor.dispatchSync(loadDocument, { document: parsed.document, filePath: entry?.filePath ?? null });
    if (!loaded.ok) {
      console.error(`[Persistence] Failed to load document ${id}:`, loaded);
      return false;
    }
    const viewport = this.record.viewports[id];
    if (viewport) this.executor.dispatchSync(setViewport, viewport);
    this.lastSavedDoc = this.store.getState().doc;
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
    let previous = this.store.getState();
    this.stopStore = this.store.subscribe((state) => {
      if (state.doc !== previous.doc || state.session.filePath !== previous.session.filePath) this.scheduleDocSave();
      if (state.ui.viewport !== previous.ui.viewport) this.scheduleViewportSave();
      previous = state;
    });
  }

  stop(): void {
    this.stopStore?.();
    this.stopStore = null;
    if (this.docTimer) clearTimeout(this.docTimer);
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
  }

  /** Writes any pending changes immediately (e.g. before the window closes). */
  async flush(): Promise<void> {
    if (this.docTimer) {
      clearTimeout(this.docTimer);
      this.docTimer = null;
    }
    if (this.viewportTimer) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    }
    await this.saveDocument();
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
    const record = touchRecent(this.record, { id: document.id, name: document.meta.name, updatedAt: document.meta.updatedAt, filePath: null, ...extra });
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

  private async saveDocument(): Promise<void> {
    const state = this.store.getState();
    if (state.doc === this.lastSavedDoc && this.record.lastDocumentId === state.doc.id) return;
    // The Home screen's placeholder document is not a project: never list it.
    if (state.ui.screen === 'home' && !this.record.recent.some((entry) => entry.id === state.doc.id)) return;
    this.lastSavedDoc = state.doc;
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
    } catch (error) {
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
