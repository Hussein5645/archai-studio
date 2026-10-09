/**
 * Object snapping, tracking and polar lines for board drafting (AutoCAD OSNAP / OTRACK / POLAR,
 * Revit's snaps and temporary alignment lines). Given the drafting geometry near the cursor it
 * returns the point to use, what it snapped to (for the marker and caption) and the guide lines
 * that explain it. Distances are world millimetres; `tolerance` is the snap radius in mm at the
 * current zoom. Pure.
 */
import { distance, type Vec2 } from '@/geometry';
import { angleOnArc, segmentNear, type DraftArc, type DraftGeometry, type DraftSegment } from './geometry';

export type OsnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'intersection'
  | 'perpendicular'
  | 'tangent'
  | 'extension'
  | 'nearest'
  | 'tracking'
  | 'polar'
  | 'grid';

/** Kinds the user can switch on and off (the rest follow the tracking / grid switches). */
export const OBJECT_SNAP_KINDS = ['endpoint', 'midpoint', 'center', 'quadrant', 'intersection', 'perpendicular', 'tangent', 'extension', 'nearest'] as const;
export type ObjectSnapKind = (typeof OBJECT_SNAP_KINDS)[number];

export const SNAP_CAPTIONS: Record<OsnapKind, string> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  center: 'Centre',
  quadrant: 'Quadrant',
  intersection: 'Intersection',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  extension: 'Extension',
  nearest: 'Nearest',
  tracking: 'Aligned',
  polar: 'Polar',
  grid: 'Grid',
};

export interface OsnapSettings {
  /** Object snaps on at all. */
  objects: boolean;
  kinds: Record<ObjectSnapKind, boolean>;
  /** Alignment lines through acquired points (horizontal / vertical). */
  tracking: boolean;
  /** Polar angle increment in degrees from the previous point; 0 = off. */
  polar: number;
}

export const DEFAULT_OSNAP: OsnapSettings = {
  objects: true,
  kinds: { endpoint: true, midpoint: true, center: true, quadrant: true, intersection: true, perpendicular: true, tangent: true, extension: true, nearest: true },
  tracking: true,
  polar: 15,
};

export interface Guide {
  a: Vec2;
  b: Vec2;
}

export interface OsnapResult {
  point: Vec2;
  kind: OsnapKind | null;
  guides: Guide[];
  /** The element snapped to, when there is one. */
  sourceId?: string;
}

export interface OsnapQuery {
  tolerance: number;
  /** The previous point of the shape being drawn (perpendicular, tangent, polar). */
  anchor?: Vec2 | null;
  /** Points acquired for tracking (hovered snap points, the anchor). */
  trackPoints?: readonly Vec2[];
  settings: OsnapSettings;
  /** Grid step (mm) when grid snapping is on, else null. */
  gridStep?: number | null;
  /** Elements to ignore (the ones being moved or edited). */
  exclude?: ReadonlySet<string>;
}

/** Point kinds win over line kinds; within a tier the closest wins. */
const POINT_PRIORITY: Partial<Record<OsnapKind, number>> = { endpoint: 0, intersection: 1, center: 2, midpoint: 3, quadrant: 4 };
const LINE_PRIORITY: Partial<Record<OsnapKind, number>> = { perpendicular: 0, tangent: 1, extension: 2, nearest: 3 };

interface Candidate {
  point: Vec2;
  kind: OsnapKind;
  distance: number;
  sourceId?: string;
  guides?: Guide[];
}

function project(p: Vec2, a: Vec2, b: Vec2): { t: number; point: Vec2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
  return { t, point: { x: a.x + dx * t, y: a.y + dy * t } };
}

function segmentIntersection(s: DraftSegment, r: DraftSegment): Vec2 | null {
  const d1x = s.b.x - s.a.x;
  const d1y = s.b.y - s.a.y;
  const d2x = r.b.x - r.a.x;
  const d2y = r.b.y - r.a.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const ex = r.a.x - s.a.x;
  const ey = r.a.y - s.a.y;
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: s.a.x + d1x * t, y: s.a.y + d1y * t };
}

