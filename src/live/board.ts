/**
 * The board's side of the Live Bridge with the modelling-app plugins (electron/liveLink.ts): it
 * answers the plugins' requests against the open project and keeps the list of connected apps
 * for the top bar.
 *
 * - `status`: the project, its revision (bumped on every document change) and the revision the
 *   asking plugin's own last sync produced, so a plugin pulls only changes made by others.
 * - `push`: protocol 1 (plugins 0.4.x) and protocol 2 (Live Bridge, docs/live-bridge.md)
 *   both run `bridge-sync` (one undo step); protocol 2 adds its change id, whether the model is a
 *   complete snapshot, and explicit deletions.
 * - `pull`: the project's 3D model as binary glTF (the .AIR snapshot format, metres, one node per
 *   element), without what the asking plugin sent and without elements not shared with it.
 * - `projects` / `bind` (protocol 2): the projects a plugin can link to, and linking to one.
 *
 * Plugins use an explicitly chosen, remembered destination. Stored destinations sync in an
 * isolated command store while another project is displayed. Missing links require the picker.
 * A batch naming the previous destination is refused after relinking.
 */
import { useSyncExternalStore } from 'react';
import type { LiveRequestKind } from '@shared/ipc';
import type { AssetCatalog } from '@/catalog';
import { CommandExecutor } from '@/commands';
import { createAppStore } from '@/store';
import type { ArchaiDocument } from '@/document';
import type { Platform } from '@/platform/types';
import type { AppStore } from '@/store';
import type { ToastStore } from '@/ui/toast-store';
import type { PersistenceService } from '@/persistence/service';
import { withoutLink } from './sync';
import { account } from '@/cloud/account';
import { openAccountDialog } from '@/ui/account-dialog';
import { startProgress } from '@/progress';
import type { BridgeSyncReport } from '@/bridge/engine';
import { flattenSourceGroups, pullPlan } from '@/bridge/pull';
import { chooseProject } from '@/bridge/ProjectPicker';

/** The Live Bridge protocol this ArchAI speaks (plugins 0.4.x speak 1). */
export const BRIDGE_PROTOCOL = 2;

export interface LiveConnection {
  key: string;
  app: string;
  /** The plugin's model name (its file). */
  name: string;
  lastSeen: number;
  lastSync: number | null;
  objects: number;
  /** Revision of the document right after this link's last sync. */
  ownRevision: number | null;
  /** Live Bridge protocol the plugin speaks (1: Live Bridge). */
  protocol: number;
  /** A sync from this app is being applied now. */
  syncing: boolean;
  /** The last sync's error, or null. */
  error: string | null;
}

/** A link that has not been heard from for this long counts as gone. */
export const LIVE_TIMEOUT_MS = 15_000;

let connections = new Map<string, LiveConnection>();
const listeners = new Set<() => void>();
let snapshot: LiveConnection[] = [];

function changed(): void {
  snapshot = [...connections.values()].sort((a, b) => a.app.localeCompare(b.app));
  for (const listener of listeners) listener();
}

function touch(key: string, patch: Partial<LiveConnection>): LiveConnection {
  const current = connections.get(key) ?? { key, app: '', name: '', lastSeen: 0, lastSync: null, objects: 0, ownRevision: null, protocol: 1, syncing: false, error: null };
  const next = { ...current, ...patch, lastSeen: Date.now() };
  connections = new Map(connections).set(key, next);
  changed();
  return next;
}

export const liveConnections = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): LiveConnection[] => snapshot,
};

/** Links disconnected in ArchAI: their pushes are refused until the app turns its link off. */
const disconnected = new Set<string>();
let controls: { resync(key: string): void; disconnect(key: string): void } | null = null;

/** The Live Bridge panel's controls (desktop app with the live server running). */
export const liveBridgeControls = {
  available: () => controls !== null,
  /** Sends that app everything again on its next pull. */
  resync: (key: string) => controls?.resync(key),
  /** Unlinks that app: its elements stay as ArchAI elements; it can link again after turning its link off and on. */
  disconnect: (key: string) => controls?.disconnect(key),
};

