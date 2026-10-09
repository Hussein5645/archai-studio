/**
 * Sketch curves as exact paths — lines, circular arcs and cubic Béziers — so the curve edits
 * (trim, extend, split, corner, fillet, join, offset, adding a point) treat arcs and handle
 * curves exactly, with the same maths the board's drafting tools use (src/drafting/paths.ts).
 * Also the drawing helpers for the curved tools (ellipse, 3-point circle, tangent arc, pen).
 * Sketch coordinates: u right, v up; a positive bulge / sweep is counter-clockwise.
 */
import type { Vec2 as P } from '@/geometry';
import { segPoint, segSub, segTangent, type Path, type PSeg } from '@/drafting/paths';
import { shapeContour } from './kernel/sketch';
import type { CurveHandles, Shape2D, Vec2 } from './kernel/types';

export type Polyline = Extract<Shape2D, { kind: 'polyline' }>;

const EPS = 1e-9;
/** Control-point factor of a quarter ellipse / circle as a cubic. */
export const KAPPA = 0.5522847498307936;

export const toP = ([x, y]: Vec2): P => ({ x, y });
export const fromP = ({ x, y }: P): Vec2 => [x, y];

/** True when a polyline has an arc or a Bézier segment. */
export function isCurved(shape: Shape2D): boolean {
  return shape.kind === 'polyline' && (Boolean(shape.bulges?.some((bulge) => bulge)) || Boolean(shape.handles?.some((handle) => handle)));
}

/** Centre, radius, start angle and sweep of the arc from a to b with a bulge. */
export function bulgeArc(a: Vec2, b: Vec2, bulge: number): { c: Vec2; r: number; start: number; sweep: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy) || EPS;
  const radius = (chord * (1 + bulge * bulge)) / (4 * bulge);
  const sagitta = (bulge * chord) / 2;
  // Centre: back from the arc's middle (which is to the right for a positive bulge) by the radius.
  const c: Vec2 = [(a[0] + b[0]) / 2 + (-dy / chord) * (radius - sagitta), (a[1] + b[1]) / 2 + (dx / chord) * (radius - sagitta)];
  return { c, r: Math.abs(radius), start: Math.atan2(a[1] - c[1], a[0] - c[0]), sweep: 4 * Math.atan(bulge) };
}

/** Segment i of a polyline (from point i to the next) as a path segment. */
export function polylineSeg(shape: Polyline, i: number): PSeg {
  const a = shape.points[i]!;
  const b = shape.points[(i + 1) % shape.points.length]!;
  const handle = shape.handles?.[i];
  if (handle) return { kind: 'cubic', p0: toP(a), p1: toP(handle[0]), p2: toP(handle[1]), p3: toP(b) };
  const bulge = shape.bulges?.[i] ?? 0;
  if (bulge && Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) {
    const arc = bulgeArc(a, b, bulge);
    return { kind: 'arc', c: toP(arc.c), r: arc.r, start: arc.start, sweep: arc.sweep };
  }
  return { kind: 'line', a: toP(a), b: toP(b) };
}

/** Number of segments of a polyline. */
export function segmentCount(shape: Polyline): number {
  return shape.closed === false ? Math.max(0, shape.points.length - 1) : shape.points.length;
}

/** Any sketch shape as an exact path (rectangles and polygons as lines, circles as two half arcs). */
export function shapeToPath(shape: Shape2D): Path {
  if (shape.kind === 'polyline') {
    const segs: PSeg[] = [];
    for (let i = 0; i < segmentCount(shape); i++) segs.push(polylineSeg(shape, i));
    return { segs, closed: shape.closed !== false };
  }
  if (shape.kind === 'circle') {
    const c = { x: shape.cx, y: shape.cy };
    return { segs: [{ kind: 'arc', c, r: shape.radius, start: 0, sweep: Math.PI }, { kind: 'arc', c, r: shape.radius, start: Math.PI, sweep: Math.PI }], closed: true };
  }
  const contour = shapeContour(shape);
  return { segs: contour.map((point, i) => ({ kind: 'line', a: toP(point), b: toP(contour[(i + 1) % contour.length]!) }) as PSeg), closed: true };
}

/** Every segment of the shapes (for cutters and boundaries). */
export function shapeSegs(shapes: readonly Shape2D[]): PSeg[] {
  return shapes.flatMap((shape) => shapeToPath(shape).segs);
}

/**
 * A path back as a polyline carrying `base`'s id, name and offset. Arcs of more than a half turn
 * are cut in pieces (a bulge describes at most a full circle, and is exact up to a half turn).
 */
