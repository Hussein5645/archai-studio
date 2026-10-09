/**
 * Openings in a floor or ceiling slab (shafts, stair voids, atriums): closed loops inside its
 * boundary, kept in `meta.arch.openings` in the slab's own frame. Each has its sampled points (for
 * drawing, the 3D solid and the area) and, when drawn with arcs or curves, the exact path (so the
 * profile mode can edit it again exactly).
 */
import type { CurvePath, Element, JsonValue } from '@/document';

export interface SlabOpening {
  points: [number, number][];
  path?: CurvePath;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The openings of a slab (empty for anything else). */
export function slabOpenings(element: Element | null | undefined): SlabOpening[] {
  const openings = record(element?.meta?.['arch'])?.['openings'];
  if (!Array.isArray(openings)) return [];
  const out: SlabOpening[] = [];
  for (const value of openings) {
    const opening = record(value);
    const points = opening?.['points'];
    if (!Array.isArray(points) || points.length < 3) continue;
    const valid = points.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number');
    if (valid.length < 3) continue;
    out.push({ points: valid, ...(opening?.['path'] ? { path: opening['path'] as CurvePath } : {}) });
  }
  return out;
}

/** Openings as JSON for `meta.arch.openings`. */
export function openingsJson(openings: readonly SlabOpening[]): JsonValue {
  return openings.map((opening) => ({ points: opening.points, ...(opening.path ? { path: opening.path } : {}) })) as unknown as JsonValue;
}

/** Whether a point lies inside a polygon (even-odd). */
export function pointInPolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
