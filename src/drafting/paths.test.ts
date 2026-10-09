import { describe, expect, it } from 'vitest';
import { cornerPaths, extendPath, filletPath, joinPaths, locate, offsetPath, pathEnd, pathStart, samplePath, segIntersections, splitPath, trimPath, type Path, type PSeg } from './paths';

const line = (ax: number, ay: number, bx: number, by: number): PSeg => ({ kind: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const open = (...segs: PSeg[]): Path => ({ segs, closed: false });
const circle: Path = { segs: [{ kind: 'arc', c: { x: 0, y: 0 }, r: 100, start: 0, sweep: Math.PI * 2 }], closed: true };
const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 4);
  expect(p.y).toBeCloseTo(y, 4);
};

describe('path intersections', () => {
  it('finds line–arc, arc–arc and Bézier crossings', () => {
    const arc: PSeg = { kind: 'arc', c: { x: 0, y: 0 }, r: 100, start: 0, sweep: Math.PI };
    expect(segIntersections(line(-200, 50, 200, 50), arc).map((h) => Math.round(h.point.x)).sort((a, b) => a - b)).toEqual([-87, 87]);
    const cubic: PSeg = { kind: 'cubic', p0: { x: 0, y: 0 }, p1: { x: 0, y: 100 }, p2: { x: 100, y: 100 }, p3: { x: 100, y: 0 } };
    const hits = segIntersections(cubic, line(50, -10, 50, 200));
    expect(hits).toHaveLength(1);
    close(hits[0]!.point, 50, 75);
  });
});

describe('path editing', () => {
  it('trims an arc between two lines and a circle into the arc that remains', () => {
    const arc = open({ kind: 'arc', c: { x: 0, y: 0 }, r: 100, start: Math.PI, sweep: -Math.PI });
    const cutters = [line(-50, -200, -50, 200), line(50, -200, 50, 200)];
    // Sweeping from π down to 0 passes through angle π/2: the bottom (y down).
    const pieces = trimPath(arc, { x: 0, y: 100 }, cutters);
    expect(pieces).toHaveLength(2);
    close(pathEnd(pieces[0]!), -50, 86.6025);
    close(pathStart(pieces[1]!), 50, 86.6025);
    const ring = trimPath(circle, { x: 0, y: 100 }, cutters);
    expect(ring).toHaveLength(1);
    // What is left goes from one cut round the top to the other.
    const ys = samplePath(ring[0]!).map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(-100, 3);
    expect(Math.max(...ys)).toBeLessThan(90);
  });

  it('extends an arc along its circle to a boundary and splits a circle open', () => {
    const arc = open({ kind: 'arc', c: { x: 0, y: 0 }, r: 100, start: 0, sweep: Math.PI / 4 });
    const extended = extendPath(arc, { x: 70, y: 70 }, [line(-200, 100, 200, 100)])!;
    close(pathEnd(extended), 0, 100);
    const opened = splitPath(circle, { x: 0, y: 100 });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.closed).toBe(false);
    close(pathStart(opened[0]!), 0, 100);
  });

  it('makes a corner between an arc and a line', () => {
    const arc = open({ kind: 'arc', c: { x: 0, y: 0 }, r: 100, start: -Math.PI / 2, sweep: Math.PI / 4 });
    const result = cornerPaths(arc, { x: 0, y: -100 }, open(line(200, 0, 400, 0)), { x: 300, y: 0 })!;
    expect(result).not.toBeNull();
    close(pathEnd(result[0]), 100, 0);
    close(pathStart(result[1]), 100, 0);
  });

  it('offsets mixed paths and joins and fillets them', () => {
    const mixed = open(line(0, 0, 100, 0), { kind: 'arc', c: { x: 100, y: 100 }, r: 100, start: -Math.PI / 2, sweep: Math.PI / 2 });
    const inner = offsetPath(mixed, 20)!;
    // Left of travel (y down) is the arc's inside: its radius shrinks.
    const arc = inner.segs.find((s) => s.kind === 'arc')!;
    expect(arc.kind === 'arc' && arc.r).toBeCloseTo(80, 6);
    const joined = joinPaths([open(line(0, 0, 100, 0)), open(line(100, 100, 100, 0)), open(line(100, 100, 0, 0))]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.closed).toBe(true);
    const rounded = filletPath(open(line(0, 0, 100, 0), line(100, 0, 100, 100)), { x: 100, y: 0 }, 20, 'fillet')!;
    const bridge = rounded.segs.find((s) => s.kind === 'arc')!;
    expect(bridge.kind === 'arc' && bridge.r).toBeCloseTo(20, 4);
    close(locate(rounded, { x: 95, y: 5 }).point, 80 + 20 * Math.sin(Math.PI / 4), 20 - 20 * Math.cos(Math.PI / 4));
  });
});
