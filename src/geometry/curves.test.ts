import { describe, expect, it } from 'vitest';
import type { LineElement } from '@/document';
import { pointAtLine, projectOnLine, sampleCurvePath } from './curves';

const wall = (): LineElement => ({
  id: 'wall', parentId: null, index: 'a0', x: 0, y: 0, rotation: 0,
  visible: true, locked: false, kind: 'line', points: [[0, 0], [1000, 1000]], closed: false,
  style: { fill: null, stroke: '#000', strokeWidth: 200, opacity: 1 },
  path: {
    start: [0, 0],
    segments: [{ kind: 'arc', center: [0, 1000], radius: 1000, startAngle: -Math.PI / 2, endAngle: 0, clockwise: false }],
  },
});

describe('analytic curves', () => {
  it('keeps exact curve data while producing a tessellation for display and meshing', () => {
    const path = wall().path!;
    const points = sampleCurvePath(path, 12);
    expect(points[0]).toEqual([0, 0]);
    expect(points.at(-1)?.[0]).toBeCloseTo(1000);
    expect(points.at(-1)?.[1]).toBeCloseTo(1000);
    expect(path.segments[0]).toMatchObject({ kind: 'arc', radius: 1000 });
  });

  it('projects and locates hosted items by distance along the curve', () => {
    const element = wall();
    const halfway = pointAtLine(element, Math.PI * 1000 / 4)!;
    expect(halfway.point.x).toBeCloseTo(Math.SQRT1_2 * 1000, 0);
    expect(halfway.point.y).toBeCloseTo((1 - Math.SQRT1_2) * 1000, 0);
    const projected = projectOnLine(element, halfway.point)!;
    expect(projected.distance).toBeLessThan(0.01);
    expect(projected.along).toBeCloseTo(halfway.totalLength / 2, 0);
  });
});
