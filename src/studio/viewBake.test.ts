import { expect, it, vi, beforeEach } from 'vitest';
import { Group } from 'three';
import { createTestApp } from '@/test/harness';
import { defaultSettings } from './settings';
import { startViewBake, pendingBakeKey } from './viewBake';
import { bakeScene } from './bake';

vi.mock('@/view3d/vrExport', () => ({ exportSceneSnapshot: vi.fn(async () => new ArrayBuffer(24)) }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({ GLTFLoader: class { setMeshoptDecoder() { return this; } async parseAsync() { return { scene: new Group() }; } } }));
vi.mock('./bake', () => ({ bakeScene: vi.fn(), disposeBake: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('starts and persists Unreal Lightmass before a large browser bake can fail', async () => {
  const app = createTestApp(), order: string[] = [];
  const unused = async (): Promise<never> => { throw Error('unused'); };
  app.platform.unreal = { status: unused, update: unused, viewport: async () => {}, command: async () => {}, image: unused, exportScene: async () => null, stop: async () => {},
    bakeStart: async () => { order.push('unreal'); return { id: 'test-job', state: 'running', stage: 'Preparing Unreal bake' }; } };
  vi.mocked(bakeScene).mockImplementation(async () => {
    order.push('web');
    expect(app.platform.storageMap.has(pendingBakeKey(app.store.getState().doc.id, 'view'))).toBe(true);
    throw Error('Browser memory budget exceeded');
  });
  const pending = await startViewBake(app.platform, app.catalog, app.store.getState().doc, 'view', defaultSettings(), undefined, () => {});
  expect(order).toEqual(['unreal', 'web']);
  expect(pending).toMatchObject({ jobId: 'test-job', webError: 'Browser memory budget exceeded' });
  expect(JSON.parse(app.platform.storageMap.get(pendingBakeKey(app.store.getState().doc.id, 'view'))!)).toMatchObject({ jobId: 'test-job' });
});
