/**
 * World-space path geometry for editing drawn curves: a path is a chain of line, circular-arc
 * and cubic Bézier segments. It supports locating a point, splitting and sub-paths (with
 * extension of end lines and arcs), intersections (exact for lines and arcs, refined numerically
 * for Béziers), offsets, joining and reversing — the maths behind trim, extend, split, corner,
 * fillet, offset and join on any drawn curve. Pure.
 */
import type { Vec2 } from '@/geometry';

export type PSeg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** Arc of radius r about c from angle `start`, sweeping `sweep` radians (sign = direction). */
  | { kind: 'arc'; c: Vec2; r: number; start: number; sweep: number }
  | { kind: 'cubic'; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

export interface Path {
  segs: PSeg[];
  closed: boolean;
}

const TAU = Math.PI * 2;
const EPS = 1e-6;

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

// ---- single segments ------------------------------------------------------------------------

export function segPoint(seg: PSeg, t: number): Vec2 {
  switch (seg.kind) {
    case 'line':
      return lerp(seg.a, seg.b, t);
    case 'arc': {
      const angle = seg.start + seg.sweep * t;
      return { x: seg.c.x + Math.cos(angle) * seg.r, y: seg.c.y + Math.sin(angle) * seg.r };
    }
    case 'cubic': {
      const u = 1 - t;
      return {
        x: u * u * u * seg.p0.x + 3 * u * u * t * seg.p1.x + 3 * u * t * t * seg.p2.x + t * t * t * seg.p3.x,
        y: u * u * u * seg.p0.y + 3 * u * u * t * seg.p1.y + 3 * u * t * t * seg.p2.y + t * t * t * seg.p3.y,
      };
    }
  }
}

export const segStart = (seg: PSeg) => segPoint(seg, 0);
export const segEnd = (seg: PSeg) => segPoint(seg, 1);

/** Unit tangent (direction of travel) at t. */
export function segTangent(seg: PSeg, t: number): Vec2 {
  let d: Vec2;
  switch (seg.kind) {
    case 'line':
      d = { x: seg.b.x - seg.a.x, y: seg.b.y - seg.a.y };
      break;
    case 'arc': {
      const angle = seg.start + seg.sweep * t;
      const s = Math.sign(seg.sweep) || 1;
      d = { x: -Math.sin(angle) * s, y: Math.cos(angle) * s };
      break;
    }
    case 'cubic': {
      const u = 1 - t;
      d = {
        x: 3 * u * u * (seg.p1.x - seg.p0.x) + 6 * u * t * (seg.p2.x - seg.p1.x) + 3 * t * t * (seg.p3.x - seg.p2.x),
        y: 3 * u * u * (seg.p1.y - seg.p0.y) + 6 * u * t * (seg.p2.y - seg.p1.y) + 3 * t * t * (seg.p3.y - seg.p2.y),
      };
      if (Math.hypot(d.x, d.y) < EPS) d = { x: seg.p3.x - seg.p0.x, y: seg.p3.y - seg.p0.y };
      break;
    }
  }
  const len = Math.hypot(d.x, d.y) || 1;
  return { x: d.x / len, y: d.y / len };
}

/**
 * The part of a segment between t0 and t1 (t0 > t1 reverses it). Lines and arcs may go past
 * [0, 1] (extension); Béziers are clamped.
 */
export function segSub(seg: PSeg, t0: number, t1: number): PSeg {
  switch (seg.kind) {
    case 'line':
      return { kind: 'line', a: lerp(seg.a, seg.b, t0), b: lerp(seg.a, seg.b, t1) };
    case 'arc':
      return { kind: 'arc', c: seg.c, r: seg.r, start: seg.start + seg.sweep * t0, sweep: seg.sweep * (t1 - t0) };
    case 'cubic': {
      const a = Math.max(0, Math.min(1, t0));
      const b = Math.max(0, Math.min(1, t1));
      if (a > b) return segReverse(segSub(seg, b, a));
      // Two de Casteljau splits.
      const [, right] = splitCubic(seg, a);
      const local = a < 1 ? (b - a) / (1 - a) : 0;
      return splitCubic(right, local)[0];
    }
  }
}

function splitCubic(seg: Extract<PSeg, { kind: 'cubic' }>, t: number): [Extract<PSeg, { kind: 'cubic' }>, Extract<PSeg, { kind: 'cubic' }>] {
  const p01 = lerp(seg.p0, seg.p1, t);
  const p12 = lerp(seg.p1, seg.p2, t);
  const p23 = lerp(seg.p2, seg.p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p = lerp(p012, p123, t);
  return [
    { kind: 'cubic', p0: seg.p0, p1: p01, p2: p012, p3: p },
    { kind: 'cubic', p0: p, p1: p123, p2: p23, p3: seg.p3 },
  ];
}

export function segReverse(seg: PSeg): PSeg {
  switch (seg.kind) {
    case 'line':
      return { kind: 'line', a: seg.b, b: seg.a };
    case 'arc':
      return { kind: 'arc', c: seg.c, r: seg.r, start: seg.start + seg.sweep, sweep: -seg.sweep };
    case 'cubic':
      return { kind: 'cubic', p0: seg.p3, p1: seg.p2, p2: seg.p1, p3: seg.p0 };
  }
}

/** Nearest point of a segment to p: parameter (clamped to the segment) and distance. */
export function segNearest(seg: PSeg, p: Vec2): { t: number; point: Vec2; distance: number } {
  switch (seg.kind) {
    case 'line': {
      const dx = seg.b.x - seg.a.x;
      const dy = seg.b.y - seg.a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / len2));
      const point = lerp(seg.a, seg.b, t);
      return { t, point, distance: dist(point, p) };
    }
    case 'arc': {
      const t = Math.max(0, Math.min(1, arcParam(seg, Math.atan2(p.y - seg.c.y, p.x - seg.c.x))));
      const point = segPoint(seg, t);
      return { t, point, distance: dist(point, p) };
    }
    case 'cubic': {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i <= 32; i++) {
        const d = dist(segPoint(seg, i / 32), p);
        if (d < bestD) {
          bestD = d;
          best = i / 32;
        }
      }
      const t = refine((t) => dist(segPoint(seg, t), p), Math.max(0, best - 1 / 32), Math.min(1, best + 1 / 32));
      const point = segPoint(seg, t);
      return { t, point, distance: dist(point, p) };
    }
  }
}

