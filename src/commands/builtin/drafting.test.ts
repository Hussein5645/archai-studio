import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { Element, ElementTable, LineElement, RectElement } from '@/document';
import { orientedCorners, sampleCurvePath } from '@/geometry';
import { worldPolyline } from '@/drafting/lines';

const table = (app: ReturnType<typeof createTestApp>) => app.store.getState().doc.elements as ElementTable;
const el = <T extends Element>(app: ReturnType<typeof createTestApp>, id: string) => table(app)[id] as T;
const worldLine = (app: ReturnType<typeof createTestApp>, id: string) => worldPolyline(table(app), el<LineElement>(app, id))!.points.map(([x, y]) => [Math.round(x), Math.round(y)]);

describe('copy, mirror, scale, rotate-copy', () => {
  it('copies with a count along an offset', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const copies = run<string[]>(app, 'copy-by-offset', { ids: [id], dx: 200, dy: 0, count: 3 });
    expect(copies.map((c) => el<RectElement>(app, c).x)).toEqual([200, 400, 600]);
    expect(app.store.getState().ui.selection).toEqual(copies);
  });

  it('mirrors lines and rotated rectangles across an axis, keeping or replacing the originals', () => {
    const app = createTestApp();
    const line = run<string>(app, 'create-line', { points: [[100, 0], [300, 100]] });
    const box = run<string>(app, 'create-rect', { x: 100, y: 200, width: 200, height: 100, rotation: 30 });
    const before = orientedCorners(table(app), el(app, box)).map((p) => [Math.round(-p.x), Math.round(p.y)]);
    const [lineCopy, boxCopy] = run<string[]>(app, 'mirror-selection', { ids: [line, box], a: { x: 0, y: 0 }, b: { x: 0, y: 1000 } });
    expect(worldLine(app, lineCopy!)).toEqual([[-100, 0], [-300, 100]]);
    const after = orientedCorners(table(app), el(app, boxCopy!)).map((p) => [Math.round(p.x), Math.round(p.y)]);
    // Same four corners as the reflected original (in another order).
    expect(after.sort()).toEqual(before.sort());
    expect(table(app)[line]).toBeDefined();
    run(app, 'mirror-selection', { ids: [line], a: { x: 0, y: 50 }, b: { x: 1000, y: 50 }, keepOriginal: false });
    expect(worldLine(app, line)).toEqual([[100, 100], [300, 0]]);
  });

  it('scales about a base point and adds rotated copies', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 100, y: 100, width: 100, height: 50 });
    run(app, 'scale-selection', { ids: [id], base: { x: 0, y: 0 }, factor: 2 });
    expect(el<RectElement>(app, id)).toMatchObject({ x: 200, y: 200, width: 200, height: 100 });
    const [copy] = run<string[]>(app, 'rotate-copy-selection', { ids: [id], degrees: 90, pivot: { x: 0, y: 0 } });
    expect(el<RectElement>(app, copy!).rotation).toBe(90);
    expect(Math.round(el<RectElement>(app, copy!).x)).toBe(-200);
  });
});

describe('live arrays', () => {
  it('builds linear and polar arrays and rebuilds them when edited', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const array = run<string>(app, 'create-array', { ids: [id], spec: { kind: 'linear', count: 4, dx: 300, dy: 0 } });
    const members = () => Object.values(table(app)).filter((e) => e.parentId === array);
    expect(members()).toHaveLength(4);
    run(app, 'set-array', { id: array, count: 6, dx: 150 });
    expect(members()).toHaveLength(6);
    const xs = members().map((m) => Math.round(orientedCorners(table(app), m)[0]!.x)).sort((a, b) => a - b);
    expect(xs).toEqual([0, 150, 300, 450, 600, 750]);
    run(app, 'explode-selection', { ids: [array] });
    expect(table(app)[array]).toBeUndefined();
    expect(Object.values(table(app)).filter((e) => e.meta?.['arrayCopy'])).toHaveLength(0);

    const seat = run<string>(app, 'create-rect', { x: 1000, y: -50, width: 100, height: 100 });
    const ring = run<string>(app, 'create-array', { ids: [seat], spec: { kind: 'polar', count: 4, cx: 0, cy: 0, angle: 360 } });
    const rotations = Object.values(table(app)).filter((e) => e.parentId === ring).map((e) => Math.round(((e.rotation % 360) + 360) % 360)).sort((a, b) => a - b);
    expect(rotations).toEqual([0, 90, 180, 270]);
  });
});

