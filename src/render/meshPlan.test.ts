import { describe, expect, it } from 'vitest';
import { planOfTriangles } from './meshPlan';

/** A box's 12 triangles: x 0..w, up 0..h, plan y 0..d. */
function box(w: number, h: number, d: number, x = 0, y = 0): number[] {
  const p = (i: number) => [x + (i & 1 ? w : 0), i & 2 ? h : 0, y + (i & 4 ? d : 0)];
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return quads.flatMap(([a, b, c, e]) => [...p(a!), ...p(b!), ...p(c!), ...p(a!), ...p(c!), ...p(e!)]);
}

const segments = (s: number[]) => s.length / 4;

describe('mesh plans on the board', () => {
  it('cuts a tall element at 1.2 m: its outline in bold, nothing from above the cut', () => {
    const plan = planOfTriangles(new Float32Array(box(4000, 3000, 200)));
    // The wall's four sides cut (two triangles each side: 8 short segments forming the outline).
    expect(segments(plan.cut)).toBe(8);
    const xs = plan.cut.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(4000);
    // Below the cut only the bottom outline (4 edges); vertical edges are points in plan.
    expect(segments(plan.edges)).toBe(4);
  });

  it('shows a low object whole from above, without the diagonals of flat faces', () => {
    const plan = planOfTriangles(new Float32Array(box(1200, 750, 800)));
    expect(plan.cut).toEqual([]);
    // Top and bottom outlines project onto each other: 4 edges once deduplicated.
    expect(segments(plan.edges)).toBe(4);
  });

  it('keeps several parts apart', () => {
    const plan = planOfTriangles(new Float32Array([...box(500, 700, 500), ...box(500, 700, 500, 2000, 0)]));
    expect(segments(plan.edges)).toBe(8);
  });
});
