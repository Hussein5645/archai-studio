import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { arrange, faceAt, pickedFaces } from './regions';
import { arrangeSketch, sketchRegion } from './sketch';
import type { Shape2D, Sketch, Vec2 } from './types';

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const rect = (id: string, x: number, y: number, width: number, height: number): Shape2D => ({ kind: 'rect', id, x, y, width, height });
const line = (id: string, from: Vec2, to: Vec2): Shape2D => ({ kind: 'polyline', id, points: [from, to], closed: false });
const sketch = (shapes: Shape2D[]): Sketch => ({ id: 'sk', name: 'Sketch', visible: true, plane: { kind: 'plane', id: 'top', offset: 0 }, shapes });

function area(shapes: Shape2D[], seeds?: Vec2[]): number {
  const region = sketchRegion(wasm, sketch(shapes), seeds);
  const value = region.area();
  region.delete();
  return value;
}

describe('arrangement', () => {
  it('closes a loop from lines that cross past their corners (a # drawn with overshoot)', () => {
    const lines = [line('a', [-10, 0], [110, 0]), line('b', [100, -10], [100, 60]), line('c', [110, 50], [-10, 50]), line('d', [0, 60], [0, -10])];
    const result = arrangeSketch(lines);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0]!.area).toBeCloseTo(5000, 6);
    // Every tail past a corner is dangling and each ends in an open end.
    expect(result.dangling).toHaveLength(8);
    expect(result.openEnds).toHaveLength(8);
    expect(area(lines)).toBeCloseTo(5000, 6);
  });

  it('closes a loop through T-junctions and splits a rectangle crossed by a line', () => {
    const tee = [rect('r', 0, 0, 100, 100), line('mid', [50, 0], [50, 100])];
    const result = arrangeSketch(tee);
    expect(result.faces).toHaveLength(2);
    expect(result.faces.every((face) => face.solid)).toBe(true);
    // Both halves are solid by default; picking one extrudes just that half.
    expect(area(tee)).toBeCloseTo(10_000, 6);
    expect(area(tee, [[25, 50]])).toBeCloseTo(5000, 6);
    expect(area(tee, [[25, 50], [75, 50]])).toBeCloseTo(10_000, 6);
  });

  it('collapses duplicate lines instead of cancelling the region', () => {
    const doubled = [rect('a', 0, 0, 100, 100), rect('b', 0, 0, 100, 100)];
    const result = arrangeSketch(doubled);
    expect(result.overlapping.sort()).toEqual(['a', 'b']);
    expect(area(doubled)).toBeCloseTo(10_000, 6);
  });

  it('makes openings of nested networks and islands inside them, and picks any of them', () => {
    const shapes = [rect('outer', 0, 0, 100, 100), rect('hole', 20, 20, 60, 60), rect('island', 40, 40, 20, 20)];
    const { faces } = arrangeSketch(shapes);
    expect(faces.map((face) => face.depth).sort()).toEqual([0, 1, 2]);
    expect(faces.find((face) => face.depth === 0)!.area).toBeCloseTo(10_000 - 3600, 6);
    expect(faces.find((face) => face.depth === 1)!.solid).toBe(false);
    // The opening itself can be picked (e.g. to extrude a separate infill).
    expect(area(shapes, [[30, 30]])).toBeCloseTo(3600 - 400, 6);
    expect(faceAt(faces, [50, 50])!.depth).toBe(2);
    expect(faceAt(faces, [200, 200])).toBeNull();
  });

  it('keeps separate outer loops as separate solid faces', () => {
    const shapes = [rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10)];
    const { faces } = arrangeSketch(shapes);
    expect(faces).toHaveLength(2);
    expect(faces.every((face) => face.depth === 0)).toBe(true);
    expect(area(shapes)).toBeCloseTo(200, 6);
  });

  it('reports crossings and falls back to the default faces when seeds miss', () => {
    const result = arrange([
      { shapeId: 'a', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
      { shapeId: 'b', points: [[50, 50], [150, 50], [150, 150], [50, 150]], closed: true },
    ]);
    expect(result.crossings).toHaveLength(2);
    expect(result.faces).toHaveLength(3);
    expect(pickedFaces(result.faces, [[1000, 1000]])).toHaveLength(3);
  });
});