describe('offset, trim, extend, split, corner, fillet, join, explode', () => {
  it('offsets polylines to the picked side, circles and rectangles in or out', () => {
    const app = createTestApp();
    const line = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]] });
    const copy = run<string>(app, 'offset-element', { id: line, distance: 100, toward: { x: 500, y: 300 } });
    expect(worldLine(app, copy)).toEqual([[0, 100], [1000, 100]]);
    const circle = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], closed: true, path: { start: [500, 0], segments: [{ kind: 'arc', center: [0, 0], radius: 500, startAngle: 0, endAngle: Math.PI * 2, clockwise: false }] } });
    const inner = run<string>(app, 'offset-element', { id: circle, distance: 100, toward: { x: 0, y: 10 } });
    const arc = el<LineElement>(app, inner).path!.segments[0]!;
    expect(arc.kind === 'arc' && arc.radius).toBe(400);
    const box = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 500 });
    const grown = run<string>(app, 'offset-element', { id: box, distance: 50, toward: { x: -200, y: 0 } });
    expect(el<RectElement>(app, grown)).toMatchObject({ x: -50, y: -50, width: 1100, height: 600 });
  });

  it('trims between crossings, makes corners, extends, splits and joins', () => {
    const app = createTestApp();
    const target = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]] });
    run<string>(app, 'create-line', { points: [[300, -100], [300, 100]] });
    run<string>(app, 'create-line', { points: [[700, -100], [700, 100]] });
    const pieces = run<string[]>(app, 'trim-line', { id: target, at: { x: 500, y: 0 } });
    expect(pieces.map((p) => worldLine(app, p))).toEqual([[[0, 0], [300, 0]], [[700, 0], [1000, 0]]]);

    const a = run<string>(app, 'create-line', { points: [[0, 2000], [1200, 2000]] });
    const b = run<string>(app, 'create-line', { points: [[1000, 1900], [1000, 2800]] });
    run(app, 'corner-lines', { a, atA: { x: 100, y: 2000 }, b, atB: { x: 1000, y: 2500 } });
    expect(worldLine(app, a)).toEqual([[0, 2000], [1000, 2000]]);
    expect(worldLine(app, b)).toEqual([[1000, 2000], [1000, 2800]]);

    const short = run<string>(app, 'create-line', { points: [[0, 4000], [500, 4000]] });
    const wall = run<string>(app, 'create-line', { points: [[2000, 3500], [2000, 4500]] });
    run(app, 'extend-line', { id: short, at: { x: 500, y: 4000 }, boundaryId: wall });
    expect(worldLine(app, short)).toEqual([[0, 4000], [2000, 4000]]);
    const halves = run<string[]>(app, 'split-line', { id: short, at: { x: 800, y: 4003 } });
    expect(halves).toHaveLength(2);
    const joined = run<string[]>(app, 'join-lines', { ids: halves });
    expect(joined).toHaveLength(1);
    expect(worldLine(app, joined[0]!)).toEqual([[0, 4000], [800, 4000], [2000, 4000]]);
  });

  it('fillets the corner of two lines into one polyline with an exact arc', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]] });
    const b = run<string>(app, 'create-line', { points: [[1000, 0], [1000, 1000]] });
    run(app, 'fillet-lines', { id: a, otherId: b, at: { x: 1000, y: 0 }, size: 200 });
    expect(table(app)[b]).toBeUndefined();
    const line = el<LineElement>(app, a);
    const arc = line.path!.segments.find((s) => s.kind === 'arc')!;
    expect(arc.kind === 'arc' && arc.radius).toBeCloseTo(200, 6);
    // Every sampled point of the arc stays 200 from the fillet centre (800, 200).
    const samples = sampleCurvePath(line.path!, 16).map(([x, y]) => [x + line.x, y + line.y]);
    const onArc = samples.filter(([x, y]) => x! > 800 && y! < 200);
    for (const [x, y] of onArc) expect(Math.hypot(x! - 800, y! - 200)).toBeCloseTo(200, 3);
  });

  it('explodes rectangles into lines, aligns and distributes, and matches properties', () => {
    const app = createTestApp();
    const box = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 50 });
    const lines = run<string[]>(app, 'explode-selection', { ids: [box] });
    expect(lines).toHaveLength(4);
    expect(worldLine(app, lines[1]!)).toEqual([[100, 0], [100, 50]]);

    const r1 = run<string>(app, 'create-rect', { x: 0, y: 1000, width: 100, height: 100 });
    const r2 = run<string>(app, 'create-rect', { x: 500, y: 1100, width: 100, height: 100 });
    const r3 = run<string>(app, 'create-rect', { x: 2000, y: 1300, width: 100, height: 100 });
    run(app, 'align-selection', { ids: [r1, r2, r3], edge: 'top' });
    expect([r1, r2, r3].map((id) => el<RectElement>(app, id).y)).toEqual([1000, 1000, 1000]);
    run(app, 'distribute-selection', { ids: [r3, r1, r2], axis: 'horizontal' });
    expect(el<RectElement>(app, r2).x).toBe(1000);

    run(app, 'set-property', { ids: [r1], key: 'stroke', value: '#ff0000' });
    run(app, 'set-property', { ids: [r1], key: 'strokeWidth', value: 30 });
    run(app, 'match-properties', { sourceId: r1, ids: [r3] });
    expect(el<RectElement>(app, r3).style).toMatchObject({ stroke: '#ff0000', strokeWidth: 30 });
  });
});

