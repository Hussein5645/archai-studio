import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateBody, FeatureError } from './evaluate';
import { checkLineLoop, planeMatrix, shapeContour, shapeIsValid, shapesBounds, sketchRegion, toPlane, toWorld } from './sketch';
import { identityPlacement, type Body, type Feature, type Shape2D, type Sketch, type SketchPlane } from './types';

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const rect = (id: string, x: number, y: number, width: number, height: number): Shape2D => ({ kind: 'rect', id, x, y, width, height });
const circle = (id: string, cx: number, cy: number, radius: number): Shape2D => ({ kind: 'circle', id, cx, cy, radius });

function sketch(plane: SketchPlane, shapes: Shape2D[], id = 'sk-1'): Sketch {
  return { id, name: 'Sketch', visible: true, plane, shapes };
}

function body(features: Feature[], placement = identityPlacement()): Body {
  return { id: 'body-1', name: 'Test', visible: true, lowLod: false, material: 'oak', placement, features };
}

describe('plane frames', () => {
  it('map sketch coordinates to the world as the 2D panes show them', () => {
    expect(toWorld({ kind: 'plane', id: 'top', offset: 700 }, [100, 50])).toEqual([100, 700, -50]);
    expect(toWorld({ kind: 'plane', id: 'front', offset: 300 }, [100, 50])).toEqual([100, 50, 300]);
    expect(toWorld({ kind: 'plane', id: 'side', offset: 400 }, [100, 50])).toEqual([400, 50, -100]);
    expect(toWorld({ kind: 'plane', id: 'top', offset: 0 }, [0, 0], 25)).toEqual([0, 25, 0]);
  });

  it('round-trip through toPlane', () => {
    for (const id of ['top', 'front', 'side'] as const) {
      const plane: SketchPlane = { kind: 'plane', id, offset: 123 };
      expect(toPlane(plane, toWorld(plane, [-40, 90]))).toEqual([-40, 90]);
    }
  });

  it('are right-handed so extrusions along +Z of the sketch go along the plane normal', () => {
    for (const id of ['top', 'front', 'side'] as const) {
      const m = planeMatrix({ kind: 'plane', id, offset: 0 });
      const u = [m[0], m[1], m[2]];
      const v = [m[4], m[5], m[6]];
      const n = [m[8], m[9], m[10]];
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      for (let i = 0; i < 3; i++) expect(cross[i]).toBeCloseTo(n[i]!, 12);
    }
  });
});

describe('shapes', () => {
  it('give counter-clockwise contours and reject degenerate shapes', () => {
    expect(shapeContour(rect('r', 0, 0, -100, 50))).toEqual([
      [-100, 0],
      [0, 0],
      [0, 50],
      [-100, 50],
    ]);
    expect(shapeContour({ kind: 'polyline', id: 'p', points: [[0, 0], [0, 10], [10, 0]] })).toEqual([[10, 0], [0, 10], [0, 0]]);
    expect(shapeIsValid(rect('r', 0, 0, 0, 50))).toBe(false);
    expect(shapeIsValid(circle('c', 0, 0, 0))).toBe(false);
    expect(shapeIsValid({ kind: 'polyline', id: 'p', points: [[0, 0], [10, 10]] })).toBe(false);
    expect(shapesBounds([rect('r', 10, 20, 30, 40), circle('c', 0, 0, 5)])).toEqual({ min: [-5, -5], max: [40, 60] });
  });
});

