import { describe, expect, it } from 'vitest';
import { arrangeSketch, shapeContour, signedArea } from './kernel/sketch';
import type { Shape2D, Vec2 } from './kernel/types';
import { cornerShapes, extendShapeTo, filletAll, filletCorner, filletJoint, fixProfile, healShapes, offsetPoints, joinShapes, mirrorShape, rotateShape, scaleShape, splitShapeAt, trimShape } from './sketchEdit';

const line = (id: string, from: Vec2, to: Vec2): Shape2D => ({ kind: 'polyline', id, points: [from, to], closed: false });
const rect = (id: string, x: number, y: number, width: number, height: number): Shape2D => ({ kind: 'rect', id, x, y, width, height });
let counter = 0;
const newId = () => `n${++counter}`;
const points = (shape: Shape2D) => (shape.kind === 'polyline' ? shape.points : []);
const close = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe('healShapes', () => {
  it('extends near-miss ends to their corner and drops duplicates', () => {
    // A rectangle drawn as lines with small gaps at every corner, plus a duplicate line.
    const shapes = [line('a', [2, 0], [98, 0]), line('b', [100, 2], [100, 48]), line('c', [98, 50], [2, 50]), line('d', [0, 48], [0, 2]), line('dup', [2, 0], [98, 0])];
    expect(arrangeSketch(shapes).faces).toHaveLength(0);
    const healed = healShapes(shapes, 5);
    expect(healed.removed).toBe(1);
    expect(healed.joined).toBe(4);
    const faces = arrangeSketch(healed.shapes).faces;
    expect(faces).toHaveLength(1);
    expect(faces[0]!.area).toBeCloseTo(5000, 6);
  });

  it('leaves ends that are too far apart', () => {
    const healed = healShapes([line('a', [0, 0], [100, 0]), line('b', [120, 0], [200, 0])], 5);
    expect(healed.joined).toBe(0);
  });
});

describe('transforms', () => {
  it('rotates a rectangle into a polyline unless it stays axis-true', () => {
    const quarter = rotateShape(rect('r', 0, 0, 100, 50), [0, 0], 90);
    expect(quarter).toMatchObject({ kind: 'rect', x: -50, y: 0, width: 50, height: 100 });
    const tilted = rotateShape(rect('r', 0, 0, 100, 50), [0, 0], 30);
    expect(tilted.kind).toBe('polyline');
    expect(Math.abs(signedArea(shapeContour(tilted)))).toBeCloseTo(5000, 6);
  });

  it('mirrors, flipping arc bulges, and scales about a point', () => {
    const arc: Shape2D = { kind: 'polyline', id: 'p', points: [[0, 0], [100, 0]], bulges: [0.5], closed: false };
    const mirrored = mirrorShape(arc, [0, 10], [100, 10]);
    expect(points(mirrored)).toEqual([[0, 20], [100, 20]]);
    expect(mirrored.kind === 'polyline' && mirrored.bulges).toEqual([-0.5]);
    const scaled = scaleShape({ kind: 'circle', id: 'c', cx: 10, cy: 0, radius: 5 }, [0, 0], 2);
    expect(scaled).toMatchObject({ cx: 20, cy: 0, radius: 10 });
  });
});

