import { expect, it, vi } from 'vitest';
import { paintTarget } from './paint';
import { createTestApp, run } from '@/test/harness';
it('replaces the same imported slot across different mesh blobs, skipping locked and overridden meshes, in one undo step', async () => {
  const app = createTestApp();
  const ids = ['one', 'two', 'three', 'four'].map((blobId) => run<string>(app, 'create-rect', { x: 0, y: 0, width: 10, height: 10, meta: { mesh: { blobId, height: 10 } } }));
  const material = run<string>(app, 'create-material');
  run(app, 'assign-material', { ids: [ids[2]], materialId: material, slot: 'asset:Concrete' });
  // Locks and material overrides must survive a global imported-material replacement.
  app.store.setState((state) => ({ doc: { ...state.doc, elements: { ...state.doc.elements, [ids[3]!]: { ...state.doc.elements[ids[3]!]!, locked: true } } } }));
  const target = run<string>(app, 'create-material');
  paintTarget({ ...app, toasts: { push: vi.fn() } } as never, { elementId: ids[0]!, slot: 'asset:Concrete', surface: null, materialId: null }, 'everywhere', target, { assetSlotsOf: () => ['asset:Concrete'] });
  await Promise.resolve();
  expect(app.store.getState().doc.elements[ids[0]!]!.meta?.['materials']).toEqual({ 'asset:Concrete': target });
  expect(app.store.getState().doc.elements[ids[1]!]!.meta?.['materials']).toEqual({ 'asset:Concrete': target });
  expect(app.store.getState().doc.elements[ids[2]!]!.meta?.['materials']).toEqual({ 'asset:Concrete': material });
  expect(app.store.getState().doc.elements[ids[3]!]!.meta?.['materials']).toBeUndefined();
  await app.executor.dispatch('undo');
  expect(app.store.getState().doc.elements[ids[0]!]!.meta?.['materials']).toBeUndefined();
  expect(app.store.getState().doc.elements[ids[1]!]!.meta?.['materials']).toBeUndefined();
});
