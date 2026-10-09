import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateBody, KernelCache, recipeSignature, type FeatureError } from './evaluate';
import { faceOutline, facePlane } from './faces';
import { meshOf } from './mesh';
import { arcPoints, bulgeThrough, planeFrame, shapeContour, simplifyStroke, sketchRegion, toWorld } from './sketch';
import { identityPlacement, type Body, type Feature, type Placement, type Shape2D, type Sketch, type SketchPlane, type Vec2 } from './types';

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const top: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };
const rect = (id: string, x: number, y: number, width: number, height: number, offset?: number): Shape2D => ({ kind: 'rect', id, x, y, width, height, ...(offset !== undefined ? { offset } : {}) });
const box = (id: string, size: [number, number, number]): Feature => ({ kind: 'primitive', id, shape: 'box', size, placement: identityPlacement() });

function sketch(plane: SketchPlane, shapes: Shape2D[], id = 'sk', extra: Partial<Sketch> = {}): Sketch {
  return { id, name: 'Sketch', visible: true, plane, shapes, ...extra };
}

function body(features: Feature[], placement: Placement = identityPlacement(), id = 'body-1'): Body {
  return { id, name: id, visible: true, lowLod: false, material: 'oak', placement, features };
}

describe('arcs, offsets, corner radius, freehand', () => {
  it('tessellates bulge arcs on the correct side and recovers a bulge from a through point', () => {
    // A counter-clockwise semicircle (bulge 1) from (0,0) to (100,0) swings under the chord
    // (around the centre (50, 0) from angle 180° to 360°) and passes through (50, -50).
    const points = arcPoints([0, 0], [100, 0], 1);
    const bottom = points.reduce((best, p) => (p[1] < best[1] ? p : best), [0, 0] as Vec2);
    expect(bottom[0]).toBeCloseTo(50, 0);
    expect(bottom[1]).toBeCloseTo(-50, 0);
    expect(points[points.length - 1]).toEqual([100, 0]);
    // Clockwise (negative bulge) goes above the chord.
    expect(arcPoints([0, 0], [100, 0], -0.5).every((p) => p[1] >= -1e-9)).toBe(true);
    expect(bulgeThrough([0, 0], [100, 0], [50, -50])).toBeCloseTo(1, 6);
    expect(bulgeThrough([0, 0], [100, 0], [50, 50])).toBeCloseTo(-1, 6);
    // A minor arc through a shallow point, and a major arc through a far point.
    const minor = bulgeThrough([0, 0], [100, 0], [50, -10]);
    expect(minor).toBeGreaterThan(0);
    expect(minor).toBeLessThan(1);
    const major = bulgeThrough([0, 0], [100, 0], [50, -200]);
    expect(major).toBeGreaterThan(1);
    expect(bulgeThrough([0, 0], [100, 0], [50, 0])).toBe(0);
    // Round trip: the arc through the point passes through it.
    const through: Vec2 = [30, 25];
    const arc = arcPoints([0, 0], [100, 0], bulgeThrough([0, 0], [100, 0], through));
    const nearest = Math.min(...arc.map((p) => Math.hypot(p[0] - through[0], p[1] - through[1])));
    expect(nearest).toBeLessThan(3);
  });

  it('closes a polyline with an arc segment into a stadium', () => {
    const shape: Shape2D = { kind: 'polyline', id: 'p', points: [[0, 0], [100, 0], [100, 50], [0, 50]], bulges: [0, 1, 0, 1] };
    const contour = shapeContour(shape);
    expect(contour.length).toBeGreaterThan(10);
    const region = sketchRegion(wasm, sketch(top, [shape]));
    // Rectangle plus two half-discs of radius 25.
    expect(region.area()).toBeCloseTo(100 * 50 + Math.PI * 25 * 25, -2);
    region.delete();
  });

  it('applies shape offsets and the sketch corner radius', () => {
    const grown = sketchRegion(wasm, sketch(top, [rect('r', 0, 0, 100, 100, 10)]));
    // Offset with round joins: area + perimeter * d + pi * d^2.
    expect(grown.area()).toBeCloseTo(10_000 + 400 * 10 + Math.PI * 100, -2);
    grown.delete();
    const frame = sketchRegion(wasm, sketch(top, [rect('outer', 0, 0, 100, 100), rect('inner', 0, 0, 100, 100, -20)]));
    expect(frame.area()).toBeCloseTo(10_000 - 60 * 60, 1);
    expect(frame.numContour()).toBe(2);
    frame.delete();
    const rounded = sketchRegion(wasm, sketch(top, [rect('r', 0, 0, 100, 100)], 'sk', { cornerRadius: 10 }));
    // Four corners lose (1 - pi/4) r^2 each.
    expect(rounded.area()).toBeCloseTo(10_000 - 4 * (1 - Math.PI / 4) * 100, -1);
    rounded.delete();
  });

  it('simplifies a stroke keeping its corners', () => {
    const stroke: Vec2[] = [];
    for (let i = 0; i <= 100; i++) stroke.push([i, i < 50 ? 0.3 * Math.sin(i) : (i - 50) * 2]);
    const simplified = simplifyStroke(stroke, 1);
    expect(simplified.length).toBeLessThan(10);
    expect(simplified[0]).toEqual([0, stroke[0]![1]]);
    expect(simplified[simplified.length - 1]).toEqual([100, 100]);
    expect(simplified.some(([x]) => Math.abs(x - 50) <= 1)).toBe(true);
  });
});

