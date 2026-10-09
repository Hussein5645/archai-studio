/**
 * Builders for the drafting shapes the board draws: circles, arcs, polygons, ellipses and
 * rounded rectangles, all as the line element's editable `path` (so no new element kinds and
 * the existing renderer, hit testing, export and grips apply). Angles are radians in board space
 * (y down). Pure.
 */
import type { CurvePath } from '@/document';
import type { Vec2 } from '@/geometry';

type Tuple = [number, number];
const t = (p: Vec2): Tuple => [p.x, p.y];

export function circlePath(center: Vec2, radius: number): CurvePath {
  return { start: [center.x + radius, center.y], segments: [{ kind: 'arc', center: t(center), radius, startAngle: 0, endAngle: Math.PI * 2, clockwise: false }] };
}

/** Circle through two diameter ends. */
export function circleFrom2(a: Vec2, b: Vec2): { center: Vec2; radius: number } {
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radius: Math.hypot(b.x - a.x, b.y - a.y) / 2 };
}

/** Circle through three points, or null when they are collinear. */
export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const center = { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
  return { center, radius: Math.hypot(a.x - center.x, a.y - center.y) };
}

/** An arc from `start` to `end` passing through `through`, or null when collinear. */
export function arcThrough(start: Vec2, through: Vec2, end: Vec2): CurvePath | null {
  const circle = circleFrom3(start, through, end);
  if (!circle) return null;
  const { center, radius } = circle;
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const am = Math.atan2(through.y - center.y, through.x - center.x);
  // Increasing-angle sweep from a0 to a1; if it misses the through point, go the other way.
  const norm = (v: number) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const clockwise = norm(am - a0) > norm(a1 - a0);
  return { start: t(start), segments: [{ kind: 'arc', center: t(center), radius, startAngle: a0, endAngle: a1, clockwise }] };
}

/** An arc about `center` from the angle of `start`, sweeping `sweep` radians (sign = direction). */
export function arcCentre(center: Vec2, start: Vec2, sweep: number): CurvePath {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  return { start: t(start), segments: [{ kind: 'arc', center: t(center), radius, startAngle: a0, endAngle: a0 + sweep, clockwise: sweep < 0 }] };
}

/** An arc leaving `start` along `direction` (tangent) and ending at `end`. */
export function arcTangent(start: Vec2, direction: Vec2, end: Vec2): CurvePath | null {
  const len = Math.hypot(direction.x, direction.y);
  if (len < 1e-9) return null;
  const dir = { x: direction.x / len, y: direction.y / len };
  // Centre lies on the normal at `start`, equidistant from start and end.
  const normal = { x: -dir.y, y: dir.x };
  const chord = { x: end.x - start.x, y: end.y - start.y };
  const denom = 2 * (chord.x * normal.x + chord.y * normal.y);
  if (Math.abs(denom) < 1e-9) return null;
  const k = (chord.x * chord.x + chord.y * chord.y) / denom;
  const center = { x: start.x + normal.x * k, y: start.y + normal.y * k };
  const radius = Math.abs(k);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  // Moving along `dir` from start increases the angle when the centre is on the normal side.
  const clockwise = k < 0;
  return { start: t(start), segments: [{ kind: 'arc', center: t(center), radius, startAngle: a0, endAngle: a1, clockwise }] };
}

/** Regular polygon vertices: centre, one vertex (inscribed) or one edge middle (circumscribed). */
export function polygonPoints(center: Vec2, corner: Vec2, sides: number, circumscribed = false): Vec2[] {
  const n = Math.max(3, Math.round(sides));
  let radius = Math.hypot(corner.x - center.x, corner.y - center.y);
  let start = Math.atan2(corner.y - center.y, corner.x - center.x);
  if (circumscribed) {
    radius /= Math.cos(Math.PI / n);
    start += Math.PI / n;
  }
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i * Math.PI * 2) / n;
    return { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius };
  });
}

/** An ellipse (four cubic Béziers) from its centre, one axis end and the other half-axis length. */
export function ellipsePath(center: Vec2, axisEnd: Vec2, otherRadius: number): CurvePath {
  const rx = Math.hypot(axisEnd.x - center.x, axisEnd.y - center.y);
  const ry = Math.abs(otherRadius);
  const angle = Math.atan2(axisEnd.y - center.y, axisEnd.x - center.x);
  const k = 0.5522847498;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (x: number, y: number): Tuple => [center.x + x * cos - y * sin, center.y + x * sin + y * cos];
  return {
    start: at(rx, 0),
    segments: [
      { kind: 'bezier', control1: at(rx, ry * k), control2: at(rx * k, ry), to: at(0, ry) },
      { kind: 'bezier', control1: at(-rx * k, ry), control2: at(-rx, ry * k), to: at(-rx, 0) },
      { kind: 'bezier', control1: at(-rx, -ry * k), control2: at(-rx * k, -ry), to: at(0, -ry) },
      { kind: 'bezier', control1: at(rx * k, -ry), control2: at(rx, -ry * k), to: at(rx, 0) },
    ],
  };
}

/** The distance from a point to the line through `center` along `axisEnd` (an ellipse's other radius). */
export function distanceFromAxis(center: Vec2, axisEnd: Vec2, p: Vec2): number {
  const dx = axisEnd.x - center.x;
  const dy = axisEnd.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((p.x - center.x) * dy - (p.y - center.y) * dx) / len;
}