describe('grips, similar, filter, repeat', () => {
  it('moves line vertices and segments with connected ends following, and sets lengths and radii', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]] });
    const b = run<string>(app, 'create-line', { points: [[1000, 0], [1000, 1000]] });
    run(app, 'move-line-vertex', { id: a, index: 1, x: 1200, y: 100 });
    expect(worldLine(app, a)).toEqual([[0, 0], [1200, 100]]);
    expect(worldLine(app, b)).toEqual([[1200, 100], [1000, 1000]]);
    run(app, 'move-line-segment', { id: b, segment: 0, dx: 100, dy: 0 });
    expect(worldLine(app, b)).toEqual([[1300, 100], [1100, 1000]]);
    expect(worldLine(app, a)).toEqual([[0, 0], [1300, 100]]);
    const c = run<string>(app, 'create-line', { points: [[0, 5000], [300, 5400]] });
    run(app, 'set-line-length', { id: c, length: 1000 });
    expect(worldLine(app, c)).toEqual([[0, 5000], [600, 5800]]);
    run(app, 'set-line-length', { id: c, length: 100, angle: 90 });
    expect(worldLine(app, c)).toEqual([[0, 5000], [0, 4900]]);
    const circle = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], closed: true, path: { start: [500, 0], segments: [{ kind: 'arc', center: [0, 0], radius: 500, startAngle: 0, endAngle: Math.PI * 2, clockwise: false }] } });
    run(app, 'set-line-radius', { id: circle, radius: 800 });
    const arc = el<LineElement>(app, circle).path!.segments[0]!;
    expect(arc.kind === 'arc' && arc.radius).toBe(800);
  });

  it('selects similar elements, filters the selection and repeats the last tool', () => {
    const app = createTestApp();
    const r1 = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const r2 = run<string>(app, 'create-rect', { x: 2000, y: 0 });
    const l1 = run<string>(app, 'create-line', { points: [[0, 0], [10, 10]] });
    run(app, 'select', { ids: [r1] });
    expect(run<string[]>(app, 'select-similar').sort()).toEqual([r1, r2].sort());
    run(app, 'select', { ids: [r1, r2, l1] });
    expect(run<string[]>(app, 'filter-selection', { keep: ['line'] })).toEqual([l1]);
    run(app, 'set-tool', { tool: 'modify:mirror' });
    run(app, 'set-tool', { tool: 'select' });
    run(app, 'select', { ids: [] });
    run(app, 'repeat-last-tool');
    expect(app.store.getState().ui.tool).toBe('modify:mirror');
  });
});

