/**
 * Pure edits on sketch curves (docs/modeling-tools.md, sketch edit mode): healing gaps and
 * duplicates for extrusion, and the modify operations (move / copy / rotate / mirror / scale,
 * trim / extend, split, fillet / chamfer) the sketch editing tools apply. Everything works in
 * sketch coordinates and returns new shapes; the store records them as one undo step.
 */
import { arrangeSketch, bulgeThrough, polylinePoints, shapeContour, shapeIsValid, translateShape } from './kernel/sketch';
import type { CurveHandles, Shape2D, Vec2 } from './kernel/types';
import { cornerPaths, extendPath, filletPath, pathEnd, pathStart, reversePath, segNearest, splitPath, trimPath, type Path } from '@/drafting/paths';
import { fromP, isCurved, pathToPolyline, polylineSeg, segmentCount, shapeSegs, shapeToPath, splitSegment, toP } from './curves';

type Polyline = Extract<Shape2D, { kind: 'polyline' }>;

const EPS = 1e-6;

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isOpen(shape: Shape2D): shape is Polyline {
  return shape.kind === 'polyline' && shape.closed === false;
}

/** Intersection of the infinite lines a1→a2 and b1→b2, or null when parallel. */
export function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12 * (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y) || 1)) return null;
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom;
  return [a1[0] + d1x * t, a1[1] + d1y * t];
}

// ---- healing -------------------------------------------------------------------------------

export interface HealResult {
  shapes: Shape2D[];
  /** Gaps closed (pairs of ends joined). */
  joined: number;
  /** Duplicate shapes removed. */
  removed: number;
}

function sameGeometry(a: Shape2D, b: Shape2D): boolean {
  if (a.kind !== b.kind || (a.offset ?? 0) !== (b.offset ?? 0)) return false;
  const ca = shapeContour(a);
  const cb = shapeContour(b);
  if (ca.length !== cb.length) return false;
  const forward = ca.every((point, index) => distance(point, cb[index]!) < 1e-3);
  if (forward) return true;
  const reversed = [...cb].reverse();
  return ca.every((point, index) => distance(point, reversed[index]!) < 1e-3);
}

/**
 * Makes curves extrudable: drops shapes lying exactly on top of an earlier one, and joins open
 * line ends that nearly meet (within `gap`). Two ends whose lines cross near both of them are
 * extended / trimmed to that corner (Revit's trim/extend to corner); otherwise they meet halfway.
 * Ends already touching another curve are left alone.
 */