function segmentArcIntersections(s: DraftSegment, arc: DraftArc): Vec2[] {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const fx = s.a.x - arc.center.x;
  const fy = s.a.y - arc.center.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - arc.radius * arc.radius;
  const disc = b * b - 4 * a * c;
  if (a < 1e-12 || disc < 0) return [];
  const root = Math.sqrt(disc);
  const out: Vec2[] = [];
  for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const p = { x: s.a.x + dx * t, y: s.a.y + dy * t };
    if (angleOnArc(arc, Math.atan2(p.y - arc.center.y, p.x - arc.center.x))) out.push(p);
  }
  return out;
}

function arcArcIntersections(a: DraftArc, b: DraftArc): Vec2[] {
  const d = distance(a.center, b.center);
  if (d < 1e-9 || d > a.radius + b.radius || d < Math.abs(a.radius - b.radius)) return [];
  const along = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.radius * a.radius - along * along));
  const ux = (b.center.x - a.center.x) / d;
  const uy = (b.center.y - a.center.y) / d;
  const mx = a.center.x + ux * along;
  const my = a.center.y + uy * along;
  const points = [{ x: mx - uy * h, y: my + ux * h }, { x: mx + uy * h, y: my - ux * h }];
  return points.filter((p) => angleOnArc(a, Math.atan2(p.y - a.center.y, p.x - a.center.x)) && angleOnArc(b, Math.atan2(p.y - b.center.y, p.x - b.center.x)));
}

