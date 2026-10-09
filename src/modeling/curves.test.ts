import { describe, expect, it } from 'vitest';
import { shapeContour } from './kernel/sketch';
import type { Shape2D, Vec2 } from './kernel/types';
import { bulgeArc, circleThrough, ellipseShape, pathToPolyline, penShape, shapeToPath, splitSegment, tangentArcBulge } from './curves';
import { cornerShapes, dragGrip, extendShapeTo, filletCorner, insertVertex, joinShapes, shapeGrips, splitShapeAt, trimShape } from './sketchEdit';

let next = 0;
const newId = () => `n${++next}`;
const line = (id: string, a: Vec2, b: Vec2): Shape2D => ({ kind: 'polyline', id, points: [a, b], closed: false });
/** A half circle of radius 100 about the origin from (100, 0) to (-100, 0) through (0, 100). */
const halfArc = (id = 'arc'): Shape2D => ({ kind: 'polyline', id, points: [[100, 0], [-100, 0]], bulges: [1], closed: false });
const onCircle = (shape: Shape2D, r = 100) => shapeContour(shape).every(([x, y]) => Math.abs(Math.hypot(x, y) - r) < 1e-6);

describe('curves as exact paths', () => {
  it('reads a bulge as the arc it draws (counter-clockwise for a positive bulge)', () => {
    const arc = bulgeArc([100, 0], [-100, 0], 1);
    expect(arc.c[0]).toBeCloseTo(0);
    expect(arc.c[1]).toBeCloseTo(0);
    expect(arc.r).toBeCloseTo(100);
    expect(arc.sweep).toBeCloseTo(Math.PI);
    // The tessellated arc passes the top of the circle, and ends on its last point.
    const contour = shapeContour(halfArc());
    expect(contour.some(([x, y]) => Math.abs(x) < 1 && Math.abs(y - 100) < 1)).toBe(true);
    expect(contour.at(-1)).toEqual([-100, 0]);
  });

  it('round-trips polylines with arcs and Bézier handles', () => {
    const shape: Shape2D = { kind: 'polyline', id: 'p', points: [[0, 0], [100, 0], [100, 100]], bulges: [0.3, 0], handles: [null, [[150, 30], [150, 70]]], closed: false };
    const back = pathToPolyline(shapeToPath(shape), shape);
    expect(back.points).toEqual(shape.points);
    expect(back.bulges?.[0]).toBeCloseTo(0.3);
    expect(back.handles?.[1]).toEqual([[150, 30], [150, 70]]);
  });

  it('splits an arc of more than a half turn into exact pieces', () => {
    const three = pathToPolyline({ segs: [{ kind: 'arc', c: { x: 0, y: 0 }, r: 50, start: 0, sweep: (3 * Math.PI) / 2 }], closed: false }, { id: 'a' });
    expect(three.points).toHaveLength(3);
    expect(onCircle(three, 50)).toBe(true);
  });
});