export function pathToPolyline(path: Path, base: { id: string; name?: string; offset?: number }): Polyline {
  const segs: PSeg[] = [];
  for (const seg of path.segs) {
    if (seg.kind === 'arc' && Math.abs(seg.sweep) > Math.PI + 1e-9) {
      const pieces = Math.ceil(Math.abs(seg.sweep) / Math.PI - 1e-9);
      for (let k = 0; k < pieces; k++) segs.push(segSub(seg, k / pieces, (k + 1) / pieces));
    } else segs.push(seg);
  }
  const points: Vec2[] = [];
  const bulges: number[] = [];
  const handles: (CurveHandles | null)[] = [];
  for (const seg of segs) {
    points.push(fromP(segPoint(seg, 0)));
    bulges.push(seg.kind === 'arc' ? Math.tan(seg.sweep / 4) : 0);
    handles.push(seg.kind === 'cubic' ? [fromP(seg.p1), fromP(seg.p2)] : null);
  }
  if (!path.closed && segs.length) points.push(fromP(segPoint(segs[segs.length - 1]!, 1)));
  const result: Polyline = { kind: 'polyline', id: base.id, points: points.map(clean), ...(base.name ? { name: base.name } : {}), ...(base.offset ? { offset: base.offset } : {}) };
  if (!path.closed) result.closed = false;
  if (bulges.some((bulge) => Math.abs(bulge) > 1e-12)) result.bulges = bulges;
  if (handles.some((handle) => handle)) result.handles = handles.map((handle) => (handle ? (handle.map(clean) as CurveHandles) : null));
  return result;
}

/** Drops float noise so a trimmed square keeps exact coordinates. */
function clean(point: Vec2): Vec2 {
  // "+ 0" turns -0 into 0.
  return [Math.round(point[0] * 1e9) / 1e9 + 0, Math.round(point[1] * 1e9) / 1e9 + 0];
}

/** The polyline with segment `index` split at parameter t (a new vertex, arcs and Béziers stay exact). */
export function splitSegment(shape: Polyline, index: number, t: number): Polyline {
  const path = shapeToPath(shape);
  const seg = path.segs[index]!;
  const segs = [...path.segs.slice(0, index), segSub(seg, 0, t), segSub(seg, t, 1), ...path.segs.slice(index + 1)];
  return pathToPolyline({ segs, closed: path.closed }, shape);
}

/** Direction of travel at the start (`atEnd` false, pointing into the curve) or end of an open polyline. */
export function endTangent(shape: Polyline, atEnd: boolean): Vec2 {
  const path = shapeToPath(shape);
  const seg = atEnd ? path.segs[path.segs.length - 1]! : path.segs[0]!;
  const t = segTangent(seg, atEnd ? 1 : 0);
  return [t.x, t.y];
}

// ---- drawing helpers --------------------------------------------------------------------------

/** A closed ellipse: centre, the end of one axis, the other radius (four exact-looking quarter cubics). */
export function ellipseShape(center: Vec2, axisEnd: Vec2, otherRadius: number): Polyline {
  const a: Vec2 = [axisEnd[0] - center[0], axisEnd[1] - center[1]];
  const length = Math.hypot(a[0], a[1]) || 1;
  const b: Vec2 = [(-a[1] / length) * otherRadius, (a[0] / length) * otherRadius];
  const at = (x: number, y: number): Vec2 => [center[0] + a[0] * x + b[0] * y, center[1] + a[1] * x + b[1] * y];
  const k = KAPPA;
  return {
    kind: 'polyline',
    id: 'preview',
    points: [at(1, 0), at(0, 1), at(-1, 0), at(0, -1)],
    handles: [
      [at(1, k), at(k, 1)],
      [at(-k, 1), at(-1, k)],
      [at(-1, -k), at(-k, -1)],
      [at(k, -1), at(1, -k)],
    ],
  };
}

/** Distance of p from the line through the centre along the axis (the ellipse's other radius). */
export function distanceFromAxis(center: Vec2, axisEnd: Vec2, p: Vec2): number {
  const dx = axisEnd[0] - center[0];
  const dy = axisEnd[1] - center[1];
  const length = Math.hypot(dx, dy) || 1;
  return Math.abs(((p[0] - center[0]) * -dy + (p[1] - center[1]) * dx) / length);
}

/** The circle through three points (null when they are in a line). */
export function circleThrough(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const center: Vec2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

/** The bulge of an arc from `start` leaving along `direction` to `end` (0 when end is straight ahead). */
export function tangentArcBulge(start: Vec2, direction: Vec2, end: Vec2): number {
  let alpha = Math.atan2(end[1] - start[1], end[0] - start[0]) - Math.atan2(direction[1], direction[0]);
  while (alpha > Math.PI) alpha -= Math.PI * 2;
  while (alpha < -Math.PI) alpha += Math.PI * 2;
  return Math.tan(alpha / 2);
}

/** A pen node: its point and, for a smooth node, the handle leaving it (the arriving one mirrors it). */
export interface PenNode {
  point: Vec2;
  handle: Vec2 | null;
}

/** The polyline of pen nodes: segments between two corner nodes are straight, others cubic. */
export function penShape(nodes: readonly PenNode[], closed: boolean): Polyline {
  const points = nodes.map((node) => node.point);
  const count = closed ? nodes.length : nodes.length - 1;
  const handles: (CurveHandles | null)[] = [];
  for (let i = 0; i < count; i++) {
    const from = nodes[i]!;
    const to = nodes[(i + 1) % nodes.length]!;
    if (!from.handle && !to.handle) {
      handles.push(null);
      continue;
    }
    const out = from.handle ?? from.point;
    const into: Vec2 = to.handle ? [2 * to.point[0] - to.handle[0], 2 * to.point[1] - to.handle[1]] : to.point;
    handles.push([out, into]);
  }
  return { kind: 'polyline', id: 'preview', points, ...(handles.some((handle) => handle) ? { handles } : {}), ...(closed ? {} : { closed: false }) };
}
