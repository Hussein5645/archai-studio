import { describe, expect, it } from 'vitest';
import type { Element, ElementTable } from '@/document';
import { sampleCurvePath } from '@/geometry';
import { draftGeometry } from './geometry';
import { parseTyped, typedPoint } from './input';
import { DEFAULT_OSNAP, resolveSnap, type OsnapQuery } from './osnap';
import { arcTangent, arcThrough, circleFrom3, ellipsePath, polygonPoints } from './shapes';

const style = { fill: null, stroke: '#000000', strokeWidth: 10, opacity: 1 };
function line(id: string, points: [number, number][], extra: Partial<Element> = {}): Element {
  return { id, parentId: null, index: `a${id}`, x: 0, y: 0, rotation: 0, visible: true, locked: false, kind: 'line', points, closed: false, style, ...extra } as Element;
}
function rect(id: string, x: number, y: number, width: number, height: number, rotation = 0): Element {
  return { id, parentId: null, index: `a${id}`, x, y, rotation, visible: true, locked: false, kind: 'rect', width, height, radius: 0, style } as Element;
}
const table = (...elements: Element[]): ElementTable => Object.fromEntries(elements.map((e) => [e.id, e]));
const query = (extra: Partial<OsnapQuery> = {}): OsnapQuery => ({ tolerance: 10, settings: DEFAULT_OSNAP, ...extra });

describe('drafting geometry', () => {
  it('collects world segments, key points and arcs of lines and rotated rectangles', () => {
    const geometry = draftGeometry(table(line('l', [[0, 0], [1000, 0]], { x: 100, y: 100 } as Partial<Element>), rect('r', 0, 0, 100, 50, 90)));
    expect(geometry.segments).toHaveLength(1 + 4);
    expect(geometry.points.filter((p) => p.id === 'l').map((p) => p.kind).sort()).toEqual(['endpoint', 'endpoint', 'midpoint']);
    const corners = geometry.points.filter((p) => p.id === 'r' && p.kind === 'endpoint').map((p) => [Math.round(p.p.x), Math.round(p.p.y)]);
    expect(corners).toContainEqual([-50, 100]);
  });
});

describe('object snaps', () => {
  const elements = table(line('a', [[0, 0], [1000, 0]]), line('b', [[500, -500], [500, 300]]));
  const geometry = draftGeometry(elements);

  it('snaps to endpoints, midpoints and intersections before nearest points', () => {
    expect(resolveSnap(geometry, { x: 997, y: 4 }, query())).toMatchObject({ kind: 'endpoint', point: { x: 1000, y: 0 } });
    expect(resolveSnap(geometry, { x: 503, y: -2 }, query())).toMatchObject({ kind: 'intersection', point: { x: 500, y: 0 } });
    expect(resolveSnap(geometry, { x: 503, y: -97 }, query()).kind).toBe('midpoint');
    expect(resolveSnap(geometry, { x: 700, y: 4 }, query())).toMatchObject({ kind: 'nearest', point: { x: 700, y: 0 } });
  });

  it('finds perpendicular feet, extensions, tracking and polar lines, then the grid', () => {
    expect(resolveSnap(geometry, { x: 300, y: 6 }, query({ anchor: { x: 300, y: 400 } }))).toMatchObject({ kind: 'perpendicular', point: { x: 300, y: 0 } });
    expect(resolveSnap(geometry, { x: 1300, y: 4 }, query())).toMatchObject({ kind: 'extension', point: { x: 1300, y: 0 } });
    const tracked = resolveSnap(geometry, { x: 2000, y: 1003 }, query({ trackPoints: [{ x: 3000, y: 1000 }] }));
    expect(tracked).toMatchObject({ kind: 'tracking', point: { x: 2000, y: 1000 } });
    const polar = resolveSnap(geometry, { x: 2600, y: -598 }, query({ anchor: { x: 2000, y: 0 }, settings: { ...DEFAULT_OSNAP, polar: 45 } }));
    expect(polar.kind).toBe('polar');
    expect(polar.point.x - 2000).toBeCloseTo(-(polar.point.y - 0), 6);
    expect(resolveSnap(geometry, { x: 5012, y: 5037 }, query({ gridStep: 50 }))).toMatchObject({ kind: 'grid', point: { x: 5000, y: 5050 } });
  });

  it('ignores excluded elements and switched-off kinds', () => {
    expect(resolveSnap(geometry, { x: 997, y: 4 }, query({ exclude: new Set(['a']) })).kind).toBeNull();
    expect(resolveSnap(geometry, { x: 997, y: 4 }, query({ settings: { ...DEFAULT_OSNAP, kinds: { ...DEFAULT_OSNAP.kinds, endpoint: false } } })).kind).toBe('nearest');
  });
});

describe('typed values', () => {
  it('parses lengths, polar, relative, absolute and sizes in the workspace unit', () => {
    expect(parseTyped('3000', 'mm')).toEqual({ kind: 'length', length: 3000 });
    expect(parseTyped('3<30', 'm')).toEqual({ kind: 'polar', length: 3000, angle: 30 });
    expect(parseTyped('@300,150', 'mm')).toEqual({ kind: 'relative', dx: 300, dy: -150 });
    expect(parseTyped('#10,20', 'cm')).toEqual({ kind: 'absolute', x: 100, y: -200 });
    expect(parseTyped('1200x800', 'mm')).toEqual({ kind: 'size', width: 1200, height: 800 });
    expect(parseTyped('abc', 'mm')).toBeNull();
    const up = typedPoint({ kind: 'polar', length: 100, angle: 90 }, { x: 0, y: 0 }, { x: 0, y: 0 })!;
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.y).toBeCloseTo(-100, 9);
    expect(typedPoint({ kind: 'length', length: 50 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toEqual({ x: 0, y: 50 });
  });
});

describe('shapes', () => {
  it('builds circles, 3-point and tangent arcs, polygons and ellipses', () => {
    const circle = circleFrom3({ x: 100, y: 0 }, { x: 0, y: 100 }, { x: -100, y: 0 })!;
    expect(circle.radius).toBeCloseTo(100, 9);
    const arc = arcThrough({ x: 100, y: 0 }, { x: 0, y: 100 }, { x: -100, y: 0 })!;
    const samples = sampleCurvePath(arc, 16);
    // Passes through the bottom (y down), not the top.
    expect(Math.max(...samples.map((p) => p[1]))).toBeCloseTo(100, 3);
    const tangent = arcTangent({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 100 })!;
    const first = sampleCurvePath(tangent, 64)[1]!;
    expect(first[0]).toBeGreaterThan(0);
    expect(Math.abs(first[1])).toBeLessThan(first[0]);
    expect(polygonPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)[1]!.y).toBeCloseTo(100, 9);
    const ellipse = sampleCurvePath(ellipsePath({ x: 0, y: 0 }, { x: 200, y: 0 }, 100), 32);
    expect(Math.max(...ellipse.map((p) => p[0]))).toBeCloseTo(200, 3);
    expect(Math.max(...ellipse.map((p) => p[1]))).toBeCloseTo(100, 1);
  });
});