/** Golden-section minimum of f on [a, b]. */
function refine(f: (t: number) => number, a: number, b: number): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a);
  let x2 = a + g * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < 40; i++) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - g * (b - a);
      f1 = f(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + g * (b - a);
      f2 = f(x2);
    }
  }
  return (a + b) / 2;
}

/**
 * The arc parameter of an angle: 0 at the start, 1 at the end; angles off the arc give the
 * nearer overshoot (negative before the start, above 1 past the end), for extensions.
 */
export function arcParam(seg: Extract<PSeg, { kind: 'arc' }>, angle: number): number {
  const s = Math.sign(seg.sweep) || 1;
  let d = ((angle - seg.start) * s) % TAU;
  if (d < 0) d += TAU;
  const span = Math.abs(seg.sweep);
  if (d <= span + EPS) return d / span;
  // Past the end or before the start, whichever is nearer.
  const past = d - span;
  const before = TAU - d;
  return past < before ? 1 + past / span : -before / span;
}

// ---- intersections ----------------------------------------------------------------------------

/**
 * Parameters on `seg` where it meets `other`. With `extend`, lines are infinite and arcs full
 * circles on `seg` (parameters may leave [0, 1]); `other` is taken as drawn (or extended too
 * when `extendOther`).
 */
export function segIntersections(seg: PSeg, other: PSeg, extend = false, extendOther = false): { t: number; point: Vec2 }[] {
  const onOther = (p: Vec2) => {
    if (extendOther) return true;
    return segNearest(other, p).distance < 1e-4 * Math.max(1, sizeOf(other));
  };
  const result: { t: number; point: Vec2 }[] = [];
  const push = (t: number, point: Vec2) => {
    if (!extend && (t < -EPS || t > 1 + EPS)) return;
    if (!onOther(point)) return;
    if (result.some((r) => dist(r.point, point) < 1e-6)) return;
    result.push({ t, point });
  };
  if (seg.kind === 'cubic' || other.kind === 'cubic') {
    // Sample, then refine each crossing by minimising the distance to the other curve.
    const n = seg.kind === 'cubic' ? 48 : 1;
    const pieces: PSeg[] = seg.kind === 'cubic' ? Array.from({ length: n }, (_, i) => ({ kind: 'line', a: segPoint(seg, i / n), b: segPoint(seg, (i + 1) / n) }) as PSeg) : [seg];
    const others: PSeg[] = other.kind === 'cubic' ? Array.from({ length: 48 }, (_, i) => ({ kind: 'line', a: segPoint(other, i / 48), b: segPoint(other, (i + 1) / 48) }) as PSeg) : [other];
    pieces.forEach((piece, i) => {
      for (const o of others) {
        for (const hit of exactIntersections(piece, o, seg.kind !== 'cubic' && extend)) {
          if (hit.t < -EPS || hit.t > 1 + EPS) {
            if (!(seg.kind !== 'cubic' && extend)) continue;
          }
          const tGuess = seg.kind === 'cubic' ? (i + Math.max(0, Math.min(1, hit.t))) / n : hit.t;
          const t = seg.kind === 'cubic' ? refine((t) => segNearest(other, segPoint(seg, t)).distance, Math.max(0, tGuess - 1 / n), Math.min(1, tGuess + 1 / n)) : tGuess;
          const point = segPoint(seg, t);
          const near = segNearest(other, point);
          if (near.distance < 1e-3 * Math.max(1, sizeOf(other))) push(t, other.kind === 'cubic' ? point : near.point);
          else if (seg.kind !== 'cubic') push(t, point);
        }
      }
    });
    return result;
  }
  for (const hit of exactIntersections(seg, other, extend)) push(hit.t, hit.point);
  return result;
}

