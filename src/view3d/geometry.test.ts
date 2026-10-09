import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { buildScene, type Built } from './geometry';

const options = { lod: 'high' as const, models: new Map(), textures: new Map() };
const byId = (built: Built[]) => new Map(built.map((item) => [item.id, item]));

describe('incremental scene builds', () => {
  it('reuses untouched objects and rebuilds edited ones and the walls their openings cut', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    const doorId = run<string>(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });
    const rectId = run<string>(app, 'create-rect', { x: 5000, y: 5000, meta: { solid: { height: 500, elevation: 0 } } });
    const first = byId(buildScene(app.store.getState().doc, options));

    // An edit elsewhere keeps both the wall and the door.
    run(app, 'move-selection', { ids: [rectId], dx: 100, dy: 0 });
    const second = byId(buildScene(app.store.getState().doc, options, first));
    expect(second.get(wallId)!.object).toBe(first.get(wallId)!.object);
    expect(second.get(doorId)!.object).toBe(first.get(doorId)!.object);
    expect(second.get(rectId)!.object).not.toBe(first.get(rectId)!.object);

    // Moving the door re-cuts its host wall.
    run(app, 'move-selection', { ids: [doorId], dx: 300, dy: 0 });
    const third = byId(buildScene(app.store.getState().doc, options, second));
    expect(third.get(doorId)!.object).not.toBe(second.get(doorId)!.object);
    expect(third.get(wallId)!.object).not.toBe(second.get(wallId)!.object);
    expect(third.get(rectId)!.object).toBe(second.get(rectId)!.object);

    // Shared inputs (graphics, definitions, models, LOD) invalidate everything.
    const low = byId(buildScene(app.store.getState().doc, { ...options, lod: 'low' }, third));
    expect(low.get(rectId)!.object).not.toBe(third.get(rectId)!.object);
  });
});
