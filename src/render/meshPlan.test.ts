import { describe, expect, it } from 'vitest';
import { glbTriangles, planOfTriangles } from './meshPlan';

/** A box's 12 triangles: x 0..w, up 0..h, plan y 0..d. */
function box(w: number, h: number, d: number, x = 0, y = 0): number[] {
  const p = (i: number) => [x + (i & 1 ? w : 0), i & 2 ? h : 0, y + (i & 4 ? d : 0)];
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return quads.flatMap(([a, b, c, e]) => [...p(a!), ...p(b!), ...p(c!), ...p(a!), ...p(c!), ...p(e!)]);
}

const segments = (s: number[]) => s.length / 4;

describe('mesh plans on the board', () => {
  it('preallocates transformed GLB triangles, including repeated instances', () => {
    const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0,
      scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 0, translation: [10, 20, 30] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 },
        { bufferView: 1, componentType: 5123, type: 'SCALAR', count: 3 }],
      bufferViews: [{ byteOffset: 0, byteLength: 36 }, { byteOffset: 36, byteLength: 6 }],
    }));
    const jsonLength = Math.ceil(json.length / 4) * 4;
    const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + 44);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
    view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
    bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20);
    const start = 20 + jsonLength;
    view.setUint32(start, 44, true); view.setUint32(start + 4, 0x004e4942, true);
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    positions.forEach((v, i) => view.setFloat32(start + 8 + i * 4, v, true));
    [0, 1, 2].forEach((v, i) => view.setUint16(start + 8 + 36 + i * 2, v, true));
    expect(Array.from(glbTriangles(bytes))).toEqual([...positions, 10, 20, 30, 11, 20, 30, 10, 21, 30]);
  });
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