function sizeOf(seg: PSeg): number {
  switch (seg.kind) {
    case 'line':
      return dist(seg.a, seg.b);
    case 'arc':
      return seg.r;
    case 'cubic':
      return dist(seg.p0, seg.p3) + dist(seg.p0, seg.p1);
  }
}

/** Line / arc intersections; `extend` treats `seg` as infinite line / full circle. */
function exactIntersections(seg: PSeg, other: PSeg, extend: boolean): { t: number; point: Vec2 }[] {
  const out: { t: number; point: Vec2 }[] = [];
  if (seg.kind === 'line' && other.kind === 'line') {
    const d1 = { x: seg.b.x - seg.a.x, y: seg.b.y - seg.a.y };
    const d2 = { x: other.b.x - other.a.x, y: other.b.y - other.a.y };
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-12) return out;
    const e = { x: other.a.x - seg.a.x, y: other.a.y - seg.a.y };
    const t = (e.x * d2.y - e.y * d2.x) / denom;
    out.push({ t, point: { x: seg.a.x + d1.x * t, y: seg.a.y + d1.y * t } });
    return out;
  }
  if (seg.kind === 'line' && other.kind === 'arc') {
    for (const p of lineCircle(seg.a, seg.b, other.c, other.r)) {
      const t = Math.abs(seg.b.x - seg.a.x) > Math.abs(seg.b.y - seg.a.y) ? (p.x - seg.a.x) / (seg.b.x - seg.a.x) : (p.y - seg.a.y) / (seg.b.y - seg.a.y);
      out.push({ t, point: p });
    }
    return out;
  }
  if (seg.kind === 'arc' && other.kind === 'line') {
    for (const p of lineCircle(other.a, other.b, seg.c, seg.r)) {
      const t = arcParam(seg, Math.atan2(p.y - seg.c.y, p.x - seg.c.x));
      if (!extend && (t < -EPS || t > 1 + EPS)) continue;
      out.push({ t, point: p });
    }
    return out;
  }
  if (seg.kind === 'arc' && other.kind === 'arc') {
    const d = dist(seg.c, other.c);
    if (d < EPS || d > seg.r + other.r + EPS || d < Math.abs(seg.r - other.r) - EPS) return out;
    const along = (seg.r * seg.r - other.r * other.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, seg.r * seg.r - along * along));
    const ux = (other.c.x - seg.c.x) / d;
    const uy = (other.c.y - seg.c.y) / d;
    const mx = seg.c.x + ux * along;
    const my = seg.c.y + uy * along;
    for (const p of [{ x: mx - uy * h, y: my + ux * h }, { x: mx + uy * h, y: my - ux * h }]) {
      out.push({ t: arcParam(seg, Math.atan2(p.y - seg.c.y, p.x - seg.c.x)), point: p });
    }
  }
  return out;
}