describe('custom planes', () => {
  it('build a right-handed frame from a normal and an x axis', () => {
    const plane: SketchPlane = { kind: 'custom', origin: [10, 20, 30], normal: [0, 0, 2], xAxis: [1, 0, 0.5] };
    const frame = planeFrame(plane);
    expect(frame.normal).toEqual([0, 0, 1]);
    expect(frame.u).toEqual([1, 0, 0]);
    expect(frame.v).toEqual([0, 1, 0]);
    expect(toWorld(plane, [1, 2], 3)).toEqual([11, 22, 33]);
  });
});

describe('revolve', () => {
  it('turns a rectangle beside a vertical axis into a tube', () => {
    // Profile u = 50..100, v = 0..30 on the front plane (u = X, v = Y); axis = v direction at u = 0.
    const front: SketchPlane = { kind: 'plane', id: 'front', offset: 0 };
    const profile = sketch(front, [rect('r', 50, 0, 50, 30)]);
    const { manifold } = evaluateBody(wasm, body([{ kind: 'revolve', id: 'rv', profile: 'sk', axis: { origin: [0, 0], direction: [0, 1] }, angle: 360, op: 'new' }]), undefined, { sketches: { sk: profile } });
    expect(manifold.volume()).toBeCloseTo(Math.PI * (100 * 100 - 50 * 50) * 30, -5);
    const bounds = manifold.boundingBox();
    expect(bounds.min[1]).toBeCloseTo(0, 4);
    expect(bounds.max[1]).toBeCloseTo(30, 4);
    expect(bounds.max[0]).toBeCloseTo(100, 0);
    expect(bounds.min[2]).toBeCloseTo(-100, 0);
    expect(manifold.genus()).toBe(1);
  });

  it('revolves partially, about a horizontal axis, and refuses profiles crossing the axis', () => {
    const profile = sketch(top, [rect('r', 0, 20, 40, 10)]);
    const quarter = evaluateBody(wasm, body([{ kind: 'revolve', id: 'rv', profile: 'sk', axis: { origin: [0, 0], direction: [1, 0] }, angle: 90, op: 'new' }]), undefined, { sketches: { sk: profile } }).manifold;
    // Quarter of a ring with inner radius 20, outer 30, along u (world X) from 0 to 40.
    expect(quarter.volume()).toBeCloseTo((Math.PI * (900 - 400) * 40) / 4, -4);
    const crossing = sketch(top, [rect('r', -10, -10, 20, 20)]);
    expect(() => evaluateBody(wasm, body([{ kind: 'revolve', id: 'rv', profile: 'sk', axis: { origin: [0, 0], direction: [0, 1] }, angle: 360, op: 'new' }]), undefined, { sketches: { sk: crossing } })).toThrow(/crosses the revolve axis/);
  });
});

