import type { CurvePath, LineElement } from '@/document';

type Point = [number, number];
export const WALL_PATH_KEYS = ['pathType', 'arcBulge', 'bezierHandles'] as const;

/** Move one path end without changing the opposite end of its circular arc. */
export function movePathEndpoint(path: CurvePath, endpoint: 'start' | 'end', point: Point): CurvePath {
  const next = structuredClone(path);
  const segment = endpoint === 'start' ? next.segments[0] : next.segments.at(-1);
  if (segment?.kind === 'arc') {
    const oldStart: Point = [segment.center[0] + Math.cos(segment.startAngle) * segment.radius, segment.center[1] + Math.sin(segment.startAngle) * segment.radius];
    const oldEnd: Point = [segment.center[0] + Math.cos(segment.endAngle) * segment.radius, segment.center[1] + Math.sin(segment.endAngle) * segment.radius];
    const oldDx = oldEnd[0] - oldStart[0], oldDy = oldEnd[1] - oldStart[1];
    const bend = ((segment.center[1] - oldStart[1]) * oldDx - (segment.center[0] - oldStart[0]) * oldDy) / Math.max(0.000001, oldDx * oldDx + oldDy * oldDy);
    const start = endpoint === 'start' ? point : oldStart, end = endpoint === 'end' ? point : oldEnd;
    const dx = end[0] - start[0], dy = end[1] - start[1];
    if (Math.hypot(dx, dy) < 0.001) throw new Error('Arc endpoints must be different');
    segment.center = [(start[0] + end[0]) / 2 - dy * bend, (start[1] + end[1]) / 2 + dx * bend];
    segment.radius = Math.hypot(start[0] - segment.center[0], start[1] - segment.center[1]);
    segment.startAngle = Math.atan2(start[1] - segment.center[1], start[0] - segment.center[0]);
    segment.endAngle = Math.atan2(end[1] - segment.center[1], end[0] - segment.center[0]);
  } else if (endpoint === 'end' && segment && 'to' in segment) segment.to = point;
  if (endpoint === 'start') next.start = point;
  return next;
}

export function wallPathKind(element: LineElement): 'straight' | 'arc' | 'bezier' {
  const kind = element.path?.segments[0]?.kind;
  return kind === 'arc' ? 'arc' : kind === 'bezier' || kind === 'quadratic' ? 'bezier' : 'straight';
}

/** Read actual curve data, including curves edited with canvas handles. */
export function wallPathParameters(element: LineElement): { pathType: 'straight' | 'arc' | 'bezier'; arcBulge?: number; bezierHandles?: Point[] } {
  const pathType = wallPathKind(element);
  const start = element.path?.start ?? element.points[0]!;
  const end = element.points.at(-1)!;
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const squared = Math.max(0.000001, dx * dx + dy * dy);
  const relative = (point: Point): Point => [((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / squared, ((point[1] - start[1]) * dx - (point[0] - start[0]) * dy) / squared];
  const first = element.path?.segments[0];
  if (pathType === 'arc' && first?.kind === 'arc') return { pathType, arcBulge: relative(first.center)[1] };
  if (pathType === 'bezier') {
    let from = start;
    const handles: Point[] = [];
    for (const segment of element.path?.segments ?? []) {
      if (segment.kind === 'bezier') handles.push(relative(segment.control1), relative(segment.control2));
      if (segment.kind === 'quadratic') handles.push(relative([from[0] + (segment.control[0] - from[0]) * 2 / 3, from[1] + (segment.control[1] - from[1]) * 2 / 3]), relative([segment.to[0] + (segment.control[0] - segment.to[0]) * 2 / 3, segment.to[1] + (segment.control[1] - segment.to[1]) * 2 / 3]));
      if ('to' in segment) from = segment.to;
    }
    return { pathType, bezierHandles: handles };
  }
  return { pathType };
}

/** Split the final cubic without changing its shape; fewer segments retain the outer handles. */
export function resizeBezierHandles(path: CurvePath, count: number): CurvePath {
  const next = structuredClone(path);
  let from = next.start;
  next.segments = next.segments.map((segment) => {
    const start = from;
    if ('to' in segment) from = segment.to;
    if (segment.kind !== 'quadratic') return segment;
    return { kind: 'bezier', control1: [start[0] + (segment.control[0] - start[0]) * 2 / 3, start[1] + (segment.control[1] - start[1]) * 2 / 3], control2: [segment.to[0] + (segment.control[0] - segment.to[0]) * 2 / 3, segment.to[1] + (segment.control[1] - segment.to[1]) * 2 / 3], to: segment.to };
  });
  if (!next.segments.every((segment) => segment.kind === 'bezier')) throw new Error('Handle count requires a Bézier path');
  const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  while (next.segments.length * 2 < count) {
    const last = next.segments.pop()!;
    if (last.kind !== 'bezier') break;
    const previous = next.segments.at(-1);
    const start = previous && 'to' in previous ? previous.to : next.start;
    const a = midpoint(start, last.control1), b = midpoint(last.control1, last.control2), c = midpoint(last.control2, last.to);
    const d = midpoint(a, b), e = midpoint(b, c), join = midpoint(d, e);
    next.segments.push({ kind: 'bezier', control1: a, control2: d, to: join }, { kind: 'bezier', control1: e, control2: c, to: last.to });
  }
  while (next.segments.length * 2 > count) {
    const last = next.segments.pop()!, previous = next.segments.pop()!;
    if (last.kind !== 'bezier' || previous.kind !== 'bezier') break;
    next.segments.push({ kind: 'bezier', control1: previous.control1, control2: last.control2, to: last.to });
  }
  return next;
}