describe('curve edits on arcs and pen curves', () => {
  it('trims the clicked piece of an arc between two lines', () => {
    const cutters = [line('c1', [50, -10], [50, 200]), line('c2', [-50, -10], [-50, 200])];
    const pieces = trimShape(halfArc(), [0, 100], cutters, newId);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) expect(onCircle(piece)).toBe(true);
    const ends = pieces.flatMap((piece) => (piece.kind === 'polyline' ? [piece.points[0]!, piece.points.at(-1)!] : []));
    expect(ends.some(([x, y]) => Math.abs(x - 50) < 1e-6 && Math.abs(y - Math.sqrt(7500)) < 1e-6)).toBe(true);
  });

  it('trims a straight line where a circle crosses it', () => {
    const pieces = trimShape(line('l', [-200, 0], [200, 0]), [0, 0], [{ kind: 'circle', id: 'c', cx: 0, cy: 0, radius: 100 }], newId);
    expect(pieces.map((piece) => (piece.kind === 'polyline' ? piece.points : []))).toEqual([[[-200, 0], [-100, 0]], [[100, 0], [200, 0]]]);
  });

  it('extends a line to an arc and an arc to a line', () => {
    const toArc = extendShapeTo(line('l', [0, 0], [0, 20]), [0, 20], halfArc('b'));
    expect(toArc?.kind === 'polyline' && toArc.points[1]![1]).toBeCloseTo(100);
    // The arc's end at (-100, 0) grows round the circle to a line at y = -60.
    const arc = extendShapeTo(halfArc(), [-100, 0], line('w', [-200, -60], [0, -60]));
    expect(arc && onCircle(arc)).toBe(true);
    expect(arc?.kind === 'polyline' && arc.points.at(-1)![1]).toBeCloseTo(-60);
  });

  it('meets a line and an arc at their corner', () => {
    const result = cornerShapes(line('l', [-50, 50], [0, 50]), [-40, 50], halfArc(), [80, 50]);
    expect(result).not.toBeNull();
    const [a, b] = result!;
    expect(a.kind === 'polyline' && a.points[1]![0]).toBeCloseTo(Math.sqrt(7500));
    expect(onCircle(b)).toBe(true);
  });

  it('rounds the joint between a line and an arc with a tangent arc', () => {
    const shape: Shape2D = { kind: 'polyline', id: 'j', points: [[200, 0], [100, 0], [-100, 0]], bulges: [0, 1], closed: false };
    const rounded = filletCorner(shape, [100, 0], 10, 'fillet');
    expect(rounded?.kind === 'polyline' && rounded.points.length).toBe(4);
  });

  it('joins lines and arcs into one closed curve', () => {
    const joined = joinShapes([halfArc('a'), line('b', [-100, 0], [100, 0])]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.kind === 'polyline' && joined[0]!.closed).not.toBe(false);
    expect(joined[0]!.id).toBe('a');
  });

  it('splits an arc and adds exact points on arcs and pen curves', () => {
    const halves = splitShapeAt(halfArc(), [0, 100], newId);
    expect(halves).toHaveLength(2);
    for (const half of halves) expect(onCircle(half)).toBe(true);
    const more = insertVertex(halfArc(), [0, 100]);
    expect(more?.kind === 'polyline' && more.points).toHaveLength(3);
    expect(more && onCircle(more)).toBe(true);
    const pen = penShape([{ point: [0, 0], handle: [50, 50] }, { point: [100, 0], handle: [150, -50] }], false);
    const cut = splitSegment(pen, 0, 0.5);
    expect(cut.points).toHaveLength(3);
    expect(cut.handles?.every(Boolean)).toBe(true);
  });
});

describe('curved drawing tools', () => {
  it('builds a closed ellipse through its axis ends', () => {
    const ellipse = ellipseShape([0, 0], [200, 0], 100);
    expect(ellipse.points).toEqual([[200, 0], [0, 100], [-200, 0], [0, -100]]);
    // Every tessellated point lies (nearly) on x²/200² + y²/100² = 1.
    for (const [x, y] of shapeContour(ellipse)) expect((x / 200) ** 2 + (y / 100) ** 2).toBeCloseTo(1, 2);
  });

  it('finds circles through three points and tangent arcs', () => {
    const circle = circleThrough([100, 0], [0, 100], [-100, 0]);
    expect(circle?.radius).toBeCloseTo(100);
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
    // Leaving (0, 0) along +x to (100, 100): a quarter turn to the left, counter-clockwise.
    expect(tangentArcBulge([0, 0], [1, 0], [100, 100])).toBeCloseTo(Math.tan(Math.PI / 8));
    expect(tangentArcBulge([0, 0], [1, 0], [100, 0])).toBeCloseTo(0);
  });

  it('draws pen curves: corners straight, smooth nodes with mirrored handles', () => {
    const shape = penShape([{ point: [0, 0], handle: null }, { point: [100, 0], handle: [120, 40] }, { point: [200, 0], handle: null }], false);
    expect(shape.handles).toEqual([[[0, 0], [80, -40]], [[120, 40], [200, 0]]]);
    const straight = penShape([{ point: [0, 0], handle: null }, { point: [100, 0], handle: null }], false);
    expect(straight.handles).toBeUndefined();
  });

  it('drags a handle of a smooth node and keeps the other one opposite', () => {
    const shape = penShape([{ point: [0, 0], handle: null }, { point: [100, 0], handle: [150, 0] }, { point: [200, 0], handle: null }], false);
    const grip = shapeGrips(shape).find((item) => item.kind === 'handle' && item.index === 1 && item.end === 0)!;
    const moved = dragGrip(shape, grip, [100, 50]);
    expect(moved.kind === 'polyline' && moved.handles?.[1]?.[0]).toEqual([100, 50]);
    const opposite = moved.kind === 'polyline' ? moved.handles?.[0]?.[1] : null;
    expect(opposite?.[0]).toBeCloseTo(100);
    expect(opposite?.[1]).toBeCloseTo(-50);
    // Moving the node carries both of its handles.
    const vertex = shapeGrips(moved).find((item) => item.kind === 'vertex' && item.index === 1)!;
    const shifted = dragGrip(moved, vertex, [110, 0]);
    expect(shifted.kind === 'polyline' && shifted.handles?.[1]?.[0]).toEqual([110, 50]);
  });
});