/** Points where the infinite line a→b meets a circle. */
function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-12 || disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)].map((t) => ({ x: a.x + dx * t, y: a.y + dy * t }));
}

// ---- paths ------------------------------------------------------------------------------------

/** Nearest place on a path: segment index, parameter, global position s = index + t. */
export function locate(path: Path, p: Vec2): { index: number; t: number; s: number; point: Vec2; distance: number } {
  let best = { index: 0, t: 0, s: 0, point: segStart(path.segs[0]!), distance: Infinity };
  path.segs.forEach((seg, index) => {
    const near = segNearest(seg, p);
    if (near.distance < best.distance) best = { index, t: near.t, s: index + near.t, point: near.point, distance: near.distance };
  });
  return best;
}

export function pathStart(path: Path): Vec2 {
  return segStart(path.segs[0]!);
}

export function pathEnd(path: Path): Vec2 {
  return segEnd(path.segs.at(-1)!);
}

/**
 * The open sub-path between global positions s0 < s1. On a closed path s1 may exceed the segment
 * count (it wraps). On an open path s0 < 0 or s1 > n extends the first / last segment.
 */
export function subPath(path: Path, s0: number, s1: number): Path {
  const n = path.segs.length;
  const segs: PSeg[] = [];
  const at = (s: number) => {
    const wrapped = path.closed ? ((s % n) + n) % n : s;
    const index = Math.max(0, Math.min(n - 1, Math.floor(wrapped)));
    return { index, t: wrapped - index };
  };
  if (!path.closed) {
    const a = at(s0);
    const b = at(s1);
    // Extensions: positions outside [0, n] stay on the end segments.
    const ta = s0 < 0 ? s0 : a.t;
    const tb = s1 > n ? s1 - (n - 1) : b.t;
    if (a.index === b.index) segs.push(segSub(path.segs[a.index]!, ta, s1 > n ? tb : b.t));
    else {
      segs.push(segSub(path.segs[a.index]!, ta, 1));
      for (let i = a.index + 1; i < b.index; i++) segs.push(path.segs[i]!);
      segs.push(segSub(path.segs[b.index]!, 0, tb));
    }
    return { segs: segs.filter((seg) => sizeOf(seg) > EPS || seg.kind === 'arc'), closed: false };
  }
  let s = s0;
  while (s < s1 - EPS) {
    const { index, t } = at(s);
    const segEndS = s + (1 - t);
    const stop = Math.min(segEndS, s1);
    segs.push(segSub(path.segs[index]!, t, t + (stop - s)));
    s = stop;
  }
  return { segs: segs.filter((seg) => sizeOf(seg) > EPS), closed: false };
}

export function reversePath(path: Path): Path {
  return { segs: [...path.segs].reverse().map(segReverse), closed: path.closed };
}

/** Global positions on `path` where it crosses any of the `cutters`. */
export function cuts(path: Path, cutters: readonly PSeg[]): number[] {
  const out: number[] = [];
  path.segs.forEach((seg, index) => {
    for (const cutter of cutters) for (const hit of segIntersections(seg, cutter)) out.push(index + hit.t);
  });
  return out.sort((a, b) => a - b);
}

/**
 * Trim: removes the piece of a path between the nearest cuts on either side of the pick; the
 * rest comes back as open paths (none when nothing is left).
 */