export function healShapes(input: readonly Shape2D[], gap: number): HealResult {
  let removed = 0;
  const shapes: Shape2D[] = [];
  for (const shape of input) {
    if (shapes.some((kept) => sameGeometry(kept, shape))) {
      removed++;
      continue;
    }
    shapes.push(shape);
  }

  // Free ends: first / last points of open polylines that touch nothing else.
  interface End {
    shape: number;
    first: boolean;
    point: Vec2;
    /** The neighbouring point along the curve (defines the end's direction). */
    inner: Vec2;
  }
  const ends: End[] = [];
  shapes.forEach((shape, index) => {
    if (!isOpen(shape) || shape.points.length < 2) return;
    const pts = polylinePoints(shape.points, shape.bulges, false, shape.handles);
    ends.push({ shape: index, first: true, point: shape.points[0]!, inner: pts[1]! });
    ends.push({ shape: index, first: false, point: shape.points[shape.points.length - 1]!, inner: pts[pts.length - 2]! });
  });
  const touching = (end: End) =>
    ends.some((other) => other !== end && distance(other.point, end.point) < 1e-3) ||
    shapes.some((shape, index) => index !== end.shape && !isOpen(shape) && shapeContour(shape).some((point) => distance(point, end.point) < 1e-3));
  const free = ends.filter((end) => !touching(end));

  // Greedy: closest pairs first.
  const pairs: { a: End; b: End; d: number }[] = [];
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const a = free[i]!;
      const b = free[j]!;
      if (a.shape === b.shape && (shapes[a.shape] as Polyline).points.length < 3) continue;
      const d = distance(a.point, b.point);
      if (d <= gap) pairs.push({ a, b, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const used = new Set<End>();
  const moves = new Map<End, Vec2>();
  for (const { a, b } of pairs) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    const corner = lineIntersection(a.inner, a.point, b.inner, b.point);
    const target = corner && distance(corner, a.point) <= gap && distance(corner, b.point) <= gap ? corner : ([(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2] as Vec2);
    moves.set(a, target);
    moves.set(b, target);
  }
  const next = shapes.map((shape, index) => {
    if (!isOpen(shape)) return shape;
    const points = [...shape.points];
    for (const [end, target] of moves) {
      if (end.shape !== index) continue;
      points[end.first ? 0 : points.length - 1] = target;
    }
    return { ...shape, points };
  });
  return { shapes: next, joined: moves.size / 2, removed };
}

// ---- transforms ------------------------------------------------------------------------------

type PointMap = (point: Vec2) => Vec2;

/** Drops float noise (1e-9 mm) so a quarter turn gives exact rectangle sizes. */
function clean(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Applies a point map to a shape. Rectangles and polygons that would not stay axis-true become polylines. */
function mapShape(shape: Shape2D, rawMap: PointMap, options: { flips?: boolean; uniformScale?: number; rotation?: number } = {}): Shape2D {
  const map: PointMap = (point) => rawMap(point).map(clean) as Vec2;
  const flipBulges = (bulges?: number[]) => (bulges && options.flips ? bulges.map((bulge) => -bulge) : bulges);
  switch (shape.kind) {
    case 'circle': {
      const [cx, cy] = map([shape.cx, shape.cy]);
      return { ...shape, cx, cy, radius: shape.radius * (options.uniformScale ?? 1) };
    }
    case 'polygon': {
      const [cx, cy] = map([shape.cx, shape.cy]);
      if (options.uniformScale === undefined) break;
      const rotation = options.flips ? -shape.rotation + 2 * (options.rotation ?? 0) + 180 : shape.rotation + (options.rotation ?? 0);
      return { ...shape, cx, cy, radius: shape.radius * options.uniformScale, rotation: options.flips ? rotation - 180 : rotation };
    }
    case 'polyline':
      return {
        ...shape,
        points: shape.points.map(map),
        ...(shape.bulges ? { bulges: flipBulges(shape.bulges) } : {}),
        ...(shape.handles ? { handles: shape.handles.map((handle) => (handle ? (handle.map(map) as CurveHandles) : null)) } : {}),
      };
    case 'rect':
      break;
  }
  // Rectangles (and polygons under a non-uniform map) become an equivalent closed polyline.
  const contour = shape.kind === 'rect' ? shapeContour(shape) : shapeContour(shape);
  const mapped = contour.map(map);
  if (shape.kind === 'rect') {
    const xs = mapped.map((p) => p[0]);
    const ys = mapped.map((p) => p[1]);
    const axisTrue = mapped.every((p, i) => {
      const q = mapped[(i + 1) % mapped.length]!;
      return Math.abs(p[0] - q[0]) < EPS || Math.abs(p[1] - q[1]) < EPS;
    });
    if (axisTrue) {
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { ...shape, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
  }
  const { id, name, offset } = shape;
  return { kind: 'polyline', id, points: mapped, ...(name ? { name } : {}), ...(offset ? { offset } : {}) };
}

export function moveShape(shape: Shape2D, delta: Vec2): Shape2D {
  return translateShape(shape, delta[0], delta[1]);
}

export function rotateShape(shape: Shape2D, centre: Vec2, degrees: number): Shape2D {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const map: PointMap = ([x, y]) => {
    const dx = x - centre[0];
    const dy = y - centre[1];
    return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos];
  };
  return mapShape(shape, map, { uniformScale: 1, rotation: degrees });
}

/** Reflects across the line through `a` and `b`. */
export function mirrorShape(shape: Shape2D, a: Vec2, b: Vec2): Shape2D {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy || 1;
  const map: PointMap = ([x, y]) => {
    const t = ((x - a[0]) * dx + (y - a[1]) * dy) / length2;
    const px = a[0] + dx * t;
    const py = a[1] + dy * t;
    return [2 * px - x, 2 * py - y];
  };
  const axisAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return mapShape(shape, map, { flips: true, uniformScale: 1, rotation: axisAngle });
}

export function scaleShape(shape: Shape2D, centre: Vec2, factor: number): Shape2D {
  const map: PointMap = ([x, y]) => [centre[0] + (x - centre[0]) * factor, centre[1] + (y - centre[1]) * factor];
  const scaled = mapShape(shape, map, { uniformScale: Math.abs(factor), rotation: factor < 0 ? 180 : 0 });
  return scaled.offset ? { ...scaled, offset: scaled.offset * Math.abs(factor) } : scaled;
}

// ---- curve topology edits ---------------------------------------------------------------------

/** The shape as an editable polyline (closed shapes stay closed). Arcs of circles are tessellated. */
export function toPolyline(shape: Shape2D): Polyline {
  if (shape.kind === 'polyline') return shape;
  const { id, name, offset } = shape;
  return { kind: 'polyline', id, points: shapeContour(shape), ...(name ? { name } : {}), ...(offset ? { offset } : {}) };
}

/** Segments of a shape as [a, b, segmentIndex] (bulge arcs by their chord). */
function segmentsOf(shape: Polyline): [Vec2, Vec2, number][] {
  const closed = shape.closed !== false;
  const count = closed ? shape.points.length : shape.points.length - 1;
  const result: [Vec2, Vec2, number][] = [];
  for (let i = 0; i < count; i++) result.push([shape.points[i]!, shape.points[(i + 1) % shape.points.length]!, i]);
  return result;
}

/** Nearest point on segment a→b to p, with its parameter. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 < EPS ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  const point: Vec2 = [a[0] + dx * t, a[1] + dy * t];
  return { point, t, distance: distance(point, p) };
}

/** The segment of a shape nearest to a point. */
export function nearestSegment(shape: Shape2D, p: Vec2): { index: number; point: Vec2; t: number; distance: number } | null {
  if (shape.kind === 'polyline' && isCurved(shape)) {
    let best: { index: number; point: Vec2; t: number; distance: number } | null = null;
    for (let index = 0; index < segmentCount(shape); index++) {
      const hit = segNearest(polylineSeg(shape, index), toP(p));
      if (!best || hit.distance < best.distance) best = { index, t: hit.t, point: fromP(hit.point), distance: hit.distance };
    }
    return best;
  }
  const line = toPolyline(shape);
  let best: { index: number; point: Vec2; t: number; distance: number } | null = null;
  for (const [a, b, index] of segmentsOf(line)) {
    const hit = closestOnSegment(p, a, b);
    if (!best || hit.distance < best.distance) best = { index, ...hit };
  }
  return best;
}

/** Parameters (segment index + t) where straight segments of `shape` cross any of `cutters`. */
function cutParameters(shape: Polyline, cutters: readonly Shape2D[]): { index: number; t: number; point: Vec2 }[] {
  const cuts: { index: number; t: number; point: Vec2 }[] = [];
  const others = cutters.flatMap((cutter) => {
    const contour = shapeContour(cutter);
    const open = isOpen(cutter);
    const count = open ? contour.length - 1 : contour.length;
    const list: [Vec2, Vec2][] = [];
    for (let i = 0; i < count; i++) list.push([contour[i]!, contour[(i + 1) % contour.length]!]);
    return list;
  });
  for (const [a, b, index] of segmentsOf(shape)) {
    for (const [c, d] of others) {
      const hit = lineIntersection(a, b, c, d);
      if (!hit) continue;
      const t = closestOnSegment(hit, a, b).t;
      const u = closestOnSegment(hit, c, d);
      if (u.distance > 1e-4 || distance(hit, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) > 1e-4) continue;
      cuts.push({ index, t, point: hit });
    }
  }
  return cuts;
}

/** Splits an open or closed polyline at a point on one of its segments. Closed shapes open up there. */
export function splitShapeAt(shape: Shape2D, p: Vec2, newId: () => string): Shape2D[] {
  if (isCurved(shape) || shape.kind === 'circle') return fromPaths(splitPath(shapeToPath(shape), toP(p)), shape, newId, [shape]);
  const line = toPolyline(shape);
  const hit = nearestSegment(line, p);
  if (!hit) return [shape];
  const bulges = line.bulges ?? [];
  const at = hit.point;
  if (line.closed !== false) {
    // Reopen the ring at the split point: at → next vertices … → this segment's start → at.
    const n = line.points.length;
    const points: Vec2[] = [at];
    const nextBulges: number[] = [0];
    for (let k = 1; k <= n; k++) {
      const index = (hit.index + k) % n;
      points.push(line.points[index]!);
      nextBulges.push(bulges[index] ?? 0);
    }
    points.push(at);
    nextBulges.pop();
    const opened: Polyline = { ...line, points, closed: false };
    delete opened.bulges;
    if (nextBulges.some((bulge) => bulge)) opened.bulges = nextBulges;
    return [opened];
  }
  const first: Polyline = { ...line, points: [...line.points.slice(0, hit.index + 1), at], closed: false };
  const second: Polyline = { ...line, id: newId(), points: [at, ...line.points.slice(hit.index + 1)], closed: false };
  delete first.bulges;
  delete second.bulges;
  if (bulges.some((bulge) => bulge)) {
    first.bulges = [...bulges.slice(0, hit.index), 0];
    second.bulges = [0, ...bulges.slice(hit.index + 1)];
  }
  const valid = [first, second].filter((item) => item.points.length >= 2 && distance(item.points[0]!, item.points[item.points.length - 1]!) > EPS);
  return valid.length ? valid : [shape];
}

/**
 * Trim: removes the piece of a curve between the nearest cuts by other curves on either side of
 * the picked point (the part clicked on disappears), like Revit's "Split with gap"/AutoCAD trim.
 * Returns the remaining pieces (possibly none).
 */
export function trimShape(shape: Shape2D, pick: Vec2, cutters: readonly Shape2D[], newId: () => string): Shape2D[] {
  // Arcs, Bézier curves and circles (as the trimmed curve or a cutter) use the exact path maths.
  if (isCurved(shape) || shape.kind === 'circle' || cutters.some((cutter) => isCurved(cutter) || cutter.kind === 'circle')) {
    return fromPaths(trimPath(shapeToPath(shape), toP(pick), shapeSegs(cutters)), shape, newId, []);
  }
  const line = toPolyline(shape);
  const closed = line.closed !== false;
  const hit = nearestSegment(line, pick);
  if (!hit) return [shape];
  const segs = segmentsOf(line);
  const lengths = segs.map(([a, b]) => distance(a, b));
  const offsets: number[] = [];
  let total = 0;
  for (const length of lengths) {
    offsets.push(total);
    total += length;
  }
  if (total < EPS) return [shape];
  // Every vertex as a station along the curve (the last point of an open curve at `total`).
  const stations = segs.map(([a], index) => ({ s: offsets[index]!, point: a }));
  if (!closed) stations.push({ s: total, point: line.points[line.points.length - 1]! });
  const position = (index: number, t: number) => offsets[index]! + lengths[index]! * t;
  const pointAt = (value: number): Vec2 => {
    const s = closed ? ((value % total) + total) % total : Math.max(0, Math.min(total, value));
    let index = segs.length - 1;
    for (let i = 0; i < segs.length; i++) {
      if (s <= offsets[i]! + lengths[i]! + EPS) {
        index = i;
        break;
      }
    }
    const [a, b] = segs[index]!;
    const t = lengths[index]! > EPS ? (s - offsets[index]!) / lengths[index]! : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  /** The curve between positions s0 < s1 (s1 may run past `total` on a ring). */
  const piece = (s0: number, s1: number): Vec2[] => {
    const points: Vec2[] = [pointAt(s0)];
    for (let lap = 0; lap < (closed ? 2 : 1); lap++) {
      for (const station of stations) {
        const s = station.s + lap * total;
        if (s > s0 + EPS && s < s1 - EPS) points.push(station.point);
      }
    }
    points.push(pointAt(s1));
    return points;
  };
  const pickAt = position(hit.index, hit.t);
  const cuts = cutParameters(line, cutters).map((cut) => position(cut.index, cut.t));
  const make = (points: Vec2[], id: string): Polyline => {
    const { bulges: _bulges, ...rest } = { ...line, id, points, closed: false as const };
    return rest;
  };
  if (closed) {
    // A ring is opened between the cuts on either side of the pick (wrapping round).
    const sorted = [...new Set(cuts.map((s) => Math.round(s / EPS) * EPS))].sort((p, q) => p - q);
    if (sorted.length < 2) return [];
    const start = [...sorted].reverse().find((s) => s < pickAt - EPS) ?? sorted[sorted.length - 1]!;
    const end = sorted.find((s) => s > pickAt + EPS) ?? sorted[0]!;
    const keepTo = start > end ? start : start + total;
    return [make(piece(end, keepTo), line.id)];
  }
  const before = cuts.filter((s) => s < pickAt - EPS && s > EPS).sort((p, q) => q - p)[0];
  const after = cuts.filter((s) => s > pickAt + EPS && s < total - EPS).sort((p, q) => p - q)[0];
  // No cut on a side: the whole curve on that side goes (trim to the curve's end).
  const pieces: Polyline[] = [];
  if (before !== undefined) pieces.push(make(piece(0, before), line.id));
  if (after !== undefined) pieces.push(make(piece(after, total), pieces.length ? newId() : line.id));
  if (before === undefined && after === undefined) return [];
  return pieces;
}

/**
 * Extends (or trims) the end of an open curve nearest `pick` to where its end segment meets
 * `boundary`. Returns null when the line never meets it.
 */
export function extendShapeTo(shape: Shape2D, pick: Vec2, boundary: Shape2D): Shape2D | null {
  if (!isOpen(shape) || shape.points.length < 2) return null;
  if (isCurved(shape) || isCurved(boundary) || boundary.kind === 'circle') {
    const extended = extendPath(shapeToPath(shape), toP(pick), shapeSegs([boundary]));
    return extended && extended.segs.length ? pathToPolyline(extended, shape) : null;
  }
  const first = distance(pick, shape.points[0]!) < distance(pick, shape.points[shape.points.length - 1]!);
  const end = first ? shape.points[0]! : shape.points[shape.points.length - 1]!;
  const inner = first ? shape.points[1]! : shape.points[shape.points.length - 2]!;
  const contour = shapeContour(boundary);
  const count = isOpen(boundary) ? contour.length - 1 : contour.length;
  let best: Vec2 | null = null;
  for (let i = 0; i < count; i++) {
    const c = contour[i]!;
    const d = contour[(i + 1) % contour.length]!;
    const hit = lineIntersection(inner, end, c, d);
    if (!hit || closestOnSegment(hit, c, d).distance > 1e-4) continue;
    // Only forward from the inner point (along inner → end).
    const forward = (hit[0] - inner[0]) * (end[0] - inner[0]) + (hit[1] - inner[1]) * (end[1] - inner[1]);
    if (forward <= EPS) continue;
    if (!best || distance(hit, end) < distance(best, end)) best = hit;
  }
  if (!best) return null;
  const points = [...shape.points];
  points[first ? 0 : points.length - 1] = best;
  return { ...shape, points };
}

/**
 * Trim/extend two open lines to the corner where they meet; the picked sides are kept. The
 * picks decide which part of each line survives when they cross.
 */
export function cornerShapes(a: Shape2D, pickA: Vec2, b: Shape2D, pickB: Vec2): [Shape2D, Shape2D] | null {
  if (!isOpen(a) || !isOpen(b)) return null;
  if (isCurved(a) || isCurved(b)) {
    const result = cornerPaths(shapeToPath(a), toP(pickA), shapeToPath(b), toP(pickB));
    if (!result || !result[0].segs.length || !result[1].segs.length) return null;
    return [pathToPolyline(result[0], a), pathToPolyline(result[1], b)];
  }
  const segA = nearestSegment(a, pickA);
  const segB = nearestSegment(b, pickB);
  if (!segA || !segB) return null;
  const a1 = a.points[segA.index]!;
  const a2 = a.points[segA.index + 1]!;
  const b1 = b.points[segB.index]!;
  const b2 = b.points[segB.index + 1]!;
  const corner = lineIntersection(a1, a2, b1, b2);
  if (!corner) return null;
  const cut = (line: Polyline, index: number, pick: Vec2): Polyline => {
    const s0 = line.points[index]!;
    const s1 = line.points[index + 1]!;
    // Which side of the corner the pick lies on, along the segment direction.
    const dir: Vec2 = [s1[0] - s0[0], s1[1] - s0[1]];
    const pickSide = (pick[0] - corner[0]) * dir[0] + (pick[1] - corner[1]) * dir[1];
    if (pickSide < 0) return { ...line, points: [...line.points.slice(0, index + 1), corner] };
    return { ...line, points: [corner, ...line.points.slice(index + 1)] };
  };
  const strip = (line: Polyline): Polyline => {
    const { bulges: _bulges, ...rest } = line;
    return rest as Polyline;
  };
  return [strip(cut(a, segA.index, pickA)), strip(cut(b, segB.index, pickB))];
}

/**
 * Rounds (radius > 0) or chamfers the corner of a polyline nearest to `pick`: the corner vertex is
 * replaced by two points `radius` (or `distance`) back along each side, joined by an arc or a
 * straight line. Returns null when the corner cannot take it.
 */
export function filletCorner(shape: Shape2D, pick: Vec2, size: number, mode: 'fillet' | 'chamfer'): Shape2D | null {
  if (isCurved(shape)) {
    if (size <= 0) return null;
    const rounded = filletPath(shapeToPath(shape), toP(pick), size, mode);
    if (!rounded) return null;
    const result = pathToPolyline(rounded, shape);
    return shapeIsValid(result) ? result : null;
  }
  const line = toPolyline(shape);
  const closed = line.closed !== false;
  const n = line.points.length;
  let index = -1;
  let best = Infinity;
  line.points.forEach((point, i) => {
    if (!closed && (i === 0 || i === n - 1)) return;
    const d = distance(point, pick);
    if (d < best) {
      best = d;
      index = i;
    }
  });
  if (index < 0 || size <= 0) return null;
  const p = line.points[index]!;
  const prev = line.points[(index - 1 + n) % n]!;
  const next = line.points[(index + 1) % n]!;
  const u1: Vec2 = [prev[0] - p[0], prev[1] - p[1]];
  const u2: Vec2 = [next[0] - p[0], next[1] - p[1]];
  const l1 = Math.hypot(...u1);
  const l2 = Math.hypot(...u2);
  if (l1 < EPS || l2 < EPS) return null;
  const cosAngle = (u1[0] * u2[0] + u1[1] * u2[1]) / (l1 * l2);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  if (angle < 1e-3 || Math.PI - angle < 1e-3) return null;
  // Fillet: tangent points at radius / tan(angle / 2) from the corner.
  const back = mode === 'fillet' ? size / Math.tan(angle / 2) : size;
  if (back > l1 - EPS || back > l2 - EPS) return null;
  const t1: Vec2 = [p[0] + (u1[0] / l1) * back, p[1] + (u1[1] / l1) * back];
  const t2: Vec2 = [p[0] + (u2[0] / l2) * back, p[1] + (u2[1] / l2) * back];
  const bulges = line.bulges ? [...line.bulges] : new Array<number>(closed ? n : n - 1).fill(0);
  while (bulges.length < (closed ? n : n - 1)) bulges.push(0);
  let arc = 0;
  if (mode === 'fillet') {
    // Sweep of the arc is pi - angle; sign follows the turn direction (left turn = CCW = positive).
    const turn = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
    arc = Math.tan((Math.PI - angle) / 4) * (turn > 0 ? 1 : -1);
  }
  const points = [...line.points.slice(0, index), t1, t2, ...line.points.slice(index + 1)];
  const nextBulges = [...bulges.slice(0, index), arc, ...bulges.slice(index)];
  const result: Polyline = { ...line, points };
  delete result.bulges;
  if (nextBulges.some((bulge) => bulge)) result.bulges = nextBulges.slice(0, closed ? points.length : points.length - 1);
  return shapeIsValid(result) ? result : null;
}

/** Joins open polylines that share end points into one chain (Revit "join"), keeping the first id. */
export function joinShapes(shapes: readonly Shape2D[]): Shape2D[] {
  if (shapes.some((shape) => isOpen(shape) && isCurved(shape))) return joinCurves(shapes);
  const open = shapes.filter(isOpen).filter((shape) => !shape.bulges?.some((bulge) => bulge));
  const rest = shapes.filter((shape) => !open.includes(shape as Polyline));
  const chains: Polyline[] = [];
  const pool = [...open];
  while (pool.length) {
    let chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i]!;
        const head = chain.points[0]!;
        const tail = chain.points[chain.points.length - 1]!;
        const oHead = other.points[0]!;
        const oTail = other.points[other.points.length - 1]!;
        let points: Vec2[] | null = null;
        if (distance(tail, oHead) < 1e-3) points = [...chain.points, ...other.points.slice(1)];
        else if (distance(tail, oTail) < 1e-3) points = [...chain.points, ...[...other.points].reverse().slice(1)];
        else if (distance(head, oTail) < 1e-3) points = [...other.points, ...chain.points.slice(1)];
        else if (distance(head, oHead) < 1e-3) points = [...[...other.points].reverse(), ...chain.points.slice(1)];
        if (points) {
          chain = { ...chain, points };
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    // A chain returning to its start becomes a closed polyline.
    if (chain.points.length > 3 && distance(chain.points[0]!, chain.points[chain.points.length - 1]!) < 1e-3) {
      const { closed: _closed, ...closedChain } = { ...chain, points: chain.points.slice(0, -1) };
      chains.push(closedChain as Polyline);
    } else chains.push(chain);
  }
  return [...rest, ...chains];
}

/** Paths back as polylines: the first keeps the shape's id, the rest get new ones. */
function fromPaths(paths: readonly Path[], shape: Shape2D, newId: () => string, fallback: Shape2D[]): Shape2D[] {
  const kept = paths.filter((path) => path.segs.length);
  if (!kept.length) return fallback;
  return kept.map((path, index) => pathToPolyline(path, index === 0 ? shape : { ...shape, id: newId() }));
}

/** joinShapes for chains with arcs and Bézier curves: exact path joining, ids kept per chain. */
function joinCurves(shapes: readonly Shape2D[]): Shape2D[] {
  const open = shapes.filter(isOpen);
  const rest = shapes.filter((shape) => !isOpen(shape));
  const pool = open.map((shape) => ({ shape, path: shapeToPath(shape) }));
  const out: Shape2D[] = [];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
  while (pool.length) {
    const first = pool.shift()!;
    let chain = first.path;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i]!.path;
        let next: Path | null = null;
        if (near(pathEnd(chain), pathStart(other))) next = { segs: [...chain.segs, ...other.segs], closed: false };
        else if (near(pathEnd(chain), pathEnd(other))) next = { segs: [...chain.segs, ...reversePath(other).segs], closed: false };
        else if (near(pathStart(chain), pathEnd(other))) next = { segs: [...other.segs, ...chain.segs], closed: false };
        else if (near(pathStart(chain), pathStart(other))) next = { segs: [...reversePath(other).segs, ...chain.segs], closed: false };
        if (next) {
          chain = next;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (chain.segs.length > 1 && near(pathStart(chain), pathEnd(chain))) chain = { ...chain, closed: true };
    out.push(pathToPolyline(chain, first.shape));
  }
  return [...rest, ...out];
}

// ---- profile fix ------------------------------------------------------------------------------

export interface ProfileFix extends HealResult {
  /** Tails trimmed back to the corner they overshoot. */
  trimmed: number;
}

/**
 * The extrude tool's "Fix": heals gaps and duplicates (healShapes), then trims line tails that
 * overshoot a corner, so the curves form clean loops. Isolated open lines are left alone.
 */
export function fixProfile(input: readonly Shape2D[], gap: number, newId: () => string): ProfileFix {
  const healed = healShapes(input, gap);
  let shapes = healed.shapes;
  let trimmed = 0;
  for (let guard = 0; guard < 64; guard++) {
    const arrangement = arrangeSketch(shapes);
    if (!arrangement.faces.length) break;
    const ends = arrangement.openEnds;
    const tail = arrangement.dangling.find(([a, b]) => ends.some((end) => distance(end, a) < 1e-6 || distance(end, b) < 1e-6));
    if (!tail) break;
    const mid: Vec2 = [(tail[0][0] + tail[1][0]) / 2, (tail[0][1] + tail[1][1]) / 2];
    const index = shapes.findIndex((shape) => (nearestSegment(shape, mid)?.distance ?? Infinity) < 1e-3);
    if (index < 0) break;
    const pieces = trimShape(shapes[index]!, mid, shapes.filter((_, i) => i !== index), newId);
    if (!pieces.length) break;
    shapes = [...shapes.slice(0, index), ...pieces, ...shapes.slice(index + 1)];
    trimmed++;
  }
  return { ...healed, shapes, trimmed };
}

// ---- drawing helpers --------------------------------------------------------------------------

/** Rounds every corner of a shape with `radius` (rectangles become polylines); corners too tight keep their point. */
export function filletAll(shape: Shape2D, radius: number): Shape2D {
  if (radius <= 0 || shape.kind === 'circle') return shape;
  let current: Shape2D = toPolyline(shape);
  const line = current as Polyline;
  const closed = line.closed !== false;
  const corners = line.points.filter((_, index) => closed || (index > 0 && index < line.points.length - 1));
  for (const corner of corners) current = filletCorner(current, corner, radius, 'fillet') ?? current;
  return current;
}

/**
 * The points of a polyline moved `distance` to the left of its direction (negative = right),
 * with mitred corners; closed polylines stay closed.
 */
export function offsetPoints(points: readonly Vec2[], distance: number, closed: boolean): Vec2[] {
  if (!distance || points.length < 2) return [...points];
  const n = points.length;
  const normalOf = (a: Vec2, b: Vec2): Vec2 => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  };
  return points.map((point, index) => {
    const hasPrev = closed || index > 0;
    const hasNext = closed || index < n - 1;
    const prev = points[(index - 1 + n) % n]!;
    const next = points[(index + 1) % n]!;
    const n1 = hasPrev ? normalOf(prev, point) : null;
    const n2 = hasNext ? normalOf(point, next) : null;
    if (!n1 || !n2) {
      const normal = (n1 ?? n2)!;
      return [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
    }
    // Mitre: along the bisector, scaled so both offset lines pass through the result.
    const bx = n1[0] + n2[0];
    const by = n1[1] + n2[1];
    const scale = (bx * n1[0] + by * n1[1]) || 1;
    const limit = 4;
    const factor = Math.min(limit, 1 / Math.abs(scale)) * Math.sign(scale);
    return [point[0] + bx * distance * factor, point[1] + by * distance * factor];
  });
}

/**
 * The rounded joint between a line a→p and the next line p→b (chain drawing with a radius):
 * the two lines shortened to the tangent points and the arc between them, or null.
 */
export function filletJoint(a: Vec2, p: Vec2, b: Vec2, radius: number): { first: [Vec2, Vec2]; arc: { points: [Vec2, Vec2]; bulge: number }; second: [Vec2, Vec2] } | null {
  const rounded = filletCorner({ kind: 'polyline', id: 'joint', points: [a, p, b], closed: false }, p, radius, 'fillet');
  if (!rounded || rounded.kind !== 'polyline' || rounded.points.length !== 4) return null;
  const [, t1, t2] = rounded.points as [Vec2, Vec2, Vec2, Vec2];
  return { first: [a, t1], arc: { points: [t1, t2], bulge: rounded.bulges?.[1] ?? 0 }, second: [t2, b] };
}

// ---- grips ------------------------------------------------------------------------------------

/** A handle on a selected curve that reshapes it when dragged (Revit's grips). */
export type Grip =
  | { kind: 'vertex'; index: number; point: Vec2 }
  /** Middle of a straight polyline segment: drags the whole segment. */
  | { kind: 'segment'; index: number; point: Vec2 }
  /** Middle of an arc segment: changes how far it bows. */
  | { kind: 'bulge'; index: number; point: Vec2 }
  /** Rectangle corner 0..3 (x0y0, x1y0, x1y1, x0y1): the opposite corner stays. */
  | { kind: 'corner'; index: number; point: Vec2 }
  /** Rectangle side 0..3 (bottom, right, top, left): moves that side only. */
  | { kind: 'side'; index: number; point: Vec2 }
  /** Circle quadrant / polygon vertex: radius (and a polygon's rotation). */
  | { kind: 'radius'; point: Vec2 }
  /** A Bézier control point of segment `index`: `end` 0 leaves point index, 1 arrives at the next. */
  | { kind: 'handle'; index: number; end: 0 | 1; point: Vec2 }
  | { kind: 'center'; point: Vec2 };

function arcMidpoint(a: Vec2, b: Vec2, bulge: number): Vec2 {
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const sagitta = (bulge * chord) / 2;
  return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / chord) * sagitta, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / chord) * sagitta];
}

/** The grips of a shape, in the order they are drawn. */
export function shapeGrips(shape: Shape2D): Grip[] {
  switch (shape.kind) {
    case 'polyline': {
      const grips: Grip[] = shape.points.map((point, index) => ({ kind: 'vertex', index, point }));
      const count = shape.closed === false ? shape.points.length - 1 : shape.points.length;
      for (let index = 0; index < count; index++) {
        const a = shape.points[index]!;
        const b = shape.points[(index + 1) % shape.points.length]!;
        const handle = shape.handles?.[index];
        if (handle) {
          grips.push({ kind: 'handle', index, end: 0, point: handle[0] }, { kind: 'handle', index, end: 1, point: handle[1] });
          continue;
        }
        const bulge = shape.bulges?.[index] ?? 0;
        grips.push(bulge ? { kind: 'bulge', index, point: arcMidpoint(a, b, bulge) } : { kind: 'segment', index, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
      }
      return grips;
    }
    case 'rect': {
      const corners = shapeContour(shape);
      return [
        ...corners.map((point, index): Grip => ({ kind: 'corner', index, point })),
        ...corners.map((a, index): Grip => {
          const b = corners[(index + 1) % 4]!;
          return { kind: 'side', index, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        }),
        { kind: 'center', point: [shape.x + shape.width / 2, shape.y + shape.height / 2] },
      ];
    }
    case 'circle':
      return [
        { kind: 'center', point: [shape.cx, shape.cy] },
        ...([[1, 0], [0, 1], [-1, 0], [0, -1]] as const).map(([dx, dy]): Grip => ({ kind: 'radius', point: [shape.cx + dx * shape.radius, shape.cy + dy * shape.radius] })),
      ];
    case 'polygon':
      return [{ kind: 'center', point: [shape.cx, shape.cy] }, { kind: 'radius', point: shapeContour(shape)[0]! }];
  }
}

/** The grip of a shape nearest to a point, within `radius`. */
export function gripAt(shape: Shape2D, point: Vec2, radius: number): Grip | null {
  let best: Grip | null = null;
  let bestDistance = radius;
  for (const grip of shapeGrips(shape)) {
    const d = distance(grip.point, point);
    // Vertices win ties over the segment grip in the same place (very short segments).
    if (d < bestDistance || (best && d === bestDistance && grip.kind === 'vertex')) {
      best = grip;
      bestDistance = d;
    }
  }
  return best;
}

/** The shape with a grip dragged to `target`. */
export function dragGrip(shape: Shape2D, grip: Grip, target: Vec2): Shape2D {
  const delta: Vec2 = [target[0] - grip.point[0], target[1] - grip.point[1]];
  switch (grip.kind) {
    case 'center':
      return moveShape(shape, delta);
    case 'vertex':
      if (shape.kind !== 'polyline') return shape;
      return moveNodes(shape, new Set([grip.index]), delta);
    case 'segment': {
      if (shape.kind !== 'polyline') return shape;
      return moveNodes(shape, new Set([grip.index, (grip.index + 1) % shape.points.length]), delta);
    }
    case 'handle': {
      if (shape.kind !== 'polyline' || !shape.handles?.[grip.index]) return shape;
      return dragHandle(shape, grip.index, grip.end, target);
    }
    case 'bulge': {
      if (shape.kind !== 'polyline') return shape;
      const a = shape.points[grip.index]!;
      const b = shape.points[(grip.index + 1) % shape.points.length]!;
      const bulges = [...(shape.bulges ?? [])];
      bulges[grip.index] = bulgeThrough(a, b, target);
      return { ...shape, bulges };
    }
    case 'corner': {
      if (shape.kind !== 'rect') return shape;
      const corners = shapeContour(shape);
      const fixed = corners[(grip.index + 2) % 4]!;
      return { ...shape, x: Math.min(fixed[0], target[0]), y: Math.min(fixed[1], target[1]), width: Math.abs(target[0] - fixed[0]), height: Math.abs(target[1] - fixed[1]) };
    }
    case 'side': {
      if (shape.kind !== 'rect') return shape;
      let x0 = shape.x;
      let y0 = shape.y;
      let x1 = shape.x + shape.width;
      let y1 = shape.y + shape.height;
      if (grip.index === 0) y0 = target[1];
      else if (grip.index === 1) x1 = target[0];
      else if (grip.index === 2) y1 = target[1];
      else x0 = target[0];
      return { ...shape, x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }
    case 'radius': {
      if (shape.kind === 'circle') return { ...shape, radius: Math.max(1e-3, distance([shape.cx, shape.cy], target)) };
      if (shape.kind === 'polygon') return { ...shape, radius: Math.max(1e-3, distance([shape.cx, shape.cy], target)), rotation: (Math.atan2(target[1] - shape.cy, target[0] - shape.cx) * 180) / Math.PI };
      return shape;
    }
  }
}

/** Moves polyline vertices by `delta`, with the Bézier handles attached to them. */
function moveNodes(shape: Polyline, nodes: ReadonlySet<number>, delta: Vec2): Polyline {
  const shift = (point: Vec2): Vec2 => [point[0] + delta[0], point[1] + delta[1]];
  const n = shape.points.length;
  const result: Polyline = { ...shape, points: shape.points.map((point, index) => (nodes.has(index) ? shift(point) : point)) };
  if (shape.handles) {
    result.handles = shape.handles.map((handle, index) => {
      if (!handle) return null;
      return [nodes.has(index) ? shift(handle[0]) : handle[0], nodes.has((index + 1) % n) ? shift(handle[1]) : handle[1]];
    });
  }
  return result;
}

/**
 * Moves one Bézier control point. A smooth node (its two handles in line) stays smooth: the
 * handle on the other side turns to stay opposite, keeping its length.
 */
function dragHandle(shape: Polyline, index: number, end: 0 | 1, target: Vec2): Polyline {
  const n = shape.points.length;
  const closed = shape.closed !== false;
  const handles = [...shape.handles!];
  const own = handles[index]!;
  const node = shape.points[end === 0 ? index : (index + 1) % n]!;
  handles[index] = end === 0 ? [target, own[1]] : [own[0], target];
  // The neighbouring segment's handle at the same node.
  const otherIndex = end === 0 ? index - 1 : index + 1;
  const wrapped = closed ? (otherIndex + n) % n : otherIndex;
  const other = wrapped >= 0 && wrapped < handles.length ? handles[wrapped] : null;
  if (other) {
    const otherPoint = end === 0 ? other[1] : other[0];
    const before: Vec2 = [own[end][0] - node[0], own[end][1] - node[1]];
    const away: Vec2 = [otherPoint[0] - node[0], otherPoint[1] - node[1]];
    const lb = Math.hypot(before[0], before[1]);
    const la = Math.hypot(away[0], away[1]);
    const smooth = lb > 1e-9 && la > 1e-9 && (before[0] * away[0] + before[1] * away[1]) / (lb * la) < -0.995;
    const now: Vec2 = [target[0] - node[0], target[1] - node[1]];
    const ln = Math.hypot(now[0], now[1]);
    if (smooth && ln > 1e-9) {
      const mirrored: Vec2 = [node[0] - (now[0] / ln) * la, node[1] - (now[1] / ln) * la];
      handles[wrapped] = end === 0 ? [other[0], mirrored] : [mirrored, other[1]];
    }
  }
  return { ...shape, handles };
}

/** The points a grip moves (for carrying joined curve ends along): vertex / segment ends. */
export function gripMovedPoints(shape: Shape2D, grip: Grip): Vec2[] {
  if (shape.kind !== 'polyline') return [];
  if (grip.kind === 'vertex') return [shape.points[grip.index]!];
  if (grip.kind === 'segment') return [shape.points[grip.index]!, shape.points[(grip.index + 1) % shape.points.length]!];
  return [];
}

/**
 * Moves the vertices of other polylines lying on `from` points by the matching delta: curves
 * joined at an end stay joined while one of them is reshaped.
 */
export function carryJoined(shapes: readonly Shape2D[], exclude: string, moves: readonly { from: Vec2; to: Vec2 }[]): Shape2D[] {
  return shapes.map((shape) => {
    if (shape.id === exclude || shape.kind !== 'polyline') return shape;
    let changed = false;
    const points = shape.points.map((point) => {
      const move = moves.find((item) => distance(item.from, point) < 1e-6);
      if (!move) return point;
      changed = true;
      return move.to;
    });
    return changed ? { ...shape, points } : shape;
  });
}

/** Inserts a vertex on the segment of a polyline nearest to `point` (straight segments only). */
export function insertVertex(shape: Shape2D, point: Vec2): Shape2D | null {
  if (shape.kind !== 'polyline') return null;
  const hit = nearestSegment(shape, point);
  if (!hit || hit.t < 1e-6 || hit.t > 1 - 1e-6) return null;
  // Arcs and Bézier curves are cut in two exact halves.
  if (shape.bulges?.[hit.index] || shape.handles?.[hit.index]) return splitSegment(shape, hit.index, hit.t);
  const points = [...shape.points.slice(0, hit.index + 1), hit.point, ...shape.points.slice(hit.index + 1)];
  const result: Polyline = { ...shape, points };
  if (shape.bulges) result.bulges = [...shape.bulges.slice(0, hit.index + 1), 0, ...shape.bulges.slice(hit.index + 1)];
  return result;
}
