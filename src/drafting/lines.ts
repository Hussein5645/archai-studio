/**
 * Board element geometry in world space for the edit commands: straight polylines of line
 * elements (to trim, extend, split, fillet, offset and join), and reflections of any element
 * (mirror). Everything here works on plain values or Immer drafts; the commands own history.
 */
import type { Draft } from 'immer';
import type { CurvePath, Element, ElementTable, LineElement } from '@/document';
import { applyToPoint, invert, localMatrix, multiply, parentWorldMatrix, sampleCurvePath, worldMatrix, type Mat, type Vec2 } from '@/geometry';
import { segEnd, segStart, type Path, type PSeg } from './paths';

export type Tuple = [number, number];

/** A line element's straight polyline in world space, or null when it has curved segments. */
export function worldPolyline(elements: ElementTable, element: LineElement): { points: Tuple[]; closed: boolean } | null {
  if (element.path && element.path.segments.some((segment) => segment.kind !== 'line')) return null;
  const m = worldMatrix(elements, element);
  const local: Tuple[] = element.path ? [element.path.start, ...element.path.segments.map((segment) => (segment as { to: Tuple }).to)] : element.points;
  return { points: local.map(([x, y]) => { const p = applyToPoint(m, { x, y }); return [p.x, p.y]; }), closed: element.closed };
}

/** Writes world-space polyline points back into a line element (its frame stays). */
export function setWorldPolyline(elements: ElementTable, element: Draft<LineElement>, points: readonly Tuple[], closed: boolean): void {
  const inverse = invert(worldMatrix(elements, element as LineElement));
  element.points = points.map(([x, y]) => { const p = applyToPoint(inverse, { x, y }); return [p.x, p.y] as Tuple; });
  delete element.path;
  element.closed = closed;
}

/** The reflection across the line through `a` and `b`. */
export function reflection(a: Vec2, b: Vec2): Mat {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const c = (dx * dx - dy * dy) / len2;
  const s = (2 * dx * dy) / len2;
  // p' = a + M (p - a) with M = [[c, s], [s, -c]].
  return [c, s, s, -c, a.x - c * a.x - s * a.y, a.y - s * a.x + c * a.y];
}

function transformPath(path: CurvePath, m: Mat): CurvePath {
  const point = (p: Tuple): Tuple => { const q = applyToPoint(m, { x: p[0], y: p[1] }); return [q.x, q.y]; };
  const angle = (a: number) => Math.atan2(m[1] * Math.cos(a) + m[3] * Math.sin(a), m[0] * Math.cos(a) + m[2] * Math.sin(a));
  const flips = m[0] * m[3] - m[1] * m[2] < 0;
  return {
    start: point(path.start),
    segments: path.segments.map((segment) => {
      if (segment.kind === 'line') return { ...segment, to: point(segment.to) };
      if (segment.kind === 'quadratic') return { ...segment, control: point(segment.control), to: point(segment.to) };
      if (segment.kind === 'bezier') return { ...segment, control1: point(segment.control1), control2: point(segment.control2), to: point(segment.to) };
      const sweep = segment.endAngle - segment.startAngle;
      const start = angle(segment.startAngle);
      // A reflection reverses the direction of travel; keep the same sweep size.
      return { ...segment, center: point(segment.center), startAngle: start, endAngle: start + (flips ? -sweep : sweep), clockwise: flips ? !segment.clockwise : segment.clockwise };
    }),
  };
}

/**
 * Applies a world-space rigid transform or reflection `r` to an element (and, for groups, to
 * its children, keeping the group's own frame). Boxes keep reading the right way round: a
 * reflected box is re-seated from its reflected top-right corner.
 */
export function transformElementWorld(elements: Draft<ElementTable>, element: Draft<Element>, r: Mat): void {
  const table = elements as ElementTable;
  const parent = parentWorldMatrix(table, element as Element);
  // The transform expressed in the element's parent space.
  const inParent = multiply(invert(parent), multiply(r, parent));
  const flips = inParent[0] * inParent[3] - inParent[1] * inParent[2] < 0;
  if (element.kind === 'group') {
    for (const child of Object.values(table).filter((item) => item.parentId === element.id)) transformElementWorld(elements, elements[child.id]!, r);
    return;
  }
  if (element.kind === 'line') {
    // Points move within the element's own frame: local' = L⁻¹ · T · L.
    const local = multiply(parent, localMatrix(element as Element));
    const inLocal = multiply(invert(local), multiply(r, local));
    element.points = element.points.map(([x, y]) => { const p = applyToPoint(inLocal, { x, y }); return [p.x, p.y] as Tuple; });
    if (element.path) element.path = transformPath(element.path as CurvePath, inLocal);
    return;
  }
  const rad = (element.rotation * Math.PI) / 180;
  const u = { x: Math.cos(rad), y: Math.sin(rad) };
  const width = 'width' in element ? element.width : 0;
  const origin = { x: element.x, y: element.y };
  const vector = (m: Mat, v: Vec2) => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });
  if (!flips) {
    const p = applyToPoint(inParent, origin);
    const axis = vector(inParent, u);
    element.x = p.x;
    element.y = p.y;
    element.rotation = (Math.atan2(axis.y, axis.x) * 180) / Math.PI;
    return;
  }
  const topRight = { x: origin.x + u.x * width, y: origin.y + u.y * width };
  const p = applyToPoint(inParent, topRight);
  const axis = vector(inParent, u);
  element.x = p.x;
  element.y = p.y;
  element.rotation = (Math.atan2(-axis.y, -axis.x) * 180) / Math.PI;
}

