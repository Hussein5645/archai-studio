/**
 * Editing an online project together (docs/accounts-and-cloud.md, "Editing together"): the open
 * project's connection to its board (workers/archai-cloud/src/board.js).
 *
 * Every local change (the executor's `onDocChange`: commands, undo, redo) is sent as a batch of
 * immer patches. The board applies batches in arrival order and numbers them; everyone applies
 * them in that order. To end up with the board's document while local batches are still on
 * their way, the session keeps the board's version of the document (`serverDoc`) and the
 * batches not yet acknowledged (`pending`): a change from someone else is applied to `serverDoc`
 * and the pending batches are applied again on top, exactly the order the board will use. A batch
 * the board refuses (what it edits was deleted meanwhile) is dropped and the document reloaded.
 *
 * Presence: cursor (board mm) and selection, sent at most every PRESENCE_MS.
 */
import type { Patch } from 'immer';
import { applyPatches } from 'immer';
import type { CommandExecutor } from '@/commands/executor';
import type { ArchaiDocument } from '@/document';
import { parseDocument } from '@/persistence/serialize';
import type { AppStore } from '@/store';
import { CLOUD_URL, type AccountService } from './account';

export interface Peer {
  sid: string;
  userId: string;
  name: string;
  colour: string;
  role: 'owner' | 'editor' | 'viewer';
  cursor: { x: number; y: number } | null;
  selection: string[];
}

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'closed';

export interface LiveState {
  status: LiveStatus;
  /** Local batches the board has not acknowledged yet. */
  pending: number;
  version: number;
  role: Peer['role'];
  you: Peer | null;
  peers: Peer[];
}

export interface LiveEvents {
  /** Save the local document before a rejected edit can reload an older cloud copy. */
  preserve?(document: ArchaiDocument): Promise<void>;
  /** Something the user should hear about ("Ana changed what you were editing"). */
  notice(message: string, kind: 'info' | 'error'): void;
  /** Version or pending changed: persist `{ version, pending }` for this project. */
  progress(version: number, pending: boolean): void;
  role(role: Peer['role']): void;
  /** Removed from the project, or the project was deleted. */
  ended(reason: string): void;
}

/** Larger batches go over HTTP (POST /ops) instead of the socket. */
const SOCKET_LIMIT = 400 * 1024;
const PRESENCE_MS = 40;
const RECONNECT_MS = [1000, 2000, 5000, 10000, 20000, 30000];

interface Batch {
  seq: number;
  patches: Patch[];
  /** Sent on the current connection. */
  sent: boolean;
}

type ServerMessage =
  | { t: 'welcome'; you: Peer; peers: Peer[] }
  | { t: 'ops'; version: number; sid: string; patches: Patch[] }
  | { t: 'fetch'; version: number }
  | { t: 'synced'; version: number }
  | { t: 'stale'; version: number }
  | { t: 'reset'; version: number }
  | { t: 'ack'; seq: number; version: number }
  | { t: 'reject'; seq: number; reason: string }
  | { t: 'peer'; peer: Peer }
  | { t: 'leave'; sid: string }
  | { t: 'presence'; sid: string; cursor: Peer['cursor']; selection: string[] }
  | { t: 'role'; role: Peer['role'] }
  | { t: 'removed' }
  | { t: 'deleted'; reason?: string };