/** Object snap candidates near the cursor (points and line-tier kinds). */
function objectCandidates(geometry: DraftGeometry, cursor: Vec2, query: OsnapQuery): Candidate[] {
  const { tolerance, settings, exclude, anchor } = query;
  const kinds = settings.kinds;
  const out: Candidate[] = [];
  const area = { x: cursor.x - tolerance, y: cursor.y - tolerance, width: tolerance * 2, height: tolerance * 2 };
  const skip = (id: string) => exclude?.has(id) ?? false;

  for (const point of geometry.points) {
    if (!kinds[point.kind] || skip(point.id)) continue;
    const d = distance(point.p, cursor);
    if (d <= tolerance) out.push({ point: point.p, kind: point.kind, distance: d, sourceId: point.id });
  }

  const segments = geometry.segments.filter((segment) => !skip(segment.id) && segmentNear(segment, area));
  const arcs = geometry.arcs.filter((arc) => !skip(arc.id) && Math.abs(distance(arc.center, cursor) - arc.radius) <= tolerance);

  if (kinds.intersection) {
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const s = segments[i]!;
        const r = segments[j]!;
        // Neighbouring pieces of one polyline meet at a vertex that is an endpoint already.
        if (s.id === r.id && (distance(s.b, r.a) < 1e-9 || distance(s.a, r.b) < 1e-9)) continue;
        const p = segmentIntersection(s, r);
        if (p && distance(p, cursor) <= tolerance) out.push({ point: p, kind: 'intersection', distance: distance(p, cursor), sourceId: s.id });
      }
      for (const arc of arcs) {
        for (const p of segmentArcIntersections(segments[i]!, arc)) {
          if (distance(p, cursor) <= tolerance) out.push({ point: p, kind: 'intersection', distance: distance(p, cursor), sourceId: arc.id });
        }
      }
    }
    for (let i = 0; i < arcs.length; i++) {
      for (let j = i + 1; j < arcs.length; j++) {
        for (const p of arcArcIntersections(arcs[i]!, arcs[j]!)) {
          if (distance(p, cursor) <= tolerance) out.push({ point: p, kind: 'intersection', distance: distance(p, cursor), sourceId: arcs[i]!.id });
        }
      }
    }
  }

  for (const segment of segments) {
    if (kinds.nearest) {
      const { t, point } = project(cursor, segment.a, segment.b);
      if (t >= 0 && t <= 1) {
        const d = distance(point, cursor);
        if (d <= tolerance) out.push({ point, kind: 'nearest', distance: d, sourceId: segment.id });
      }
    }
    if (kinds.perpendicular && anchor) {
      const { t, point } = project(anchor, segment.a, segment.b);
      const d = distance(point, cursor);
      if (t >= -1e-9 && t <= 1 + 1e-9 && d <= tolerance && distance(point, anchor) > 1e-6) out.push({ point, kind: 'perpendicular', distance: d, sourceId: segment.id });
    }
  }
  for (const arc of arcs) {
    const angle = Math.atan2(cursor.y - arc.center.y, cursor.x - arc.center.x);
    if (kinds.nearest && angleOnArc(arc, angle)) {
      const point = { x: arc.center.x + Math.cos(angle) * arc.radius, y: arc.center.y + Math.sin(angle) * arc.radius };
      out.push({ point, kind: 'nearest', distance: distance(point, cursor), sourceId: arc.id });
    }
    if (anchor && (kinds.tangent || kinds.perpendicular)) {
      const d = distance(anchor, arc.center);
      if (kinds.tangent && d > arc.radius + 1e-6) {
        const base = Math.atan2(anchor.y - arc.center.y, anchor.x - arc.center.x);
        const spread = Math.acos(arc.radius / d);
        for (const a of [base + spread, base - spread]) {
          if (!angleOnArc(arc, a)) continue;
          const point = { x: arc.center.x + Math.cos(a) * arc.radius, y: arc.center.y + Math.sin(a) * arc.radius };
          const dc = distance(point, cursor);
          if (dc <= tolerance) out.push({ point, kind: 'tangent', distance: dc, sourceId: arc.id });
        }
      }
      if (kinds.perpendicular && d > 1e-6) {
        const a = Math.atan2(anchor.y - arc.center.y, anchor.x - arc.center.x);
        for (const angle of [a, a + Math.PI]) {
          if (!angleOnArc(arc, angle)) continue;
          const point = { x: arc.center.x + Math.cos(angle) * arc.radius, y: arc.center.y + Math.sin(angle) * arc.radius };
          const dc = distance(point, cursor);
          if (dc <= tolerance) out.push({ point, kind: 'perpendicular', distance: dc, sourceId: arc.id });
        }
      }
    }
  }

  if (kinds.extension) {
    // Extensions of straight lines past their ends: only lines whose end is nearby-ish.
    const reach = tolerance * 60;
    const far = { x: cursor.x - reach, y: cursor.y - reach, width: reach * 2, height: reach * 2 };
    for (const segment of geometry.segments) {
      if (skip(segment.id) || !segmentNear(segment, far)) continue;
      const { t, point } = project(cursor, segment.a, segment.b);
      if (t >= 0 && t <= 1) continue;
      const end = t > 1 ? segment.b : segment.a;
      const d = distance(point, cursor);
      if (d <= tolerance && distance(end, point) > tolerance) out.push({ point, kind: 'extension', distance: d, sourceId: segment.id, guides: [{ a: end, b: point }] });
    }
  }
  return out;
}

function best(candidates: Candidate[]): Candidate | null {
  const points = candidates.filter((c) => POINT_PRIORITY[c.kind] !== undefined);
  const pool = points.length ? points : candidates;
  const table = points.length ? POINT_PRIORITY : LINE_PRIORITY;
  let chosen: Candidate | null = null;
  for (const c of pool) {
    if (!chosen) {
      chosen = c;
      continue;
    }
    // Clearly closer wins; within a small band the higher-priority kind wins.
    const band = Math.max(chosen.distance, c.distance) * 0.35;
    if (c.distance < chosen.distance - band || (Math.abs(c.distance - chosen.distance) <= band && (table[c.kind] ?? 9) < (table[chosen.kind] ?? 9))) chosen = c;
  }
  return chosen;
}

