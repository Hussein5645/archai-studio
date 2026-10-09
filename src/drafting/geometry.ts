/**
 * World-space drafting geometry of a document: the segments, circular arcs and key points object
 * snapping works against (Revit / AutoCAD "object snaps"). Built once per element table (cached
 * by identity, so unrelated UI changes cost nothing) by walking the element tree with its world
 * matrices. Pure: shared by the board interactions, commands and tests.
 */
import { childrenOf, type Element, type ElementTable } from '@/document';
import { applyToPoint, IDENTITY, localMatrix, multiply, type Mat, type Rect, type Vec2 } from '@/geometry';
import { geoToLocal, mapFrame, type GeoPoint } from '@/analysis/mapGeometry';

export type KeyPointKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant';

export interface DraftSegment {
  a: Vec2;
  b: Vec2;
  id: string;
}

/** A circle, or an arc from `start` sweeping `sweep` radians (positive = increasing angle). */
export interface DraftArc {
  center: Vec2;
  radius: number;
  start: number;
  sweep: number;
  id: string;
}

export interface DraftPoint {
  p: Vec2;
  kind: KeyPointKind;
  id: string;
}

export interface DraftGeometry {
  segments: DraftSegment[];
  arcs: DraftArc[];
  points: DraftPoint[];
}

const TAU = Math.PI * 2;

function arcSweep(start: number, end: number, clockwise: boolean): number {
  let sweep = end - start;
  if (clockwise && sweep > 0) sweep -= TAU;
  if (!clockwise && sweep < 0) sweep += TAU;
  if (Math.abs(sweep) < 1e-9) sweep = clockwise ? -TAU : TAU;
  return sweep;
}

/** Whether an angle lies on an arc (full circles contain every angle). */
export function angleOnArc(arc: Pick<DraftArc, 'start' | 'sweep'>, angle: number): boolean {
  if (Math.abs(arc.sweep) >= TAU - 1e-9) return true;
  let d = (angle - arc.start) % TAU;
  if (arc.sweep >= 0) {
    if (d < 0) d += TAU;
    return d <= arc.sweep + 1e-9;
  }
  if (d > 0) d -= TAU;
  return d >= arc.sweep - 1e-9;
}

function addLine(out: DraftGeometry, element: Extract<Element, { kind: 'line' }>, m: Mat): void {
  const world = (p: readonly [number, number]) => applyToPoint(m, { x: p[0], y: p[1] });
  const scaleOf = Math.hypot(m[0], m[1]) || 1;
  const id = element.id;
  const pushSegment = (a: Vec2, b: Vec2, key = true) => {
    out.segments.push({ a, b, id });
    if (key) out.points.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint', id });
  };
  if (element.path) {
    let from = world(element.path.start);
    out.points.push({ p: from, kind: 'endpoint', id });
    for (const segment of element.path.segments) {
      if (segment.kind === 'line') {
        const to = world(segment.to);
        pushSegment(from, to);
        out.points.push({ p: to, kind: 'endpoint', id });
        from = to;
      } else if (segment.kind === 'arc') {
        const center = world(segment.center);
        // Rotation of the world matrix turns every angle by the same amount.
        const turn = Math.atan2(m[1], m[0]);
        const start = segment.startAngle + turn;
        const sweep = arcSweep(segment.startAngle, segment.endAngle, segment.clockwise);
        const radius = segment.radius * scaleOf;
        out.arcs.push({ center, radius, start, sweep, id });
        out.points.push({ p: center, kind: 'center', id });
        const end = { x: center.x + Math.cos(start + sweep) * radius, y: center.y + Math.sin(start + sweep) * radius };
        out.points.push({ p: end, kind: 'endpoint', id });
        out.points.push({ p: { x: center.x + Math.cos(start + sweep / 2) * radius, y: center.y + Math.sin(start + sweep / 2) * radius }, kind: 'midpoint', id });
        for (let q = 0; q < 4; q++) {
          const angle = (q * Math.PI) / 2;
          if (angleOnArc({ start, sweep }, angle)) out.points.push({ p: { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }, kind: 'quadrant', id });
        }
        from = end;
      } else {
        // Béziers: a fine polyline for nearest / intersection; only the ends are key points.
        const to = world(segment.to);
        const c1 = world(segment.kind === 'quadratic' ? segment.control : segment.control1);
        const c2 = segment.kind === 'bezier' ? world(segment.control2) : null;
        let previous = from;
        for (let step = 1; step <= 16; step++) {
          const t = step / 16;
          const u = 1 - t;
          const point = c2
            ? { x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x, y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y }
            : { x: u * u * from.x + 2 * u * t * c1.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c1.y + t * t * to.y };
          pushSegment(previous, point, false);
          previous = point;
        }
        out.points.push({ p: to, kind: 'endpoint', id });
        from = to;
      }
    }
    if (element.closed) {
      const start = world(element.path.start);
      if (Math.hypot(start.x - from.x, start.y - from.y) > 1e-6) pushSegment(from, start);
    }
    return;
  }
  const points = element.points.map(world);
  points.forEach((p) => out.points.push({ p, kind: 'endpoint', id }));
  for (let i = 1; i < points.length; i++) pushSegment(points[i - 1]!, points[i]!);
  if (element.closed && points.length > 2) pushSegment(points[points.length - 1]!, points[0]!);
}