describe('curved lines', () => {
  const circlePath = (r: number) => ({ start: [r, 0] as [number, number], segments: [{ kind: 'arc' as const, center: [0, 0] as [number, number], radius: r, startAngle: 0, endAngle: Math.PI * 2, clockwise: false }] });
  it('trims a circle between two lines, extends and splits arcs, and offsets curves', () => {
    const app = createTestApp();
    const circle = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], closed: true, path: circlePath(1000) });
    run<string>(app, 'create-line', { points: [[-500, -2000], [-500, 2000]] });
    run<string>(app, 'create-line', { points: [[500, -2000], [500, 2000]] });
    const [arcId] = run<string[]>(app, 'trim-line', { id: circle, at: { x: 0, y: 1000 } });
    const trimmed = el<LineElement>(app, arcId!);
    expect(trimmed.closed).toBe(false);
    expect(trimmed.path!.segments[0]!.kind).toBe('arc');
    // The kept arc goes round the top and never reaches the bottom.
    const ys = sampleCurvePath(trimmed.path!, 32).map(([, y]) => y + trimmed.y);
    expect(Math.max(...ys)).toBeLessThan(900);

    const pieces = run<string[]>(app, 'split-line', { id: arcId, at: { x: 0, y: -1000 } });
    expect(pieces).toHaveLength(2);

    const quarter = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], path: { start: [3000, 0], segments: [{ kind: 'arc', center: [2000, 0], radius: 1000, startAngle: 0, endAngle: Math.PI / 4, clockwise: false }] } });
    const floor = run<string>(app, 'create-line', { points: [[1000, 1000], [3000, 1000]] });
    run(app, 'extend-line', { id: quarter, at: { x: 2700, y: 700 }, boundaryId: floor });
    const extended = el<LineElement>(app, quarter);
    const pts = sampleCurvePath(extended.path!, 32);
    const end = pts.at(-1)!;
    expect(end[0] + extended.x).toBeCloseTo(2000, 3);
    expect(end[1] + extended.y).toBeCloseTo(1000, 3);

    const ring = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], closed: true, path: circlePath(500) });
    const inner = run<string>(app, 'offset-element', { id: ring, distance: 100, toward: { x: 0, y: 50 } });
    const arc = el<LineElement>(app, inner).path!.segments[0]!;
    expect(arc.kind === 'arc' && arc.radius).toBeCloseTo(400, 6);
  });

  it('fillets where a line meets an arc and explodes curves into pieces', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-line', { points: [[0, 0], [1, 1]], path: { start: [0, 0], segments: [{ kind: 'line', to: [1000, 0] }, { kind: 'arc', center: [1000, 1000], radius: 1000, startAngle: -Math.PI / 2, endAngle: 0, clockwise: false }] } });
    // A smooth (tangent) junction has no corner to round.
    expect(() => run(app, 'fillet-lines', { id: a, at: { x: 1000, y: 0 }, size: 100 })).toThrow(/too straight/);
    const b = run<string>(app, 'create-line', { points: [[0, 3000], [1000, 3000], [1000, 4000]] });
    run(app, 'fillet-lines', { id: b, at: { x: 1000, y: 3000 }, size: 200 });
    const rounded = el<LineElement>(app, b);
    expect(rounded.path!.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line']);
    const pieces = run<string[]>(app, 'explode-selection', { ids: [b] });
    expect(pieces).toHaveLength(3);
    expect(pieces.map((id) => el<LineElement>(app, id).path?.segments[0]?.kind ?? 'line')).toEqual(['line', 'arc', 'line']);
  });
});