export function useLiveConnections(): LiveConnection[] {
  return useSyncExternalStore(liveConnections.subscribe, liveConnections.get, liveConnections.get);
}

/** Whether a link is still talking to ArchAI. */
export const isLive = (connection: LiveConnection, now = Date.now()) => now - connection.lastSeen < LIVE_TIMEOUT_MS;

const str = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The model's name from a link key (`rhino:C:\…\House.3dm` -> `House`). */
export function nameFromKey(key: string): string {
  const path = key.replace(/^[a-z0-9]+[:|]/i, '').replace(/^unsaved:/, '');
  const file = path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return (
    file.replace(/\.[^.]+$/, '').trim().slice(0, 120) || 'Live model'
  );
}

/** Board window, once at boot (desktop app only). */

export function startLiveLink(platform: Platform, store: AppStore, executor: CommandExecutor, catalog: AssetCatalog, toasts: ToastStore, persistence: Pick<PersistenceService, 'openStored' | 'recent' | 'loadStored' | 'storeDocument' | 'entry'> | null = null, background?: { load(id: string): Promise<ArchaiDocument | null>; save(doc: ArchaiDocument): Promise<void>; open(id: string): Promise<boolean> }): void {
  if (!platform.live) return;
  const boardStore = store;
  const boardExecutor = executor;
  // Serialize syncs, including background writes, so two plugins cannot overwrite a project.
  let queue: Promise<unknown> = Promise.resolve();
  // Time-based, so a plugin reconnecting after ArchAI restarted never sees an old revision again.
  let revision = Date.now();
  /** Protocol 2: what each app received in this session (element → hash), so pulls carry changes only. */
  const sentTo = new Map<string, Map<string, string>>();
  const syncRequests = new Map<string, number>();
  const projectVersions = new Map<string, string>();
  let docId = store.getState().doc.id;
  let lastDoc = store.getState().doc;
  store.subscribe((state) => {
    if (state.doc === lastDoc) return;
    lastDoc = state.doc;
    revision += 1;
    if (state.doc.id !== docId) {
      // Another project: every link starts over.
      docId = state.doc.id;
      sentTo.clear();
      syncRequests.clear();
      connections = new Map([...connections].map(([key, c]) => [key, { ...c, ownRevision: null }]));
      changed();
    }
  });
  controls = {
    resync: (key) => {
      sentTo.delete(key);
      syncRequests.set(key, (syncRequests.get(key) ?? 0) + 1);
      // A new revision without a document change: every app looks, this one gets everything.
      revision += 1;
    },
    disconnect: (key) => {
      disconnected.add(key);
      sentTo.delete(key);
      void executor.dispatch('bridge-forget-source', { key });
      connections = new Map(connections);
      connections.delete(key);
      changed();
    },
  };
  // Links that went quiet drop out of the top bar.
  setInterval(() => {
    if (snapshot.some((c) => !isLive(c))) changed();
  }, 5000);

  platform.live.serve((kind, payload) => {
    if (kind === 'bind' || kind === 'projects' || kind === 'account' || kind === 'stop') return handle(kind, payload);
    const request = queue.then(() => handle(kind, payload));
    queue = request.catch(() => undefined);
    return request;
  });
  async function handle(kind: LiveRequestKind, payload: Record<string, unknown>): Promise<unknown> {
    let store = boardStore;
    let executor = boardExecutor;
    // The plugins' cloud features (Open in VR) use the account signed in here; `prompt` asks
    // the user to sign in when nobody is.
    if (kind === 'account') {
      await account().restore();
      const state = account().state();
      const token = account().token();
      if (state.status === 'signed-in' && token) return { signedIn: true, token, user: { name: state.user.name, email: state.user.email } };
      if (payload['prompt'] === true) openAccountDialog('sign-in', `Sign in to ArchAI to use ${str(payload['app'], 60) || 'the plugin'}'s cloud features (Open in VR).`);
      return { signedIn: false };
    }
    if (kind === 'projects') {
      const state = store.getState();
      const open = state.ui.screen !== 'home' ? state.doc.id : null;
      const projects = (persistence?.recent() ?? []).slice(0, 50).map((entry) => ({ id: entry.id, name: entry.name || 'Untitled', updatedAt: entry.updatedAt, online: Boolean(entry.cloud), open: entry.id === open }));
      return { protocol: BRIDGE_PROTOCOL, open, projects };
    }
    const key = str(payload['key'], 300);
    const project = str(payload['project'], 64);
    if (kind === 'stop') {
      disconnected.delete(key);
      connections = new Map(connections);
      connections.delete(key);
      changed();
      return { ok: true };
    }
    if (kind === 'bind') {
      const app = str(payload['app'], 60);
      const name = str(payload['name']);
      if (payload['choose'] === true) {
        // The plugin's Link to project button: the user picks here.
        const choice = await chooseProject(app || 'The app', name);
        if (!choice) return { protocol: BRIDGE_PROTOCOL, cancelled: true };
        return 'project' in choice ? bindQueued(key, app, name, choice.project, '') : bindQueued(key, app, name, '', choice.newName);
      }
      return bindQueued(key, app, name, project, str(payload['newName']));
    }
    const remembered = key ? await platform.storage.get(`live:project:${key}`) : null;
    const target = remembered || project;
    if (target && (target !== store.getState().doc.id || store.getState().ui.screen === 'home') && persistence) {
      const doc = await (background ? background.load(target) : persistence.loadStored(target));
      if (doc) {
        const stamp = `${doc.meta.updatedAt}:${persistence.entry(target)?.cloud?.version ?? ''}`;
        if (projectVersions.get(target) !== stamp) { projectVersions.set(target, stamp); revision += 1; }
        store = createAppStore({ doc, ui: { screen: 'project' } });
        executor = new CommandExecutor(boardExecutor.registry, store, boardExecutor.services);
        executor.setReadOnly(persistence.entry(target)?.cloud?.role === 'viewer');
      }
    }
    const state = store.getState();
    const hasProject = Boolean(target && state.doc.id === target && (store !== boardStore || state.ui.screen !== 'home'));
    /** A protocol-2 plugin bound to another project than the open one. */
    const mismatch = Boolean(project && project !== state.doc.id);
    const current = hasProject ? { id: state.doc.id, name: state.doc.meta.name || 'Untitled' } : null;
    if (kind === 'status') {
      if (key) touch(key, { protocol: Number(payload['protocol']) || connections.get(key)?.protocol || 1 });
      return {
        protocol: BRIDGE_PROTOCOL,
        document: current,
        needsLink: !hasProject,
        ...(hasProject && project !== state.doc.id ? { known: sourceIds(state.doc, key) } : {}),
        bound: Boolean(key && state.doc.bridge?.sources[key]),
        ...(!hasProject && project ? { mismatch: { bound: project, open: state.doc.id } } : {}),
        revision,
        own: connections.get(key)?.ownRevision ?? null,
        mode: disconnected.has(key)
          ? 'disconnected'
          : (state.doc.bridge?.sources[key]?.mode ?? 'two-way'),
        receives: state.doc.bridge?.sources[key]?.receives ?? 'shared',
        syncRequest: syncRequests.get(key) ?? 0,
      };
    }
    if (!hasProject) throw new Error(project ? 'This model is linked to another project that is unavailable. Use Link to project.' : 'Link this model to an ArchAI project first');
    if (kind === 'pull' && (mismatch || disconnected.has(key))) {
      throw new Error(
        mismatch
          ? 'This model is linked to another project. Open its project or use Link to project.'
          : 'Disconnected in ArchAI. Turn the bridge off and on to reconnect.',
      );
    }
    if (kind === 'push') {
      const app = str(payload['app'], 60) || 'App';
      const name = str(payload['name']);
      const protocol = Number(payload['protocol']) || 1;
      if (mismatch) {
        return { protocol: BRIDGE_PROTOCOL, refused: 'project-mismatch', document: current, message: `ArchAI has another project open (${current?.name}). Open the linked project in ArchAI, or link this model to the open one.` };
      }
      if (disconnected.has(key)) {
        return { protocol: BRIDGE_PROTOCOL, refused: 'disconnected', document: current, message: 'Disconnected in ArchAI. Turn the Live Bridge off and on again to link this model anew.' };
      }
      const link = state.doc.bridge?.sources[key];
      if (link && link.mode !== 'two-way') {
        return { protocol: BRIDGE_PROTOCOL, refused: link.mode, document: current, message: link.mode === 'paused' ? 'This link is paused in ArchAI' : 'This link only receives from ArchAI' };
      }
      const first = !connections.get(key)?.lastSync;
      // Shown when the sync takes a moment (a first sync or a big model); quick ones never appear.
      const model = payload['model'] as Record<string, unknown> | undefined;
      const count = model
        ? ['levels', 'walls', 'openings', 'slabs', 'columns', 'railings', 'rooms', 'meshes'].reduce(
            (n, name) => n + (Array.isArray(model[name]) ? (model[name] as unknown[]).length : 0),
            0,
          )
        : 0;
      const task = startProgress(`Live Bridge: ${app}`, count ? `Updating ${count} elements from ${app}` : `Updating the model from ${app}`, null);
      await task.paint();
      if (store.getState().doc.id !== state.doc.id || (remembered && await platform.storage.get(`live:project:${key}`) !== target)) {
        task.failed();
        return {
          protocol: BRIDGE_PROTOCOL,
          refused: 'project-mismatch',
          message:
            'The project changed while this sync was starting. Sync again with the linked project open.',
        };
      }
      const changeId = typeof payload['changeId'] === 'string' ? payload['changeId'].slice(0, 100) : null;
      const deleted = Array.isArray(payload['deleted']) ? payload['deleted'].filter((id): id is string => typeof id === 'string') : [];
      touch(key, { app, name, syncing: true });
      // The revision before this app's own change: a plugin counts itself up to date only when
      // nothing else changed meanwhile (a change made right then must still be pulled).
      const before = revision;
      const result = await executor.dispatch('bridge-sync', { key, app, name, model: payload['model'], complete: payload['complete'] !== false, deleted, changeId });
      if (result.ok && store !== boardStore && persistence) {
        try {
          const doc = store.getState().doc;
          if (boardStore.getState().doc.id === doc.id && boardStore.getState().ui.screen !== 'home') throw new Error('The linked project was opened during sync. Sync again.');
          if (background) await background.save(doc);
          else await persistence.storeDocument(doc, { cloud: persistence.entry(doc.id)?.cloud });
          revision += 1;
        } catch (error) {
          task.failed();
          touch(key, { syncing: false, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
      if (result.ok) task.done();
      else task.failed();
      touch(key, { syncing: false, error: result.ok ? null : result.error.message });
      // The project this model syncs with, to reopen next time.
      void platform.storage.set(`live:project:${key}`, state.doc.id).catch(() => undefined);
      if (!result.ok) throw new Error(result.error.message);
      const report = result.value as BridgeSyncReport;
      const doc = store.getState().doc;
      const objects = Object.values(doc.bridge?.elements ?? {}).filter((binding) => binding.refs[key] && !binding.removed).length;
      touch(key, { app, name, lastSync: Date.now(), objects, ownRevision: revision, protocol });
      if (first) toasts.push({ kind: 'success', message: `Live Bridge: ${app}${name ? ` (${name})` : ''} is connected, ${objects} objects` });
      if (report.held) toasts.push({ kind: 'info', message: `Live Bridge: ${report.held} deletions from ${app} wait for your confirmation` });
      const { built, skipped, ...applied } = report;
      return { protocol: BRIDGE_PROTOCOL, ack: changeId, revision, before, document: { id: doc.id, name: doc.meta.name || 'Untitled' }, applied, created: built ?? {}, skipped: skipped?.length ?? 0 };
    }
    if (kind === 'pull') {
      const app = str(payload['app'], 60) || connections.get(key)?.app || 'the plugin';
      const task = startProgress(`Live Bridge: ${app}`, `Sending ArchAI's model to ${app}`, null);
      await task.paint();
      const { exportSceneSnapshot } = await import('@/view3d/vrExport');
      let glb: Uint8Array;
      const pullDoc = store.getState().doc;
      const pullRevision = revision;
      try {
        if (pullDoc.id !== state.doc.id)
          throw new Error(
            'The project changed while the pull was starting. Open the linked project and sync again.',
          );
        if ((Number(payload['protocol']) || 1) >= 2) {
          // Live Bridge: only what changed since this app's last pull, plus updates for its own objects.
          const fresh = payload['fresh'] === true || payload['fresh'] === '1';
          // Elements the app reset (someone edited ArchAI's version there): sent again.
          const resend = typeof payload['resend'] === 'string' ? payload['resend'].split(',').filter(Boolean).slice(0, 500) : [];
          for (const id of resend) sentTo.get(key)?.delete(id);
          const plan = pullPlan(pullDoc, key, fresh ? null : (sentTo.get(key) ?? null));
          const document = { id: pullDoc.id, name: pullDoc.meta.name || 'Untitled' };
          glb = new Uint8Array(
            await exportSceneSnapshot(flattenSourceGroups(pullDoc), catalog, {
              include: (id) => plan.nodes.has(id),
              extras: (id) => plan.nodes.get(id),
              root: { archaiBridge: { protocol: BRIDGE_PROTOCOL, document, revision: pullRevision, present: plan.present, updates: plan.updates } },
            }),
          );
          if (store.getState().doc.id !== pullDoc.id)
            throw new Error(
              'The project changed during export. Open the linked project and sync again.',
          );
          sentTo.set(key, plan.sent);
        } else glb = new Uint8Array(await exportSceneSnapshot(withoutLink(flattenSourceGroups(pullDoc), key), catalog),
          );
        if (store.getState().doc.id !== pullDoc.id)
          throw new Error(
            'The project changed during export. Open the linked project and sync again.',
          );
        task.done();
      } catch (error) {
        task.failed();
        throw error;
      }
      touch(key, {});
      return { glb, revision: pullRevision, name: pullDoc.meta.name || 'ArchAI' };
    }
    throw new Error(`Unknown live-link request ${String(kind)}`);
  }

  function bindQueued(key: string, app: string, name: string, project: string, newName: string): Promise<unknown> {
    const request = queue.then(() => bind(key, app, name, project, newName));
    queue = request.catch(() => undefined);
    return request;
  }

  /**
   * Links a model to a project (protocol 2): an existing one (opened if another is showing) or a
   * new one; remembered for the plugin's next connection.
   */
  async function bind(key: string, app: string, name: string, project: string, newName: string): Promise<unknown> {
    if (!key) throw new Error('key is required');
    let state = store.getState();
    if (project && !(state.ui.screen !== 'home' && state.doc.id === project)) {
      if (!persistence || !(await (background ? background.open(project) : persistence.openStored(project)))) throw new Error('That project is unavailable. Choose another project.');
    } else if (!project) {
      const created = executor.dispatchSync('new-document', { name: newName || name || nameFromKey(key) });
      if (!created.ok) throw new Error(created.error.message);
    }
    state = store.getState();
    if (persistence) await persistence.storeDocument(state.doc, { cloud: persistence.entry(state.doc.id)?.cloud });
    sentTo.delete(key);
    syncRequests.set(key, (syncRequests.get(key) ?? 0) + 1);
    disconnected.delete(key);
    await platform.storage.set(`live:project:${key}`, state.doc.id).catch(() => undefined);
    touch(key, { app, name, protocol: BRIDGE_PROTOCOL, ownRevision: null });
    toasts.push({ kind: 'info', message: `Live Bridge: ${app || 'the plugin'}${name ? ` (${name})` : ''} is linked to ${state.doc.meta.name || 'this project'}` });
    return { protocol: BRIDGE_PROTOCOL, document: { id: state.doc.id, name: state.doc.meta.name || 'Untitled' }, known: sourceIds(state.doc, key), revision };
  }
}

function sourceIds(doc: ArchaiDocument, key: string): string[] {
  return [...new Set(Object.values(doc.bridge?.elements ?? {}).flatMap((binding) => binding.refs[key] ? [binding.refs[key].id] : []))];
}