describe('sketchRegion', () => {
  it('merges overlapping shapes and turns nested shapes into holes', () => {
    const plane: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };
    const merged = sketchRegion(wasm, sketch(plane, [rect('a', 0, 0, 100, 100), rect('b', 50, 50, 100, 100)]));
    expect(merged.area()).toBeCloseTo(100 * 100 * 2 - 50 * 50, 3);
    merged.delete();
    const ring = sketchRegion(wasm, sketch(plane, [circle('inner', 0, 0, 20), rect('outer', -50, -50, 100, 100)]));
    // The circle is a 24-gon, a little smaller than the true disc.
    expect(ring.area()).toBeCloseTo(10_000 - Math.PI * 400, -2);
    expect(ring.numContour()).toBe(2);
    ring.delete();
    // An island inside a hole is added back.
    const island = sketchRegion(wasm, sketch(plane, [rect('outer', 0, 0, 100, 100), rect('hole', 20, 20, 60, 60), rect('island', 40, 40, 20, 20)]));
    expect(island.area()).toBeCloseTo(10_000 - 3600 + 400, 3);
    island.delete();
    const empty = sketchRegion(wasm, sketch(plane, [rect('zero', 0, 0, 0, 0)]));
    expect(empty.isEmpty()).toBe(true);
    empty.delete();
  });

  it('stitches separate open lines into an extrudable loop and reports gaps', () => {
    const plane: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };
    const line = (id: string, from: [number, number], to: [number, number]): Shape2D => ({ kind: 'polyline', id, points: [from, to], closed: false });
    const lines = [line('a', [0, 0], [100, 0]), line('b', [100, 0], [100, 50]), line('c', [100, 50], [0, 50]), line('d', [0, 50], [0, 0])];
    expect(checkLineLoop(lines, 'a')).toMatchObject({ shapeIds: ['a', 'b', 'c', 'd'], closed: true, openings: [] });
    const region = sketchRegion(wasm, sketch(plane, lines));
    expect(region.area()).toBeCloseTo(5_000, 6);
    region.delete();
    const open = checkLineLoop(lines.slice(0, -1), 'a');
    expect(open?.closed).toBe(false);
    expect(open?.openings).toEqual([[0, 0], [0, 50]]);
  });
});

