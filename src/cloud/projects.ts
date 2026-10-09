/**
 * Online projects (docs/accounts-and-cloud.md): projects kept by the archai-cloud Worker, shared
 * with invited people and edited together.
 *
 * On this device an online project is a normal working copy whose session entry carries
 * `cloud: { version, role, pending }`. While it is open, a LiveSession (./live.ts) connects it to
 * the project's board and sends every edit as it happens; `pending` marks edits the board has not
 * acknowledged, which are uploaded as a whole document (with the version they build on) the next
 * time the project is opened, or kept as a separate project when it changed online meanwhile.
 */
import type { CommandExecutor } from '@/commands/executor';
import { randomIds, type ArchaiDocument } from '@/document';
import type { PersistenceService } from '@/persistence/service';
import { parseDocument } from '@/persistence/serialize';
import type { RecentEntry } from '@/persistence/session';
import type { AppStore } from '@/store';
import type { ToastStore } from '@/ui/toast-store';
import { CLOUD_URL, CloudError, type AccountService } from './account';
import { LiveSession, type LiveState, type Peer } from './live';

export type Role = 'owner' | 'editor' | 'viewer';

export interface CloudProject {
  id: string;
  name: string;
  version: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  role: Role;
  owner: string;
  /** People with access, the owner included. */
  members?: number;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  addedAt: string;
}

export interface Invite {
  token: string;
  role: 'editor' | 'viewer';
  createdAt: string;
  expiresAt: string | null;
  uses: number;
}

export interface MemberList {
  role: Role;
  members: Member[];
  /** Owner only. */
  invites: Invite[];
}

export type CloudSyncStatus = 'saved' | 'saving' | 'connecting' | 'offline' | 'error' | 'read-only';

export interface CloudListState {
  projects: CloudProject[];
  loading: boolean;
  error: string | null;
}

type CloudInfo = NonNullable<RecentEntry['cloud']>;

const PROGRESS_SAVE_MS = 2000;

/** The invite token in an invite link (https://…/invite/<token>, archai://invite/<token>) or a bare token. */
export function inviteToken(text: string): string | null {
  const trimmed = text.trim();
  const match = /invite[/=]([a-z0-9]{16,64})/i.exec(trimmed) ?? /^([a-z0-9]{16,64})$/i.exec(trimmed);
  return match ? match[1]!.toLowerCase() : null;
}