describe('mirror and pattern', () => {
  it('mirrors across an offset plane, with or without the original', () => {
    const only = evaluateBody(wasm, body([box('b', [100, 100, 100]), { kind: 'mirror', id: 'm', axis: 'x', offset: 100, keepOriginal: false }])).manifold;
    expect(only.boundingBox().min[0]).toBeCloseTo(150, 6);
    expect(only.boundingBox().max[0]).toBeCloseTo(250, 6);
    expect(only.volume()).toBeCloseTo(1_000_000, 0);
    const both = evaluateBody(wasm, body([box('b', [100, 100, 100]), { kind: 'mirror', id: 'm', axis: 'x', offset: 50, keepOriginal: true }])).manifold;
    // The copy touches the original at x = 50: one 200-wide block.
    expect(both.volume()).toBeCloseTo(2_000_000, 0);
    expect(both.boundingBox().max[0]).toBeCloseTo(150, 6);
  });

  it('repeats linearly and radially', () => {
    const linear = evaluateBody(wasm, body([box('b', [100, 100, 100]), { kind: 'pattern', id: 'p', mode: 'linear', count: 4, step: [200, 0, 0] }])).manifold;
    expect(linear.volume()).toBeCloseTo(4_000_000, 0);
    expect(linear.boundingBox().max[0]).toBeCloseTo(650, 6);
    const radial = evaluateBody(wasm, body([{ kind: 'primitive', id: 'c', shape: 'cylinder', size: [40, 500, 40], placement: { position: [300, 0, 0], rotation: [0, 0, 0] } }, { kind: 'pattern', id: 'p', mode: 'radial', count: 6, axis: 'y', center: [0, 0, 0], angle: 360 }])).manifold;
    expect(radial.volume()).toBeCloseTo(6 * Math.PI * 400 * 500, -5);
    const bounds = radial.boundingBox();
    expect(bounds.min[0]).toBeCloseTo(-320, 0);
    // Copies every 60°: the widest in Z sit at 300 · sin 60°.
    expect(bounds.max[2]).toBeCloseTo(300 * Math.sin(Math.PI / 3) + 20, 0);
    expect(() => evaluateBody(wasm, body([box('b', [10, 10, 10]), { kind: 'pattern', id: 'p', mode: 'linear', count: 0, step: [1, 0, 0] }]))).toThrow(/between 1 and 200/);
  });
});

