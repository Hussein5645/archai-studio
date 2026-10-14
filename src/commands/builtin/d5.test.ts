import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { vrStopsOf } from '@/view3d/vrTour';
import { meshOf } from '@/view3d/meshes';

const convert = vi.hoisted(() => vi.fn());
vi.mock('@/view3d/modelImport', () => ({ convertModel: convert }));

describe('D5 scene placement', () => {
  beforeEach(() => {
    convert.mockReset();
    convert.mockResolvedValue({
      glb: Uint8Array.from([1, 2, 3]),
      size: [2000, 3000, 4000],
      unit: 'm',
      up: 'y',
    });
  });
  it('imports the model and starting view in one undo step', async () => {
    const app = createTestApp();
    const result = await app.executor.dispatch('place-d5-scene', {
      documentId: app.store.getState().doc.id,
      name: 'D5 model',
      glb: 'AQID',
    });
    expect(result.ok).toBe(true);
    expect(
      Object.values(app.store.getState().doc.elements).filter((element) => meshOf(element)),
    ).toHaveLength(1);
    expect(vrStopsOf(app.store.getState().doc)).toHaveLength(1);
    app.executor.undo();
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
  });
  it('keeps existing VR stops', async () => {
    const app = createTestApp();
    run(app, 'create-vr-stop', { x: 100, y: 200, name: 'Entrance' });
    await app.executor.dispatch('place-d5-scene', {
      documentId: app.store.getState().doc.id,
      name: 'D5 model',
      glb: 'AQID',
    });
    expect(vrStopsOf(app.store.getState().doc).map((stop) => stop.name)).toEqual(['Entrance']);
  });
  it('does not import into another project if it changes during conversion', async () => {
    const app = createTestApp();
    const documentId = app.store.getState().doc.id;
    convert.mockImplementation(async () => {
      await app.executor.dispatch('new-document', { name: 'Other project' });
      return { glb: Uint8Array.from([1]), size: [1, 1, 1], unit: 'm', up: 'y' };
    });
    const result = await app.executor.dispatch('place-d5-scene', {
      documentId,
      name: 'D5 model',
      glb: 'AQID',
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
  });
});