function addBox(out: DraftGeometry, element: Element & { width: number; height: number }, m: Mat, edges: boolean): void {
  const id = element.id;
  const corners = [
    { x: 0, y: 0 },
    { x: element.width, y: 0 },
    { x: element.width, y: element.height },
    { x: 0, y: element.height },
  ].map((p) => applyToPoint(m, p));
  corners.forEach((p) => out.points.push({ p, kind: 'endpoint', id }));
  out.points.push({ p: applyToPoint(m, { x: element.width / 2, y: element.height / 2 }), kind: 'center', id });
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    out.points.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint', id });
    if (edges) out.segments.push({ a, b, id });
  }
}

/**
 * A map's site boundary (`meta.location.boundary`, geographic corners) as board lines: its
 * edges, corners and midpoints snap like any other line. It carries the map's id, so moving the
 * map does not snap to its own boundary.
 */
function addSiteBoundary(out: DraftGeometry, element: Element & { width: number; height: number }, m: Mat): void {
  const location = element.meta?.['location'];
  if (!location || typeof location !== 'object' || Array.isArray(location)) return;
  const boundary = location['boundary'];
  if (!Array.isArray(boundary) || boundary.length < 2) return;
  const geo = (value: unknown): GeoPoint | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { lat, lon } = value as Record<string, unknown>;
    return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
  };
  const centre = geo(location['mapCenter']) ?? geo(location);
  if (!centre) return;
  const anchorValue = location['anchor'];
  const anchor = anchorValue && typeof anchorValue === 'object' && !Array.isArray(anchorValue) && typeof anchorValue['x'] === 'number' && typeof anchorValue['y'] === 'number'
    ? { x: anchorValue['x'], y: anchorValue['y'] }
    : { x: element.width / 2, y: element.height / 2 };
  const frame = mapFrame(centre, anchor);
  const corners = boundary.map(geo).filter((p): p is GeoPoint => p !== null).map((p) => applyToPoint(m, geoToLocal(frame, p)));
  const id = element.id;
  corners.forEach((p) => out.points.push({ p, kind: 'endpoint', id }));
  const closed = corners.length >= 3;
  for (let i = 0; i < corners.length - (closed ? 0 : 1); i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    out.segments.push({ a, b, id });
    out.points.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint', id });
  }
}

/** Elements that are drafting geometry themselves (not annotations laid over it). */
function snappable(element: Element): boolean {
  if (!element.visible) return false;
  // Measurements and view rigs float over the drawing; snapping to them is noise.
  if (element.meta?.['measure'] || element.meta?.['rig']) return false;
  return true;
}

function build(elements: ElementTable, rootId: string | null, rootMatrix: Mat): DraftGeometry {
  const out: DraftGeometry = { segments: [], arcs: [], points: [] };
  const walk = (parentId: string | null, parent: Mat) => {
    for (const element of childrenOf(elements, parentId)) {
      if (!snappable(element)) continue;
      const m = multiply(parent, localMatrix(element));
      switch (element.kind) {
        case 'line':
          addLine(out, element, m);
          break;
        case 'rect':
          addBox(out, element, m, true);
          addSiteBoundary(out, element, m);
          if (element.meta?.['paper']) walk(element.id, m);
          break;
        case 'image':
        case 'instance':
        case 'text':
          addBox(out, element, m, element.kind !== 'text');
          break;
        case 'group':
          walk(element.id, m);
          break;
      }
    }
  };
  walk(rootId, rootMatrix);
  return out;
}

const cache = new WeakMap<ElementTable, Map<string, DraftGeometry>>();

/**
 * The drafting geometry of the board (or of one sheet's paper and what is on it), cached per
 * element table. Elements listed in `exclude` are left out by the query functions, not here.
 */
export function draftGeometry(elements: ElementTable, scopeId: string | null = null, scopeMatrix: Mat = IDENTITY): DraftGeometry {
  let byScope = cache.get(elements);
  if (!byScope) {
    byScope = new Map();
    cache.set(elements, byScope);
  }
  const key = scopeId ?? '';
  let geometry = byScope.get(key);
  if (!geometry) {
    geometry = build(elements, scopeId, scopeMatrix);
    byScope.set(key, geometry);
  }
  return geometry;
}

/** Whether a segment's bounding box comes within `margin` of the area. */
export function segmentNear(segment: { a: Vec2; b: Vec2 }, area: Rect, margin = 0): boolean {
  return Math.max(segment.a.x, segment.b.x) >= area.x - margin && Math.min(segment.a.x, segment.b.x) <= area.x + area.width + margin && Math.max(segment.a.y, segment.b.y) >= area.y - margin && Math.min(segment.a.y, segment.b.y) <= area.y + area.height + margin;
}
