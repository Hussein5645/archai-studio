import { describe, expect, it } from 'vitest';
import { planeFrame } from './kernel/sketch';
import { WorkPlaneService } from './work-plane';
import { viewPlaneOf } from './store';

describe('WorkPlaneService', () => {
  it('constructs a plane from three points and projects pointer rays', () => {
    const plane = WorkPlaneService.fromThreePoints([0, 0, 0], [1, 0, 0], [0, 0, 1]);
    expect(WorkPlaneService.projectRay(plane, [2, 10, 3], [0, -1, 0])).toEqual([2, 0, 3]);
  });

  it('offsets and flips without changing the camera or any external state', () => {
    const plane = WorkPlaneService.offset({ kind: 'plane', id: 'top', offset: 0 }, 250);
    expect(plane).toEqual({ kind: 'plane', id: 'top', offset: 250 });
    const flipped = WorkPlaneService.flip(plane);
    expect(planeFrame(flipped).normal[1]).toBe(-1);
  });

  it('handles arbitrary 3 points and rejects collinear points', () => {
    // Slanted plane through (0, 0, 0), (100, 100, 0), (0, 100, 100)
    const slanted = WorkPlaneService.fromThreePoints([0, 0, 0], [100, 100, 0], [0, 100, 100]);
    expect(slanted.kind).toBe('custom');
    if (slanted.kind === 'custom') {
      expect(slanted.origin).toEqual([0, 0, 0]);
      // Normal should have unit length
      const len = Math.hypot(...slanted.normal);
      expect(len).toBeCloseTo(1, 5);
    }

    // Collinear points should throw
    expect(() => WorkPlaneService.fromThreePoints([0, 0, 0], [10, 0, 0], [20, 0, 0])).toThrow();
  });
});


describe('view planes', () => {
  const state = { planes: { top: 0, front: 300, side: 0 }, workPlane: { kind: 'plane', id: 'top', offset: 0 } as const };

  it('shows the far side of a view plane with up still up', () => {
    const back = planeFrame(viewPlaneOf('back', state)!);
    expect(back.normal.map((n) => n + 0)).toEqual([0, 0, -1]);
    expect(back.v.map((n) => n + 0)).toEqual([0, 1, 0]);
    expect(back.origin).toEqual([0, 0, 300]);
    const bottom = planeFrame(viewPlaneOf('bottom', state)!);
    expect(bottom.normal.map((n) => n + 0)).toEqual([0, -1, 0]);
  });

  it('has no plane for 3D and camera panes', () => {
    expect(viewPlaneOf('3d', state)).toBeNull();
    expect(viewPlaneOf('camera:a', state)).toBeNull();
    expect(viewPlaneOf('workplane', state)).toBe(state.workPlane);
  });
});
