/**
 * The board's side of the live link with the modelling-app plugins (electron/liveLink.ts): it
 * answers the plugins' requests against the open project and keeps the list of connected apps
 * for the top bar.
 *
 * - `status`: the project, its revision (bumped on every document change) and the revision the
 *   asking plugin's own last sync produced, so a plugin pulls only changes made by others.
 * - `push`: runs `sync-live-link` (one undo step).
 * - `pull`: the project's 3D model as binary glTF (the .AIR snapshot format, metres, one node per
 *   element), without what the asking plugin sent.
 *
 * A plugin that finds ArchAI on its Home screen gets a project opened for it: the one linked to
 * that model last time (`live:project:<key>` in platform storage), else a new one named after it.
 */
import { useSyncExternalStore } from 'react';
import type { AssetCatalog } from '@/catalog';
import type { CommandExecutor } from '@/commands';
import type { Platform } from '@/platform/types';
import type { AppStore } from '@/store';
import type { ToastStore } from '@/ui/toast-store';
import type { PersistenceService } from '@/persistence/service';
import { withoutLink } from './sync';
import { account } from '@/cloud/account';
import { openAccountDialog } from '@/ui/account-dialog';

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
  const current = connections.get(key) ?? { key, app: '', name: '', lastSeen: 0, lastSync: null, objects: 0, ownRevision: null };
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
  return file.replace(/\.[^.]+$/, '').trim().slice(0, 120) || 'Live model';
}

/** Board window, once at boot (desktop app only). */

export function startLiveLink(platform: Platform, store: AppStore, executor: CommandExecutor, catalog: AssetCatalog, toasts: ToastStore, persistence: Pick<PersistenceService, 'openStored'> | null = null): void {
  if (!platform.live) return;
  let opening: Promise<void> | null = null;
  /** On the Home screen: opens the project linked to this model before, else a new one for it. */
  const ensureProject = (key: string, name: string, app: string): Promise<void> => {
    if (!key || store.getState().ui.screen !== 'home') return Promise.resolve();
    opening ??= (async () => {
      const remembered = await platform.storage.get(`live:project:${key}`).catch(() => null);
      if (remembered && persistence && (await persistence.openStored(remembered))) {
        toasts.push({ kind: 'info', message: `Live link: opened ${store.getState().doc.meta.name} for ${app || 'the plugin'}` });
        return;
      }
      const created = executor.dispatchSync('new-document', { name: name || nameFromKey(key) });
      if (!created.ok) throw new Error(created.error.message);
      await platform.storage.set(`live:project:${key}`, created.value as string);
      toasts.push({ kind: 'info', message: `Live link: new project "${name || nameFromKey(key)}" for ${app || 'the plugin'}` });
    })().finally(() => {
      opening = null;
    });
    return opening;
  };
  let revision = 1;
  let docId = store.getState().doc.id;
  let lastDoc = store.getState().doc;
  store.subscribe((state) => {
    if (state.doc === lastDoc) return;
    lastDoc = state.doc;
    revision += 1;
    if (state.doc.id !== docId) {
      // Another project: every link starts over.
      docId = state.doc.id;
      connections = new Map([...connections].map(([key, c]) => [key, { ...c, ownRevision: null }]));
      changed();
    }
  });
  // Links that went quiet drop out of the top bar.
  setInterval(() => {
    if (snapshot.some((c) => !isLive(c))) changed();
  }, 5000);

  platform.live.serve(async (kind, payload) => {
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
    const key = str(payload['key'], 300);
    if (kind !== 'stop') await ensureProject(key, str(payload['name']), str(payload['app'], 60) || connections.get(key)?.app || '');
    const state = store.getState();
    const hasProject = state.ui.screen !== 'home';
    if (kind === 'status') {
      if (key) touch(key, {});
      return {
        document: hasProject ? { id: state.doc.id, name: state.doc.meta.name || 'Untitled' } : null,
        revision,
        own: connections.get(key)?.ownRevision ?? null,
      };
    }
    if (kind === 'stop') {
      connections = new Map(connections);
      connections.delete(key);
      changed();
      return { ok: true };
    }
    if (!hasProject) throw new Error('Open a project in ArchAI first');
    if (kind === 'push') {
      const app = str(payload['app'], 60) || 'App';
      const name = str(payload['name']);
      const first = !connections.get(key)?.lastSync;
      const result = await executor.dispatch('sync-live-link', { key, app, model: payload['model'] });
      // The project this model syncs with, to reopen next time.
      void platform.storage.set(`live:project:${key}`, state.doc.id).catch(() => undefined);
      if (!result.ok) throw new Error(result.error.message);
      const report = result.value as { created: Record<string, number>; skipped: unknown[] };
      const objects = Object.entries(report.created).filter(([kind]) => kind !== 'material' && kind !== 'level').reduce((sum, [, n]) => sum + n, 0);
      touch(key, { app, name, lastSync: Date.now(), objects, ownRevision: revision });
      if (first) toasts.push({ kind: 'success', message: `Live link: ${app}${name ? ` (${name})` : ''} is connected, ${objects} objects` });
      return { revision, created: report.created, skipped: report.skipped.length };
    }
    if (kind === 'pull') {
      const { exportSceneSnapshot } = await import('@/view3d/vrExport');
      const doc = withoutLink(state.doc, key);
      const glb = new Uint8Array(await exportSceneSnapshot(doc, catalog));
      touch(key, {});
      return { glb, revision, name: state.doc.meta.name || 'ArchAI' };
    }
    throw new Error(`Unknown live-link request ${String(kind)}`);
  });
}