/** Rotation by `degrees` (clockwise on the board, y down) about a world point. */
export function rotationAbout(center: Vec2, degrees: number): Mat {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, center.x - c * center.x + s * center.y, center.y - s * center.x - c * center.y];
}

export function translationBy(dx: number, dy: number): Mat {
  return [1, 0, 0, 1, dx, dy];
}

// ---- general curved paths -----------------------------------------------------------------------

/** A line element (straight, arcs, Béziers) as a world-space path (see ./paths.ts). */
export function elementPath(elements: ElementTable, element: LineElement): Path {
  const m = worldMatrix(elements, element);
  const world = (p: readonly [number, number]) => applyToPoint(m, { x: p[0], y: p[1] });
  const turn = Math.atan2(m[1], m[0]);
  const segs: PSeg[] = [];
  if (element.path) {
    let from = world(element.path.start);
    for (const segment of element.path.segments) {
      if (segment.kind === 'line') {
        const to = world(segment.to);
        segs.push({ kind: 'line', a: from, b: to });
        from = to;
      } else if (segment.kind === 'arc') {
        let sweep = segment.endAngle - segment.startAngle;
        if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2;
        if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2;
        if (Math.abs(sweep) < 1e-9) sweep = segment.clockwise ? -Math.PI * 2 : Math.PI * 2;
        const arc: PSeg = { kind: 'arc', c: world(segment.center), r: segment.radius, start: segment.startAngle + turn, sweep };
        segs.push(arc);
        from = segEnd(arc);
      } else if (segment.kind === 'quadratic') {
        const c = world(segment.control);
        const to = world(segment.to);
        segs.push({ kind: 'cubic', p0: from, p1: { x: from.x + (2 / 3) * (c.x - from.x), y: from.y + (2 / 3) * (c.y - from.y) }, p2: { x: to.x + (2 / 3) * (c.x - to.x), y: to.y + (2 / 3) * (c.y - to.y) }, p3: to });
        from = to;
      } else {
        const to = world(segment.to);
        segs.push({ kind: 'cubic', p0: from, p1: world(segment.control1), p2: world(segment.control2), p3: to });
        from = to;
      }
    }
  } else {
    const points = element.points.map(world);
    for (let i = 1; i < points.length; i++) segs.push({ kind: 'line', a: points[i - 1]!, b: points[i]! });
  }
  // A closed shape's implied closing edge becomes an explicit segment.
  if (element.closed && segs.length) {
    const start = segStart(segs[0]!);
    const end = segEnd(segs.at(-1)!);
    if (Math.hypot(end.x - start.x, end.y - start.y) > 1e-6) segs.push({ kind: 'line', a: end, b: start });
  }
  return { segs, closed: element.closed };
}

/**
 * A world-space path in a frame (`inverse` maps world to it): its points (sampled when curved)
 * and, when it has arcs or Béziers, the exact curve.
 */
export function localCurve(path: Path, inverse: Mat): { points: Tuple[]; path?: CurvePath; closed: boolean } {
  const turn = Math.atan2(inverse[1], inverse[0]);
  const local = (p: Vec2): Tuple => { const q = applyToPoint(inverse, p); return [q.x, q.y]; };
  const straight = path.segs.every((seg) => seg.kind === 'line');
  if (straight) {
    const points = [segStart(path.segs[0]!), ...path.segs.map(segEnd)];
    // A closed polyline stores its vertices once (the closing edge is implied).
    if (path.closed && points.length > 2 && Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) < 1e-6) points.pop();
    return { points: points.map(local), closed: path.closed };
  }
  const segments: CurvePath['segments'] = path.segs.map((seg) => {
    if (seg.kind === 'line') return { kind: 'line' as const, to: local(seg.b) };
    if (seg.kind === 'cubic') return { kind: 'bezier' as const, control1: local(seg.p1), control2: local(seg.p2), to: local(seg.p3) };
    return { kind: 'arc' as const, center: local(seg.c), radius: seg.r, startAngle: seg.start + turn, endAngle: seg.start + seg.sweep + turn, clockwise: seg.sweep < 0 };
  });
  const curve: CurvePath = { start: local(segStart(path.segs[0]!)), segments };
  return { points: sampleCurvePath(curve, 32), path: curve, closed: path.closed };
}

/** Writes a world-space path back into a line element (its frame stays; points re-sampled). */
export function setElementPath(elements: ElementTable, element: Draft<LineElement>, path: Path): void {
  const curve = localCurve(path, invert(worldMatrix(elements, element as LineElement)));
  element.points = curve.points;
  if (curve.path) element.path = curve.path;
  else delete element.path;
  element.closed = curve.closed;
}

/** The world segments of any element usable as a cutting edge or boundary (lines, rectangles). */
export function elementSegments(elements: ElementTable, element: Element): PSeg[] {
  if (element.kind === 'line') return elementPath(elements, element).segs;
  if (element.kind === 'rect' || element.kind === 'image' || element.kind === 'instance') {
    const m = worldMatrix(elements, element);
    const c = [[0, 0], [element.width, 0], [element.width, element.height], [0, element.height]].map(([x, y]) => applyToPoint(m, { x: x!, y: y! }));
    return c.map((a, i) => ({ kind: 'line' as const, a, b: c[(i + 1) % 4]! }));
  }
  return [];
}