export class CloudProjects {
  private listState: CloudListState = { projects: [], loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  private stopStore: (() => void) | null = null;
  private live: LiveSession | null = null;
  private stopLive: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private progress: { id: string; cloud: CloudInfo } | null = null;
  private syncCache: { id: string; status: CloudSyncStatus } | null = null;

  constructor(
    private readonly account: AccountService,
    private readonly persistence: PersistenceService,
    private readonly store: AppStore,
    private readonly executor: CommandExecutor,
    private readonly toasts: ToastStore,
  ) {
    account.subscribe((state) => {
      if (state.status === 'signed-in') void this.refresh();
      else {
        this.closeLive();
        this.setList({ projects: [], loading: false, error: null });
      }
    });
  }

  // ---- state for the UI --------------------------------------------------------------------

  list(): CloudListState {
    return this.listState;
  }

  /** The open document's online state, or null for a local project. Stable between changes. */
  sync(): { id: string; status: CloudSyncStatus } | null {
    const docId = this.store.getState().doc.id;
    const cloud = this.persistence.entry(docId)?.cloud;
    let status: CloudSyncStatus | null = null;
    if (this.live && this.live.projectId === docId) {
      const live = this.live.snapshot();
      status = live.role === 'viewer' ? 'read-only' : live.status === 'live' ? (live.pending > 0 ? 'saving' : 'saved') : live.status === 'connecting' ? 'connecting' : 'offline';
    } else if (cloud) status = cloud.role === 'viewer' ? 'read-only' : 'offline';
    if (!status) return (this.syncCache = null);
    if (this.syncCache?.id !== docId || this.syncCache.status !== status) this.syncCache = { id: docId, status };
    return this.syncCache;
  }

  /** Who else is on the open online project (and you), or null. */
  liveState(): LiveState | null {
    return this.live && this.live.projectId === this.store.getState().doc.id ? this.live.snapshot() : null;
  }

  /** The pointer on the board, for the others' view of you. */
  setCursor(cursor: { x: number; y: number } | null): void {
    this.live?.setCursor(cursor);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setList(next: CloudListState): void {
    this.listState = next;
    this.notify();
  }

  async refresh(): Promise<void> {
    if (this.account.state().status !== 'signed-in') return;
    this.setList({ ...this.listState, loading: true, error: null });
    try {
      const { projects } = await this.account.json<{ projects: CloudProject[] }>('/projects');
      this.setList({ projects, loading: false, error: null });
    } catch (error) {
      this.setList({ ...this.listState, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- projects ----------------------------------------------------------------------------

  /** Uploads a copy of a local project as a new online project and opens it. Returns its id. */
  async putOnline(localId: string): Promise<string> {
    const local = this.store.getState().doc.id === localId ? this.store.getState().doc : await this.persistence.loadStored(localId);
    if (!local) throw new Error('Could not read this project');
    const { id } = await this.account.json<{ id: string }>('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: local.meta.name }),
    });
    const online: ArchaiDocument = { ...local, id };
    const { version } = await this.upload(online, 0);
    await this.persistence.storeDocument(online, { cloud: { version, role: 'owner' } });
    void this.refresh();
    await this.open(id);
    return id;
  }

  /** Opens an online project (the board's latest version, or this device's copy offline) and joins its board. */
  async open(id: string): Promise<boolean> {
    const entry = this.persistence.entry(id);
    if (entry?.cloud?.pending) await this.pushPending(id, entry.cloud);
    try {
      const { document, cloud } = await this.download(id);
      await this.persistence.storeDocument(document, { cloud });
    } catch (error) {
      const offline = error instanceof CloudError && error.status === 0;
      if (!(offline && entry)) {
        this.toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        return false;
      }
      this.toasts.push({ kind: 'info', message: 'Offline: opened the copy on this device. Your edits are sent when the connection is back.' });
    }
    this.closeLive();
    const opened = await this.persistence.openStored(id);
    const cloud = this.persistence.entry(id)?.cloud;
    if (opened && cloud && this.account.state().status === 'signed-in') this.startLive(id, cloud);
    this.notify();
    return opened;
  }

  /** Saves an online project as a new local project on this device; returns its id. */
  async saveCopyOnDevice(id: string): Promise<string> {
    const document = this.store.getState().doc.id === id ? this.store.getState().doc : (await this.download(id)).document;
    const copy: ArchaiDocument = { ...document, id: randomIds.next('doc'), meta: { ...document.meta, name: `${document.meta.name} (copy)` } };
    await this.persistence.storeDocument(copy);
    return copy.id;
  }

  async remove(id: string): Promise<void> {
    await this.account.request(`/projects/${id}`, { method: 'DELETE' });
    if (this.live?.projectId === id) this.closeLive();
    await this.persistence.forget(id);
    void this.refresh();
  }

  // ---- people ------------------------------------------------------------------------------

  members(id: string): Promise<MemberList> {
    return this.account.json<MemberList>(`/projects/${id}/members`);
  }

  /** Adds someone who has an account (owner). */
  addMember(id: string, email: string, role: 'editor' | 'viewer'): Promise<MemberList> {
    return this.account.json<MemberList>(`/projects/${id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role }) });
  }

  setRole(id: string, userId: string, role: 'editor' | 'viewer'): Promise<MemberList> {
    return this.account.json<MemberList>(`/projects/${id}/members/${userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  }

  removeMember(id: string, userId: string): Promise<MemberList> {
    return this.account.json<MemberList>(`/projects/${id}/members/${userId}`, { method: 'DELETE' });
  }

  /** Leaves a project someone shared with you. */
  async leave(id: string): Promise<void> {
    const me = this.account.state();
    if (me.status !== 'signed-in') return;
    await this.account.request(`/projects/${id}/members/${me.user.id}`, { method: 'DELETE' });
    if (this.live?.projectId === id) this.closeLive();
    await this.persistence.forget(id);
    void this.refresh();
  }

  createInvite(id: string, role: 'editor' | 'viewer', days: number | null): Promise<{ token: string; link: string; role: string; expiresAt: string | null }> {
    return this.account.json(`/projects/${id}/invites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, ...(days ? { days } : {}) }) });
  }

  deleteInvite(id: string, token: string): Promise<MemberList> {
    return this.account.json<MemberList>(`/projects/${id}/invites/${token}`, { method: 'DELETE' });
  }

  /** What an invite link is for (no sign-in needed). */
  async inviteInfo(token: string): Promise<{ project: string; owner: string; role: Role; expired: boolean }> {
    const response = await fetch(`${CLOUD_URL}/invites/${token}`).catch(() => null);
    if (!response) throw new CloudError(0, 'Could not reach ArchAI online: check the internet connection');
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new CloudError(response.status, typeof body['error'] === 'string' ? body['error'] : 'This invite link is not valid');
    return body as { project: string; owner: string; role: Role; expired: boolean };
  }

  /** Joins the project of an invite link and opens it. */
  async acceptInvite(token: string): Promise<string> {
    const { projectId, project, role } = await this.account.json<{ projectId: string; project: string; role: Role }>(`/invites/${token}/accept`, { method: 'POST' });
    void this.refresh();
    this.toasts.push({ kind: 'success', message: `You joined “${project}” as ${role === 'viewer' ? 'a viewer' : role === 'owner' ? 'the owner' : 'an editor'}` });
    await this.open(projectId);
    return projectId;
  }

  // ---- the open project --------------------------------------------------------------------

  /** Follows document switches: leaving an online project closes its board connection. */
  start(): void {
    this.stopStore?.();
    let previous = this.store.getState().doc.id;
    this.stopStore = this.store.subscribe((state) => {
      if (state.doc.id === previous) return;
      previous = state.doc.id;
      if (this.live && this.live.projectId !== state.doc.id) this.closeLive();
      this.notify();
    });
  }

  stop(): void {
    this.stopStore?.();
    this.stopStore = null;
    this.closeLive();
  }

  private startLive(id: string, cloud: CloudInfo): void {
    const live = new LiveSession(id, cloud.version, cloud.role, this.account, this.executor, this.store, {
      notice: (message, kind) => this.toasts.push({ kind, message }),
      progress: (version, pending) => this.saveProgress(id, { version, role: live.snapshot().role, pending }),
      role: (role) => {
        this.saveProgress(id, { version: live.snapshot().version, role, pending: false });
        this.toasts.push({ kind: 'info', message: role === 'viewer' ? 'You can now only view this project' : 'You can now edit this project' });
      },
      ended: (reason) => {
        this.toasts.push({ kind: 'info', message: reason });
        void this.refresh();
      },
    });
    this.live = live;
    this.stopLive = live.subscribe(() => this.notify());
  }

  private closeLive(): void {
    this.stopLive?.();
    this.stopLive = null;
    this.live?.close();
    this.live = null;
    this.writeProgress();
  }

  /** The board version and pending flag of an online project, written to the session a moment later. */
  private saveProgress(id: string, cloud: CloudInfo): void {
    this.progress = { id, cloud: { version: cloud.version, role: cloud.role, ...(cloud.pending ? { pending: true } : {}) } };
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => this.writeProgress(), PROGRESS_SAVE_MS);
  }

  private writeProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const progress = this.progress;
    this.progress = null;
    if (progress) void this.persistence.setCloud(progress.id, progress.cloud);
  }

  /** Edits kept on this device while offline: uploaded before opening; a conflict keeps them as a copy. */
  private async pushPending(id: string, cloud: CloudInfo): Promise<void> {
    const cached = await this.persistence.loadStored(id);
    if (!cached) return;
    try {
      const { version } = await this.upload(cached, cloud.version);
      await this.persistence.setCloud(id, { version, role: cloud.role });
    } catch (error) {
      if (error instanceof CloudError && (error.status === 409 || error.status === 403)) {
        const copy: ArchaiDocument = { ...cached, id: randomIds.next('doc'), meta: { ...cached.meta, name: `${cached.meta.name} (offline changes)` } };
        await this.persistence.storeDocument(copy);
        await this.persistence.setCloud(id, { version: cloud.version, role: cloud.role });
        this.toasts.push({ kind: 'info', message: `The project changed online while you were offline: your changes were kept as "${copy.meta.name}".` });
      }
      // offline: keep them pending
    }
  }

  private async upload(doc: ArchaiDocument, baseVersion: number): Promise<{ version: number }> {
    return this.account.json<{ version: number }>(`/projects/${doc.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Base-Version': String(baseVersion) },
      body: JSON.stringify(doc),
    });
  }

  private async download(id: string): Promise<{ document: ArchaiDocument; cloud: CloudInfo }> {
    const response = await this.account.request(`/projects/${id}`);
    const parsed = parseDocument(await response.text());
    if (!parsed.ok) throw new Error(`This online project could not be read: ${parsed.error.message}`);
    const role = response.headers.get('X-Role');
    return {
      document: parsed.document,
      cloud: { version: Number(response.headers.get('X-Version')) || 0, role: role === 'editor' || role === 'viewer' ? role : 'owner' },
    };
  }
}

export type { Peer };