/** Tracking / polar lines through the anchor and acquired points; their best combination near the cursor. */
function inferredPoint(cursor: Vec2, query: OsnapQuery): OsnapResult | null {
  const { tolerance, settings, anchor } = query;
  const lines: { origin: Vec2; direction: Vec2; kind: 'tracking' | 'polar' }[] = [];
  if (anchor && settings.polar > 0) {
    const angle = Math.atan2(cursor.y - anchor.y, cursor.x - anchor.x);
    const step = (settings.polar * Math.PI) / 180;
    const snapped = Math.round(angle / step) * step;
    const direction = { x: Math.cos(snapped), y: Math.sin(snapped) };
    const { point, t } = project(cursor, anchor, { x: anchor.x + direction.x, y: anchor.y + direction.y });
    if (t > 0 && distance(point, cursor) <= tolerance) lines.push({ origin: anchor, direction, kind: 'polar' });
  }
  if (settings.tracking) {
    const sources = [...(anchor ? [anchor] : []), ...(query.trackPoints ?? [])];
    for (const source of sources) {
      if (Math.abs(cursor.y - source.y) <= tolerance && Math.abs(cursor.x - source.x) > tolerance) lines.push({ origin: source, direction: { x: 1, y: 0 }, kind: 'tracking' });
      if (Math.abs(cursor.x - source.x) <= tolerance && Math.abs(cursor.y - source.y) > tolerance) lines.push({ origin: source, direction: { x: 0, y: 1 }, kind: 'tracking' });
    }
  }
  if (!lines.length) return null;
  // Two different lines: their intersection (e.g. aligned with two points at once).
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[i]!;
      const m = lines[j]!;
      const denom = l.direction.x * m.direction.y - l.direction.y * m.direction.x;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((m.origin.x - l.origin.x) * m.direction.y - (m.origin.y - l.origin.y) * m.direction.x) / denom;
      const point = { x: l.origin.x + l.direction.x * t, y: l.origin.y + l.direction.y * t };
      if (distance(point, cursor) <= tolerance * 1.5) {
        return { point, kind: l.kind === 'polar' || m.kind === 'polar' ? 'polar' : 'tracking', guides: [{ a: l.origin, b: point }, { a: m.origin, b: point }] };
      }
    }
  }
  const line = lines.find((item) => item.kind === 'polar') ?? lines[0]!;
  const { point } = project(cursor, line.origin, { x: line.origin.x + line.direction.x, y: line.origin.y + line.direction.y });
  return { point, kind: line.kind, guides: [{ a: line.origin, b: point }] };
}

/** The drafting point for a cursor position (see the module comment). */
export function resolveSnap(geometry: DraftGeometry, cursor: Vec2, query: OsnapQuery): OsnapResult {
  if (query.settings.objects) {
    const chosen = best(objectCandidates(geometry, cursor, query));
    if (chosen) return { point: chosen.point, kind: chosen.kind, guides: chosen.guides ?? [], ...(chosen.sourceId ? { sourceId: chosen.sourceId } : {}) };
  }
  const inferred = inferredPoint(cursor, query);
  if (inferred) {
    // A polar / tracking line still lands on the grid along it when the grid is on.
    return inferred;
  }
  if (query.gridStep) {
    const step = query.gridStep;
    return { point: { x: Math.round(cursor.x / step) * step, y: Math.round(cursor.y / step) * step }, kind: 'grid', guides: [] };
  }
  return { point: cursor, kind: null, guides: [] };
}

/** Whether a snap kind is a point worth acquiring for tracking. */
export function acquires(kind: OsnapKind | null): boolean {
  return kind === 'endpoint' || kind === 'midpoint' || kind === 'center' || kind === 'intersection' || kind === 'quadrant';
}