export function trimPath(path: Path, pick: Vec2, cutters: readonly PSeg[]): Path[] {
  const n = path.segs.length;
  const at = locate(path, pick).s;
  const all = cuts(path, cutters).filter((s, i, list) => i === 0 || s - list[i - 1]! > 1e-7);
  if (path.closed) {
    if (all.length < 2) return [];
    const before = [...all].reverse().find((s) => s < at - EPS) ?? all.at(-1)!;
    const after = all.find((s) => s > at + EPS) ?? all[0]!;
    // Keep from `after` round to `before`.
    return [subPath(path, after, before > after ? before : before + n)];
  }
  const before = [...all].reverse().find((s) => s < at - EPS && s > EPS);
  const after = all.find((s) => s > at + EPS && s < n - EPS);
  const pieces: Path[] = [];
  if (before !== undefined) pieces.push(subPath(path, 0, before));
  if (after !== undefined) pieces.push(subPath(path, after, n));
  return pieces;
}

/** Splits a path at the point nearest `p`; a closed path opens there. */
export function splitPath(path: Path, p: Vec2): Path[] {
  const n = path.segs.length;
  const s = locate(path, p).s;
  if (path.closed) return [subPath(path, s, s + n)];
  if (s < EPS || s > n - EPS) return [path];
  return [subPath(path, 0, s), subPath(path, s, n)];
}

/**
 * Extends (or trims back) the end of an open path nearest `pick` along its end line or arc to
 * the nearest place it meets the boundary. Null when it never does.
 */
export function extendPath(path: Path, pick: Vec2, boundary: readonly PSeg[]): Path | null {
  if (path.closed) return null;
  const n = path.segs.length;
  const atEnd = dist(pick, pathEnd(path)) <= dist(pick, pathStart(path));
  const seg = atEnd ? path.segs[n - 1]! : path.segs[0]!;
  if (seg.kind === 'cubic') return null;
  let best: number | null = null;
  for (const other of boundary) {
    for (const hit of segIntersections(seg, other, true)) {
      // Forward beyond (or back within) the picked end only.
      const valid = atEnd ? hit.t > EPS : hit.t < 1 - EPS;
      if (!valid) continue;
      const reach = atEnd ? hit.t - 1 : -hit.t;
      if (best === null || Math.abs(reach) < Math.abs(atEnd ? best - 1 : -best)) best = hit.t;
    }
  }
  if (best === null) return null;
  return atEnd ? subPath(path, 0, n - 1 + best) : subPath(path, best, n);
}

/**
 * Trim / extend two paths to the corner where their picked end parts meet (lines and arcs are
 * extended as needed). The picks choose which side of the corner each path keeps.
 */
export function cornerPaths(a: Path, pickA: Vec2, b: Path, pickB: Vec2): [Path, Path] | null {
  if (a.closed || b.closed) return null;
  const la = locate(a, pickA);
  const lb = locate(b, pickB);
  const sa = a.segs[la.index]!;
  const sb = b.segs[lb.index]!;
  const hits = segIntersections(sa, sb, true, true);
  if (!hits.length) return null;
  // The corner nearest to both picks.
  const mid = { x: (pickA.x + pickB.x) / 2, y: (pickA.y + pickB.y) / 2 };
  const hit = hits.sort((p, q) => dist(p.point, mid) - dist(q.point, mid))[0]!;
  const tb = segIntersections(sb, sa, true, true).sort((p, q) => dist(p.point, hit.point) - dist(q.point, hit.point))[0];
  if (!tb) return null;
  const cut = (path: Path, index: number, t: number, pickS: number): Path | null => {
    const s = index + t;
    const n = path.segs.length;
    // Extension past a segment is only possible at the path's own end.
    if ((t > 1 + EPS && index !== n - 1) || (t < -EPS && index !== 0)) return null;
    return pickS < s ? subPath(path, 0, s) : subPath(path, s, n);
  };
  const ra = cut(a, la.index, hit.t, la.s);
  const rb = cut(b, lb.index, tb.t, lb.s);
  return ra && rb ? [ra, rb] : null;
}

