import { expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { PersistenceService } from '@/persistence/service';
import { createToastStore } from '@/ui/toast-store';
import { CloudProjects } from './projects';
import { CloudError, type AccountService } from './account';

vi.mock('./live', () => ({ LiveSession: class { subscribe() { return () => {}; } close() {} } }));

function setup() {
  const app = createTestApp();
  run(app, 'new-document', { name: 'Linked project' });
  run(app, 'bridge-sync', { key: 'revit:test', model: { archaiRevit: 1, meshes: [{ id: 'a', origin: [0,0,0], size: [500,500,500], glb: 'AAAA' }] } });
  const persistence = new PersistenceService(app.store, app.executor, app.platform);
  const json = vi.fn(async (_path: string, _init?: RequestInit): Promise<Record<string, unknown>> => ({}));
  const request = vi.fn(async () => new Response(JSON.stringify(app.store.getState().doc), { headers: { 'X-Version': '1', 'X-Role': 'owner' } }));
  const account = { json, request, subscribe: () => () => {}, token: () => null, state: () => ({ status: 'signed-in' }) } as unknown as AccountService;
  const cloud = new CloudProjects(account, persistence, app.store, app.executor, createToastStore());
  return { app, persistence, cloud, json, request };
}

it('moves a project online using the same identity, bindings and per-project storage', async () => {
  const { app, persistence, cloud, json } = setup();
  const original = app.store.getState().doc;
  await persistence.storeDocument(original);
  await app.platform.storage.set('live:project:revit:test', original.id);
  await app.platform.storage.set(`vr-bake:${original.id}`, 'saved bake');
  json.mockImplementation(async (path, init) => {
    if (path === '/projects' && init?.method === 'POST') {
      expect(JSON.parse(init.body as string)).toMatchObject({ id: original.id });
      return { id: original.id, version: 0 };
    }
    if (init?.method === 'PUT') { expect(JSON.parse(init.body as string)).toEqual(original); return { version: 1 }; }
    return { projects: [] };
  });
  expect(await cloud.putOnline(original.id)).toBe(original.id);
  expect(persistence.recent()).toHaveLength(1);
  expect(persistence.entry(original.id)?.cloud).toEqual({ version: 1, role: 'owner' });
  expect(app.store.getState().doc.bridge).toEqual(original.bridge);
  expect(await app.platform.storage.get('live:project:revit:test')).toBe(original.id);
  expect(await app.platform.storage.get(`vr-bake:${original.id}`)).toBe('saved bake');
  cloud.stop();
});

it('leaves the local project and links intact when conversion upload fails', async () => {
  const { app, persistence, cloud, json } = setup();
  const original = app.store.getState().doc;
  await persistence.storeDocument(original);
  json.mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') return { id: original.id, version: 0 };
    throw new CloudError(0, 'Offline');
  });
  await expect(cloud.putOnline(original.id)).rejects.toThrow('Offline');
  expect(persistence.recent()).toHaveLength(1);
  expect(persistence.entry(original.id)?.cloud).toBeUndefined();
  expect(await persistence.loadStored(original.id)).toEqual(original);
});

it('keeps background online changes pending offline and refuses viewer writes', async () => {
  const { app, persistence, cloud, json } = setup();
  const original = app.store.getState().doc;
  await persistence.storeDocument(original, { cloud: { version: 3, role: 'editor' } });
  json.mockRejectedValue(new CloudError(0, 'Offline'));
  await cloud.saveForBridge(original);
  expect(persistence.entry(original.id)?.cloud).toEqual({ version: 3, role: 'editor', pending: true });
  await persistence.setCloud(original.id, { version: 3, role: 'viewer' });
  await expect(cloud.saveForBridge(original)).rejects.toThrow('view only');
});

it('checks online versions cheaply, downloads changes, and stops using inaccessible projects', async () => {
  const { app, persistence, cloud, json, request } = setup();
  const document = app.store.getState().doc;
  await persistence.storeDocument(document, { cloud: { version: 1, role: 'owner' } });
  json.mockResolvedValue({ version: 1, role: 'owner' });
  expect((await cloud.loadForBridge(document.id))!.id).toBe(document.id);
  await cloud.loadForBridge(document.id);
  expect(request).not.toHaveBeenCalled();
  json.mockResolvedValue({ version: 2, role: 'editor' });
  request.mockResolvedValue(new Response(JSON.stringify({ ...document, meta: { ...document.meta, name: 'Changed online' } }), { headers: { 'X-Version': '2', 'X-Role': 'editor' } }));
  expect((await cloud.loadForBridge(document.id))!.meta.name).toBe('Changed online');
  expect(request).toHaveBeenCalledTimes(1);
  json.mockRejectedValue(new CloudError(404, 'Removed'));
  expect(await cloud.loadForBridge(document.id)).toBeNull();
});