describe('boolean with tool bodies', () => {
  it('subtracts a placed tool body and follows its recipe through the signature', () => {
    const tool = body([{ kind: 'primitive', id: 'c', shape: 'cylinder', size: [20, 400, 20], placement: identityPlacement() }], { position: [0, -100, 0], rotation: [0, 0, 0] }, 'tool');
    const target = body([box('b', [100, 100, 100]), { kind: 'boolean', id: 'bo', op: 'subtract', tool: 'tool' }]);
    const context = { sketches: {}, bodies: { tool, 'body-1': target } };
    const cache = new KernelCache();
    const cut = evaluateBody(wasm, target, cache, context).manifold;
    expect(cut.genus()).toBe(1);
    expect(cut.volume()).toBeCloseTo(1_000_000 - Math.PI * 100 * 100, -3);
    const before = recipeSignature(target, context);
    const moved = { ...tool, placement: { position: [60, -100, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] } };
    const after = recipeSignature(target, { ...context, bodies: { ...context.bodies, tool: moved } });
    expect(after).not.toBe(before);
    // Moved off to the side the tool only nicks the box: no through hole any more.
    const nicked = evaluateBody(wasm, target, cache, { ...context, bodies: { ...context.bodies, tool: moved } }).manifold;
    expect(nicked.genus()).toBe(0);
    // Union and intersection.
    const united = evaluateBody(wasm, body([box('b', [100, 100, 100]), { kind: 'boolean', id: 'bo', op: 'union', tool: 'tool' }]), undefined, context).manifold;
    expect(united.volume()).toBeGreaterThan(1_000_000);
    const inter = evaluateBody(wasm, body([box('b', [100, 100, 100]), { kind: 'boolean', id: 'bo', op: 'intersect', tool: 'tool' }]), undefined, context).manifold;
    expect(inter.volume()).toBeCloseTo(Math.PI * 100 * 100, -3);
  });

  it('rejects missing tools and cycles', () => {
    const a = body([box('b', [100, 100, 100]), { kind: 'boolean', id: 'ba', op: 'union', tool: 'b' }], identityPlacement(), 'a');
    const b = body([box('b', [50, 50, 50]), { kind: 'boolean', id: 'bb', op: 'union', tool: 'a' }], identityPlacement(), 'b');
    const context = { sketches: {}, bodies: { a, b } };
    expect(() => evaluateBody(wasm, a, undefined, context)).toThrow(/depend on itself/);
    expect(recipeSignature(a, context)).toContain('cycle');
    expect(() => evaluateBody(wasm, body([box('b', [10, 10, 10]), { kind: 'boolean', id: 'x', op: 'union', tool: 'nope' }]), undefined, context)).toThrow(/no longer exists/);
    try {
      evaluateBody(wasm, body([{ kind: 'boolean', id: 'first', op: 'union', tool: 'b' }]), undefined, context);
      expect.unreachable();
    } catch (error) {
      expect((error as FeatureError).featureId).toBe('first');
    }
  });
});

describe('face outlines', () => {
  it('finds the top face of a box with a hole and its two loops', () => {
    const hole = sketch({ kind: 'plane', id: 'top', offset: 100 }, [{ kind: 'circle', id: 'c', cx: 0, cy: 0, radius: 20 }], 'hole');
    const mesh = meshOf(evaluateBody(wasm, body([box('b', [200, 100, 200]), { kind: 'extrude', id: 'e', profile: 'hole', distance: -100, op: 'cut' }]), undefined, { sketches: { hole } }));
    // The face whose triangles have normal +Y and lie at y = 100.
    let topFace: number | null = null;
    for (let t = 0; t < mesh.triangles && topFace === null; t++) {
      const i = mesh.indices[t * 3]!;
      if (mesh.normals[i * 3 + 1]! > 0.99 && Math.abs(mesh.positions[i * 3 + 1]! - 100) < 1e-6) topFace = mesh.faceIds[t]!;
    }
    expect(topFace).not.toBeNull();
    const outline = faceOutline(mesh, topFace!)!;
    expect(outline.normal.map((v) => Math.round(v))).toEqual([0, 1, 0]);
    expect(outline.origin[1]).toBeCloseTo(100, 6);
    expect(outline.area).toBeCloseTo(40_000 - Math.PI * 400, -2);
    expect(outline.loops).toHaveLength(2);
    const sizes = outline.loops.map((loop) => loop.length).sort((x, y) => x - y);
    expect(sizes[0]).toBe(4);
    expect(sizes[1]).toBeGreaterThanOrEqual(24);
    // Sketching the loops on the face plane and cutting reproduces the face's area.
    const plane = facePlane(outline, identityPlacement());
    expect(plane.kind).toBe('custom');
    const region = sketchRegion(wasm, sketch(plane, outline.loops.map((points, index) => ({ kind: 'polyline', id: `l${index}`, points }))));
    expect(region.area()).toBeCloseTo(outline.area, -1);
    region.delete();
    // A placed body's face plane moves with it.
    const placed = facePlane(outline, { position: [1000, 0, 0], rotation: [0, 90, 0] });
    expect(placed.kind === 'custom' && placed.origin[0]).toBeCloseTo(1000, 3);
    expect(placed.kind === 'custom' && placed.normal[1]).toBeCloseTo(1, 6);
  });
});