/** Offsets a path by `d` to the left of its direction of travel (negative = right). */
export function offsetPath(path: Path, d: number): Path | null {
  const segs: PSeg[] = [];
  for (const seg of path.segs) {
    if (seg.kind === 'line') {
      const t = segTangent(seg, 0);
      const n = { x: -t.y * d, y: t.x * d };
      segs.push({ kind: 'line', a: { x: seg.a.x + n.x, y: seg.a.y + n.y }, b: { x: seg.b.x + n.x, y: seg.b.y + n.y } });
    } else if (seg.kind === 'arc') {
      const r = seg.r - d * (Math.sign(seg.sweep) || 1);
      if (r <= EPS) return null;
      segs.push({ ...seg, r });
    } else {
      // Tiller–Hanson: offset each leg of the control polygon, re-intersect the inner legs.
      const legs = [[seg.p0, seg.p1], [seg.p1, seg.p2], [seg.p2, seg.p3]].map(([p, q]) => {
        const len = dist(p!, q!) || 1;
        const n = { x: (-(q!.y - p!.y) / len) * d, y: ((q!.x - p!.x) / len) * d };
        return [{ x: p!.x + n.x, y: p!.y + n.y }, { x: q!.x + n.x, y: q!.y + n.y }] as [Vec2, Vec2];
      });
      const meet = (l: [Vec2, Vec2], m: [Vec2, Vec2]) => exactIntersections({ kind: 'line', a: l[0], b: l[1] }, { kind: 'line', a: m[0], b: m[1] }, true)[0]?.point ?? l[1];
      segs.push({ kind: 'cubic', p0: legs[0]![0], p1: meet(legs[0]!, legs[1]!), p2: meet(legs[1]!, legs[2]!), p3: legs[2]![1] });
    }
  }
  // Close the gaps at corners: meet two lines at their intersection, otherwise a short line.
  const joined: PSeg[] = [];
  const count = segs.length;
  for (let i = 0; i < count; i++) {
    let seg = segs[i]!;
    const prev = joined.at(-1);
    if (prev) {
      const gap = dist(segEnd(prev), segStart(seg));
      if (gap > 1e-6) {
        if (prev.kind === 'line' && seg.kind === 'line') {
          const hit = exactIntersections(prev, seg, true)[0];
          if (hit) {
            joined[joined.length - 1] = { kind: 'line', a: prev.a, b: hit.point };
            seg = { kind: 'line', a: hit.point, b: seg.b };
          } else joined.push({ kind: 'line', a: segEnd(prev), b: segStart(seg) });
        } else joined.push({ kind: 'line', a: segEnd(prev), b: segStart(seg) });
      }
    }
    joined.push(seg);
  }
  if (path.closed && joined.length > 1) {
    const first = joined[0]!;
    const last = joined.at(-1)!;
    if (dist(segEnd(last), segStart(first)) > 1e-6 && first.kind === 'line' && last.kind === 'line') {
      const hit = exactIntersections(last, first, true)[0];
      if (hit) {
        joined[joined.length - 1] = { kind: 'line', a: last.a, b: hit.point };
        joined[0] = { kind: 'line', a: hit.point, b: first.b };
      }
    }
  }
  return { segs: joined, closed: path.closed };
}

/** Joins open paths that meet end to end (reversing as needed); a chain back to its start closes. */
export function joinPaths(paths: readonly Path[], tolerance = 1e-3): Path[] {
  const pool = paths.filter((p) => !p.closed).map((p) => ({ segs: [...p.segs], closed: false }));
  const out: Path[] = paths.filter((p) => p.closed);
  while (pool.length) {
    let chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i]!;
        const head = pathStart(chain);
        const tail = pathEnd(chain);
        let next: Path | null = null;
        if (dist(tail, pathStart(other)) < tolerance) next = { segs: [...chain.segs, ...other.segs], closed: false };
        else if (dist(tail, pathEnd(other)) < tolerance) next = { segs: [...chain.segs, ...reversePath(other).segs], closed: false };
        else if (dist(head, pathEnd(other)) < tolerance) next = { segs: [...other.segs, ...chain.segs], closed: false };
        else if (dist(head, pathStart(other)) < tolerance) next = { segs: [...reversePath(other).segs, ...chain.segs], closed: false };
        if (next) {
          chain = next;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (chain.segs.length > 1 && dist(pathStart(chain), pathEnd(chain)) < tolerance) chain.closed = true;
    out.push(chain);
  }
  return out;
}

