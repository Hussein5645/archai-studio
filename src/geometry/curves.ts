import type { CurvePath, LineElement } from '@/document';
import type { Vec2 } from './vec';

const METRIC_RESOLUTION = 256;

const tuple = (point: readonly [number, number]): Vec2 => ({ x: point[0], y: point[1] });
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Samples an editable analytic path for display/meshing without destroying its curve data. */
export function sampleCurvePath(path: CurvePath, resolution = 24): [number, number][] {
  const result: [number, number][] = [[path.start[0], path.start[1]]];
  let from = tuple(path.start);
  for (const segment of path.segments) {
    if (segment.kind === 'line') {
      result.push([segment.to[0], segment.to[1]]);
      from = tuple(segment.to);
      continue;
    }
    if (segment.kind === 'arc') {
      let sweep = segment.endAngle - segment.startAngle;
      if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2;
      if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2;
      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / resolution)));
      for (let step = 1; step <= steps; step++) {
        const angle = segment.startAngle + sweep * (step / steps);
        result.push([segment.center[0] + Math.cos(angle) * segment.radius, segment.center[1] + Math.sin(angle) * segment.radius]);
      }
      const last = result.at(-1)!;
      from = { x: last[0], y: last[1] };
      continue;
    }
    const to = tuple(segment.to);
    const steps = resolution;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      if (segment.kind === 'quadratic') {
        const control = tuple(segment.control);
        const left = lerp(from, control, t);
        const right = lerp(control, to, t);
        const point = lerp(left, right, t);
        result.push([point.x, point.y]);
      } else {
        const c1 = tuple(segment.control1);
        const c2 = tuple(segment.control2);
        const a = lerp(lerp(from, c1, t), lerp(c1, c2, t), t);
        const b = lerp(lerp(c1, c2, t), lerp(c2, to, t), t);
        const point = lerp(a, b, t);
        result.push([point.x, point.y]);
      }
    }
    from = to;
  }
  return result;
}

export function linePoints(element: LineElement, resolution = 24): [number, number][] {
  return element.path ? sampleCurvePath(element.path, resolution) : element.points;
}

export interface CurveProjection {
  point: Vec2;
  tangent: Vec2;
  distance: number;
  along: number;
  totalLength: number;
}

/** Closest point and tangent on the tessellated curve, measured by arc length. */
export function projectOnLine(element: LineElement, target: Vec2): CurveProjection | null {
  const points = linePoints(element, METRIC_RESOLUTION).map(tuple);
  if (points.length < 2) return null;
  let totalLength = 0;
  const lengths: number[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const length = Math.hypot(points[index + 1]!.x - points[index]!.x, points[index + 1]!.y - points[index]!.y);
    lengths.push(length);
    totalLength += length;
  }
  let travelled = 0;
  let best: CurveProjection | null = null;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = lengths[index]!;
    if (length <= 0) continue;
    const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (length * length)));
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(target.x - point.x, target.y - point.y);
    if (!best || distance < best.distance) best = { point, tangent: { x: dx / length, y: dy / length }, distance, along: travelled + length * t, totalLength };
    travelled += length;
  }
  return best;
}

export function pointAtLine(element: LineElement, along: number): { point: Vec2; tangent: Vec2; totalLength: number } | null {
  const points = linePoints(element, METRIC_RESOLUTION).map(tuple);
  if (points.length < 2) return null;
  const lengths = points.slice(0, -1).map((point, index) => Math.hypot(points[index + 1]!.x - point.x, points[index + 1]!.y - point.y));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = Math.max(0, Math.min(totalLength, along));
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const a = points[index]!;
      const b = points[index + 1]!;
      const t = length > 0 ? remaining / length : 0;
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, tangent: length > 0 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 1, y: 0 }, totalLength };
    }
    remaining -= length;
  }
  return null;
}