describe('trim / extend / split / corner', () => {
  it('trims the picked piece of a line between two crossing lines', () => {
    const target = line('t', [0, 0], [100, 0]);
    const cutters = [line('c1', [30, -10], [30, 10]), line('c2', [70, -10], [70, 10])];
    const pieces = trimShape(target, [50, 1], cutters, newId);
    expect(pieces).toHaveLength(2);
    expect(points(pieces[0]!)).toEqual([[0, 0], [30, 0]]);
    expect(points(pieces[1]!)).toEqual([[70, 0], [100, 0]]);
    // Picking the tail removes it up to the first cut.
    expect(trimShape(target, [10, 0], cutters, newId).map(points)).toEqual([[[30, 0], [100, 0]]]);
  });

  it('trims a closed rectangle into the open part that remains', () => {
    const pieces = trimShape(rect('r', 0, 0, 100, 100), [50, 0], [line('c1', [30, -10], [30, 10]), line('c2', [70, -10], [70, 10])], newId);
    expect(pieces).toHaveLength(1);
    const kept = points(pieces[0]!);
    close(kept[0]!, [70, 0]);
    close(kept[kept.length - 1]!, [30, 0]);
    expect(kept).toHaveLength(6);
  });

  it('extends a line end to a boundary and makes corners of two lines', () => {
    const extended = extendShapeTo(line('a', [0, 0], [50, 0]), [50, 0], line('wall', [100, -50], [100, 50]));
    expect(points(extended!)).toEqual([[0, 0], [100, 0]]);
    expect(extendShapeTo(line('a', [0, 0], [50, 0]), [50, 0], line('wall', [-100, -50], [-100, 50]))).toBeNull();
    const corner = cornerShapes(line('a', [0, 0], [120, 0]), [10, 0], line('b', [100, -20], [100, 80]), [100, 50]);
    expect(corner!.map(points)).toEqual([[[0, 0], [100, 0]], [[100, 0], [100, 80]]]);
  });

  it('splits lines and opens closed shapes at a point', () => {
    const halves = splitShapeAt(line('a', [0, 0], [100, 0]), [40, 3], newId);
    expect(halves.map(points)).toEqual([[[0, 0], [40, 0]], [[40, 0], [100, 0]]]);
    const opened = splitShapeAt(rect('r', 0, 0, 100, 100), [50, 0], newId);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'polyline', closed: false });
    expect(points(opened[0]!)).toHaveLength(6);
  });

  it('fillets and chamfers a corner and joins touching lines', () => {
    const square: Shape2D = { kind: 'polyline', id: 's', points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
    const rounded = filletCorner(square, [100, 0], 10, 'fillet')!;
    // One corner loses (1 - pi/4) r^2.
    expect(Math.abs(signedArea(shapeContour(rounded)))).toBeCloseTo(10_000 - (1 - Math.PI / 4) * 100, -1);
    const chamfered = filletCorner(square, [100, 0], 10, 'chamfer')!;
    expect(Math.abs(signedArea(shapeContour(chamfered)))).toBeCloseTo(10_000 - 50, 6);
    const joined = joinShapes([line('a', [0, 0], [100, 0]), line('b', [100, 0], [100, 50]), line('c', [100, 50], [0, 50]), line('d', [0, 0], [0, 50])]);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ kind: 'polyline', id: 'a' });
    expect((joined[0] as { closed?: boolean }).closed).toBeUndefined();
  });
});

describe('fixProfile', () => {
  it('trims tails that overshoot corners so only the loop remains', () => {
    const shapes = [line('a', [-10, 0], [110, 0]), line('b', [100, -10], [100, 60]), line('c', [110, 50], [-10, 50]), line('d', [0, 60], [0, -10])];
    const fixed = fixProfile(shapes, 5, newId);
    expect(fixed.trimmed).toBe(8);
    const result = arrangeSketch(fixed.shapes);
    expect(result.openEnds).toHaveLength(0);
    expect(result.faces[0]!.area).toBeCloseTo(5000, 6);
  });
});

describe('drawing helpers', () => {
  it('rounds every corner, offsets to the left and rounds chain joints', () => {
    const rounded = filletAll(rect('r', 0, 0, 100, 100), 10);
    expect(Math.abs(signedArea(shapeContour(rounded)))).toBeCloseTo(10_000 - 4 * (1 - Math.PI / 4) * 100, -1);
    expect(offsetPoints([[0, 0], [100, 0]], 10, false)).toEqual([[0, 10], [100, 10]]);
    const square = offsetPoints([[0, 0], [100, 0], [100, 100], [0, 100]], 10, true);
    close(square[0]!, [10, 10]);
    close(square[2]!, [90, 90]);
    const joint = filletJoint([0, 0], [100, 0], [100, 100], 20)!;
    close(joint.first[1], [80, 0]);
    close(joint.second[0], [100, 20]);
    expect(joint.arc.bulge).toBeGreaterThan(0);
  });
});