/**
 * Rounds (or bevels) the junction of a path nearest `at` with `size`: exact for two lines;
 * where a curve meets, both sides are cut back along their curves and joined by a tangent arc.
 */
export function filletPath(path: Path, at: Vec2, size: number, mode: 'fillet' | 'chamfer'): Path | null {
  const n = path.segs.length;
  const junctions: number[] = [];
  for (let i = 0; i < (path.closed ? n : n - 1); i++) junctions.push(i);
  if (!junctions.length) return null;
  const j = junctions.sort((p, q) => dist(segEnd(path.segs[p]!), at) - dist(segEnd(path.segs[q]!), at))[0]!;
  const s1 = path.segs[j]!;
  const s2 = path.segs[(j + 1) % n]!;
  const d1 = segTangent(s1, 1);
  const d2 = segTangent(s2, 0);
  const cos = -(d1.x * d2.x + d1.y * d2.y);
  const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (angle < 1e-3 || Math.PI - angle < 1e-3) return null;
  const back = mode === 'fillet' ? size / Math.tan(angle / 2) : size;
  // Positions `back` along each side from the corner (by arc length, sampled).
  const alongBack = (seg: PSeg, fromEnd: boolean): number | null => {
    const steps = 64;
    let travelled = 0;
    let previous = fromEnd ? segEnd(seg) : segStart(seg);
    for (let i = 1; i <= steps; i++) {
      const t = fromEnd ? 1 - i / steps : i / steps;
      const p = segPoint(seg, t);
      const step = dist(previous, p);
      if (travelled + step >= back) return fromEnd ? t + ((travelled + step - back) / step) / steps : t - ((travelled + step - back) / step) / steps;
      travelled += step;
      previous = p;
    }
    return null;
  };
  const t1 = alongBack(s1, true);
  const t2 = alongBack(s2, false);
  if (t1 === null || t2 === null) return null;
  const a = segPoint(s1, t1);
  const b = segPoint(s2, t2);
  let bridge: PSeg;
  if (mode === 'chamfer') bridge = { kind: 'line', a, b };
  else {
    const dir = segTangent(s1, t1);
    const normal = { x: -dir.y, y: dir.x };
    const chord = { x: b.x - a.x, y: b.y - a.y };
    const denom = 2 * (chord.x * normal.x + chord.y * normal.y);
    if (Math.abs(denom) < 1e-9) return null;
    const k = (chord.x * chord.x + chord.y * chord.y) / denom;
    const c = { x: a.x + normal.x * k, y: a.y + normal.y * k };
    const start = Math.atan2(a.y - c.y, a.x - c.x);
    let sweep = Math.atan2(b.y - c.y, b.x - c.x) - start;
    if (k > 0 && sweep < 0) sweep += TAU;
    if (k < 0 && sweep > 0) sweep -= TAU;
    bridge = { kind: 'arc', c, r: Math.abs(k), start, sweep };
  }
  const segs = [...path.segs];
  segs[j] = segSub(s1, 0, t1);
  segs[(j + 1) % n] = segSub(s2, t2, 1);
  segs.splice(j + 1, 0, bridge);
  // A closed path whose junction was the wrap-around keeps the order valid.
  return { segs, closed: path.closed };
}

/** Samples a path as world points (for display and bounding). */
export function samplePath(path: Path, perSegment = 24): Vec2[] {
  const out: Vec2[] = [];
  path.segs.forEach((seg, i) => {
    const steps = seg.kind === 'line' ? 1 : perSegment;
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) out.push(segPoint(seg, k / steps));
  });
  return out;
}
