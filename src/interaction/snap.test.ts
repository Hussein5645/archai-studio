import { describe, expect, it } from 'vitest';
import { snapMoveDelta, snapPoint } from './snap';
import { snapToBoundary } from './wallFaceSnap';
import { createTestApp, run } from '@/test/harness';

describe('stable grid snapping', () => {
  it('keeps the same origin on the grid for odd-sized objects throughout a drag', () => {
    const bounds = { x: 23, y: -17, width: 173, height: 319 };
    for (let drag = -220; drag < 220; drag += 3) {
      const delta = snapMoveDelta(bounds, { x: drag, y: drag / 2 }, 100);
      expect((bounds.x + delta.x) / 100).toBeCloseTo(Math.round((bounds.x + delta.x) / 100));
      expect((bounds.y + delta.y) / 100).toBeCloseTo(Math.round((bounds.y + delta.y) / 100));
    }
  });

  it('retains grid alignment along an existing wall and excludes the dragged wall itself', () => {
    const app = createTestApp();
    const [id] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [0, 5000]] });
    const doc = app.store.getState().doc;
    const point = snapPoint({ x: 13, y: 1981 }, 100);
    expect(snapToBoundary(doc, point, 100, { faces: true })?.point).toEqual({ x: 0, y: 2000 });
    expect(snapToBoundary(doc, { x: 7, y: 8 }, 100, { excludeIds: [id!] })).toBeNull();
  });
});