/** ws(s) URL of the cloud (a relative CLOUD_URL is the dev proxy on this page's origin). */
function socketBase(): string {
  if (/^https?:/i.test(CLOUD_URL)) return CLOUD_URL.replace(/^http/i, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${CLOUD_URL}`;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private state: LiveState;
  private serverDoc: ArchaiDocument;
  private pending: Batch[] = [];
  private seq = 0;
  private readonly clientId = Math.random().toString(36).slice(2, 12);
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor: { x: number; y: number } | null = null;

  constructor(
    readonly projectId: string,
    version: number,
    role: Peer['role'],
    private readonly account: AccountService,
    private readonly executor: CommandExecutor,
    private readonly store: AppStore,
    private readonly events: LiveEvents,
  ) {
    this.serverDoc = store.getState().doc;
    this.state = { status: 'connecting', pending: 0, version, role, you: null, peers: [] };
    executor.setReadOnly(role === 'viewer');
    this.stops.push(executor.onDocChange((patches) => this.local(patches)));
    let selection = store.getState().ui.selection;
    this.stops.push(
      store.subscribe((s) => {
        if (s.ui.selection === selection) return;
        selection = s.ui.selection;
        this.schedulePresence();
      }),
    );
    this.connect();
  }

  // ---- state for the UI --------------------------------------------------------------------

  snapshot(): LiveState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<LiveState>): void {
    const before = this.state;
    this.state = { ...this.state, ...patch };
    if (patch.version !== undefined || patch.pending !== undefined) {
      if (before.version !== this.state.version || (before.pending > 0) !== (this.state.pending > 0)) this.events.progress(this.state.version, this.state.pending > 0);
    }
    for (const listener of this.listeners) listener();
  }

  /** The pointer on the board (mm), or null when it left the board. */
  setCursor(cursor: { x: number; y: number } | null): void {
    this.cursor = cursor;
    this.schedulePresence();
  }

  close(): void {
    this.closed = true;
    for (const stop of this.stops) stop();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.ws?.close(1000, 'closed');
    this.ws = null;
    this.executor.setReadOnly(false);
    this.set({ status: 'closed', peers: [] });
  }

  // ---- connection --------------------------------------------------------------------------

  private connect(): void {
    if (this.closed) return;
    const token = this.account.token();
    if (!token) {
      this.set({ status: 'offline' });
      return;
    }
    this.set({ status: 'connecting' });
    const ws = new WebSocket(`${socketBase()}/projects/${this.projectId}/live`, ['archai', `auth.${token}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const batch of this.pending) batch.sent = false;
      this.send({ t: 'hello', since: this.state.version });
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.queue = this.queue.then(() => this.handle(message)).catch((error: unknown) => console.warn('Live board:', error));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || event.code === 4403 || event.code === 4404) return;
      this.set({ status: 'offline', peers: [] });
      const delay = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)]!;
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  // ---- local edits -------------------------------------------------------------------------

  private local(patches: Patch[]): void {
    if (this.store.getState().doc.id !== this.projectId || this.state.role === 'viewer') return;
    this.pending.push({ seq: ++this.seq, patches, sent: false });
    this.set({ pending: this.pending.length });
    if (this.state.status === 'live') this.flush();
  }

  /** One batch at a time: an HTTP model upload must be acknowledged before
   * later socket edits that depend on its new elements can reach the board. */
  private flush(): void {
    const batch = this.pending[0];
    if (!batch || batch.sent) return;
    const message = { t: 'ops', clientId: this.clientId, seq: batch.seq, patches: batch.patches };
    const text = JSON.stringify(message);
    if (text.length > SOCKET_LIMIT) {
      batch.sent = true;
      void this.postLarge(batch);
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(text);
    batch.sent = true;
  }

  private async postLarge(batch: Batch): Promise<void> {
    try {
      const response = await this.account.request(`/projects/${this.projectId}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, seq: batch.seq, sid: this.state.you?.sid ?? '', patches: batch.patches }),
      });
      const { version } = (await response.json()) as { version: number };
      this.queue = this.queue.then(() => this.handle({ t: 'ack', seq: batch.seq, version }));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) this.queue = this.queue.then(() => this.handle({ t: 'reject', seq: batch.seq, reason: error instanceof Error ? error.message : 'Refused' }));
      else batch.sent = false; // offline: sent again on reconnect
    }
  }

  // ---- messages from the board ------------------------------------------------------------

  private async handle(message: ServerMessage): Promise<void> {
    if (this.closed) return;
    switch (message.t) {
      case 'welcome':
        this.set({ you: message.you, peers: message.peers, role: message.you.role });
        return;
      case 'synced':
        if (message.version !== this.state.version) return this.reload();
        this.set({ status: 'live' });
        this.flush();
        this.schedulePresence();
        return;
      case 'ops':
        return this.remote(message.version, message.patches);
      case 'fetch':
        return this.fetchSince();
      case 'stale':
      case 'reset':
        return this.reload();
      case 'ack': {
        if (this.pending[0]?.seq !== message.seq) return; // a batch sent twice
        // Acknowledged over HTTP ahead of earlier batches still on their way: catch up first.
        if (message.version > this.state.version + 1) await this.fetchSince();
        const head = this.pending[0];
        if (head?.seq !== message.seq) return;
        this.pending.shift();
        if (message.version === this.state.version + 1) {
          this.serverDoc = applyPatches(this.serverDoc, head.patches);
          this.set({ version: message.version, pending: this.pending.length });
        } else {
          // Already in the board's copy (reloaded after it was applied): drop the local repeat.
          this.rebase(false);
        }
        this.flush();
        return;
      }
      case 'reject': {
        if (!this.pending.some((batch) => batch.seq === message.seq)) return;
        if (this.events.preserve) {
          this.executor.setReadOnly(true);
          try {
            await this.events.preserve(this.store.getState().doc);
          } catch {
            this.end('Cloud sync was paused because the edit was rejected and a recovery copy could not be saved. Your local model remains open.');
            return;
          }
          this.executor.setReadOnly(this.state.role === 'viewer');
        }
        this.events.notice(`Someone else changed what you were editing, so your last change was undone (${message.reason}).`, 'info');
        this.pending = [];
        this.set({ pending: 0 });
        return this.reload();
      }
      case 'peer':
        this.set({ peers: [...this.state.peers.filter((peer) => peer.sid !== message.peer.sid), message.peer] });
        return;
      case 'leave':
        this.set({ peers: this.state.peers.filter((peer) => peer.sid !== message.sid) });
        return;
      case 'presence':
        this.set({ peers: this.state.peers.map((peer) => (peer.sid === message.sid ? { ...peer, cursor: message.cursor, selection: message.selection } : peer)) });
        return;
      case 'role':
        this.executor.setReadOnly(message.role === 'viewer');
        if (message.role === 'viewer' && this.pending.length > 0) {
          // Edits the board will refuse now: back to its version.
          this.pending = [];
          this.rebase(true);
        }
        this.set({ role: message.role, pending: this.pending.length });
        this.events.role(message.role);
        return;
      case 'removed':
        this.end('You were removed from this project. It stays open here, view only.');
        return;
      case 'deleted':
        this.end('The owner deleted this online project. It stays open here, view only: use Save a copy to keep it.');
        return;
    }
  }

  private end(reason: string): void {
    this.closed = true;
    for (const stop of this.stops) stop();
    this.ws?.close(1000, 'ended');
    this.ws = null;
    this.executor.setReadOnly(true);
    this.set({ status: 'closed', peers: [], role: 'viewer' });
    this.events.ended(reason);
  }

  /** Someone's batch: on the board's copy, then the pending local batches again on top. */
  private remote(version: number, patches: Patch[]): void | Promise<void> {
    if (version <= this.state.version) return;
    if (version !== this.state.version + 1) return this.reload();
    try {
      this.serverDoc = applyPatches(this.serverDoc, patches);
    } catch {
      return this.reload();
    }
    this.set({ version });
    if (this.pending.length === 0) {
      if (!this.executor.applyRemote(patches)) this.executor.replaceDocument(this.serverDoc);
      return;
    }
    this.rebase(false);
  }

  /** The local document = the board's copy plus the pending batches (ones that no longer fit are dropped). */
  private rebase(resetHistory: boolean): void {
    let doc = this.serverDoc;
    const kept: Batch[] = [];
    for (const batch of this.pending) {
      try {
        doc = applyPatches(doc, batch.patches);
        kept.push(batch);
      } catch {
        // depended on something someone else removed
      }
    }
    if (kept.length !== this.pending.length) this.events.notice('Someone else changed what you were editing, so part of your last change was undone.', 'info');
    this.pending = kept;
    this.executor.replaceDocument(doc, resetHistory);
    this.set({ pending: this.pending.length });
  }

  private async fetchSince(): Promise<void> {
    try {
      const response = await this.account.request(`/projects/${this.projectId}/ops?since=${this.state.version}`);
      const body = (await response.json()) as { stale?: boolean; batches?: { version: number; patches: Patch[] }[] };
      if (body.stale || !body.batches) return this.reload();
      for (const batch of body.batches) {
        if (batch.version <= this.state.version) continue;
        // Our own large batch arrives here too when its ack has not: treat it as the ack.
        const head = this.pending[0];
        if (head && head.sent && JSON.stringify(head.patches) === JSON.stringify(batch.patches)) {
          await this.handle({ t: 'ack', seq: head.seq, version: batch.version });
          continue;
        }
        await this.remote(batch.version, batch.patches);
      }
    } catch {
      return this.reload();
    }
  }

  /** The whole document again from the board (behind, replaced, or a refused batch). */
  private async reload(): Promise<void> {
    try {
      const response = await this.account.request(`/projects/${this.projectId}`);
      const parsed = parseDocument(await response.text());
      if (!parsed.ok) throw new Error(parsed.error.message);
      this.serverDoc = parsed.document;
      this.set({ version: Number(response.headers.get('X-Version')) || this.state.version });
      for (const batch of this.pending) batch.sent = false;
      this.rebase(true);
      if (this.state.status === 'live' || this.ws?.readyState === WebSocket.OPEN) {
        this.set({ status: 'live' });
        this.flush();
      }
    } catch (error) {
      console.warn('Live board: could not reload the project', error);
    }
  }

  // ---- presence ----------------------------------------------------------------------------

  private schedulePresence(): void {
    if (this.presenceTimer || this.state.status !== 'live') return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.send({ t: 'presence', cursor: this.cursor, selection: this.store.getState().ui.selection });
    }, PRESENCE_MS);
  }
}