describe('extrude', () => {
  const top: SketchPlane = { kind: 'plane', id: 'top', offset: 700 };
  const tabletop = sketch(top, [rect('r', -600, -400, 1200, 800)]);

  it('makes a slab under the top plane from a negative distance', () => {
    const { manifold } = evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'sk-1', distance: -30, op: 'new' }]), undefined, { sketches: { 'sk-1': tabletop } });
    expect(manifold.volume()).toBeCloseTo(1200 * 800 * 30, 0);
    expect(manifold.boundingBox().min).toEqual([-600, 670, -400]);
    expect(manifold.boundingBox().max).toEqual([600, 700, 400]);
  });

  it('extrudes symmetrically and along the front and side normals', () => {
    const front = sketch({ kind: 'plane', id: 'front', offset: 100 }, [rect('r', 0, 0, 50, 20)], 'f');
    const side = sketch({ kind: 'plane', id: 'side', offset: -200 }, [rect('r', 0, 0, 50, 20)], 's');
    const sym = evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'f', distance: 40, symmetric: true, op: 'new' }]), undefined, { sketches: { f: front } }).manifold.boundingBox();
    expect(sym.min).toEqual([0, 0, 80]);
    expect(sym.max).toEqual([50, 20, 120]);
    const sideBox = evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 's', distance: 10, op: 'new' }]), undefined, { sketches: { s: side } }).manifold.boundingBox();
    // Side sketches: u runs along -Z, so a rect from u = 0..50 spans z = -50..0.
    expect(sideBox.min).toEqual([-200, 0, -50]);
    expect(sideBox.max).toEqual([-190, 20, 0]);
  });

  it('uses only the selected profile inside a multi-loop sketch', () => {
    const profiles = sketch({ kind: 'plane', id: 'top', offset: 0 }, [rect('small', 0, 0, 10, 10), rect('large', 100, 0, 40, 40)], 'profiles');
    const solid = evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'profiles', profileShapes: ['small'], distance: 20, op: 'new' }]), undefined, { sketches: { profiles } }).manifold;
    expect(solid.volume()).toBeCloseTo(10 * 10 * 20, 5);
    expect(solid.boundingBox().max[0]).toBe(10);
  });

  it('extrudes an open curve as a selectable surface ribbon', () => {
    const open = sketch({ kind: 'plane', id: 'top', offset: 0 }, [{ kind: 'polyline', id: 'line', points: [[0, 0], [100, 0]], closed: false }], 'open');
    const surface = evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'open', profileShapes: ['line'], surface: true, distance: 50, op: 'new' }]), undefined, { sketches: { open } }).manifold;
    expect(surface.boundingBox().max[0]).toBeCloseTo(100, 4);
    expect(surface.boundingBox().max[1]).toBeCloseTo(50, 4);
    expect(surface.volume()).toBeLessThan(300);
  });

  it('adds to and cuts from the body so far', () => {
    const base: Feature = { kind: 'primitive', id: 'p', shape: 'box', size: [100, 100, 100], placement: identityPlacement() };
    const hole = sketch({ kind: 'plane', id: 'top', offset: 100 }, [circle('c', 0, 0, 10)], 'hole');
    const cut = evaluateBody(wasm, body([base, { kind: 'extrude', id: 'e', profile: 'hole', distance: -100, op: 'cut' }]), undefined, { sketches: { hole } }).manifold;
    expect(cut.volume()).toBeCloseTo(1_000_000 - Math.PI * 100 * 100, -3);
    expect(cut.genus()).toBe(1);
    const add = evaluateBody(wasm, body([base, { kind: 'extrude', id: 'e', profile: 'hole', distance: 50, op: 'add' }]), undefined, { sketches: { hole } }).manifold;
    expect(add.boundingBox().max[1]).toBeCloseTo(150, 6);
  });

  it('brings the world-space prism into a placed body', () => {
    const base: Feature = { kind: 'primitive', id: 'p', shape: 'box', size: [100, 100, 100], placement: identityPlacement() };
    const placed = body([base, { kind: 'extrude', id: 'e', profile: 'hole', distance: -100, op: 'cut' }], { position: [1000, 0, 0], rotation: [0, 90, 0] });
    // The body's box sits at world x 950..1050; a hole drawn there in world space must hit it.
    const hole = sketch({ kind: 'plane', id: 'top', offset: 100 }, [circle('c', 1000, 0, 10)], 'hole');
    const cut = evaluateBody(wasm, placed, undefined, { sketches: { hole } }).manifold;
    expect(cut.genus()).toBe(1);
    // In the body's own frame the hole is at the local origin (rotation about Y keeps the axis).
    expect(cut.boundingBox().min).toEqual([-50, 0, -50]);
  });

  it('reports the sketch problems on the feature', () => {
    const sketches = { 'sk-1': tabletop };
    expect(() => evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'missing', distance: 10, op: 'new' }]), undefined, { sketches })).toThrow(/no longer exists/);
    expect(() => evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'sk-1', distance: 0, op: 'new' }]), undefined, { sketches })).toThrow(/must not be zero/);
    expect(() => evaluateBody(wasm, body([{ kind: 'extrude', id: 'e', profile: 'sk-1', distance: 10, op: 'cut' }]), undefined, { sketches })).toThrow(/Nothing to cut/);
    const empty = { e: sketch(top, [], 'e') };
    try {
      evaluateBody(wasm, body([{ kind: 'extrude', id: 'ex', profile: 'e', distance: 10, op: 'new' }]), undefined, { sketches: empty });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureError);
      expect((error as FeatureError).featureId).toBe('ex');
      expect((error as FeatureError).message).toMatch(/no closed region/);
    }
  });
});

describe('sweep', () => {
  it('follows every segment of an open polyline path', () => {
    const path = sketch({ kind: 'plane', id: 'top', offset: 0 }, [{ kind: 'polyline', id: 'path', points: [[0, 0], [100, 0], [100, 100]], closed: false }], 'path-sketch');
    const profile = sketch({ kind: 'plane', id: 'front', offset: 0 }, [circle('profile', 0, 0, 5)], 'profile-sketch');
    const swept = evaluateBody(wasm, body([{ kind: 'sweep', id: 'sweep', path: { sketchId: 'path-sketch', shapeIds: ['path'] }, profile: 'profile-sketch', profileShapes: ['profile'], op: 'new' }]), undefined, { sketches: { 'path-sketch': path, 'profile-sketch': profile } }).manifold;
    const bounds = swept.boundingBox();
    expect(bounds.max[0]).toBeGreaterThan(95);
    expect(Math.max(Math.abs(bounds.min[2]), Math.abs(bounds.max[2]))).toBeGreaterThan(95);
    expect(swept.volume()).toBeGreaterThan(10_000);
  });
});
