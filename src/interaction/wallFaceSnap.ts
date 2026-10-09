/**
 * Cursor snapping for the line-drawing system tools (walls, railings, dividers): wall ends
 * first, then whichever of a wall's centre line / inside face / outside face is nearest.
 * "Inside" is the right-hand side of the wall's drawing direction (y grows downwards).
 */
import { isArchType } from '@/assets/arch-meta';
import type { ArchaiDocument, Element, LineElement } from '@/document';
import { applyToPoint, boundaryEndpoints, distance, linePoints, sub, worldMatrix, type Vec2 } from '@/geometry';

export type BoundarySnapKind = 'endpoint' | 'centre' | 'inside' | 'outside';

export interface BoundarySnap {
  point: Vec2;
  kind: BoundarySnapKind;
  distance: number;
}

function thicknessOf(element: LineElement): number {
  const arch = element.meta?.['arch'];
  const value = arch && typeof arch === 'object' && !Array.isArray(arch) ? arch['thickness'] : undefined;
  return typeof value === 'number' && value > 0 ? value : element.style.strokeWidth;
}

function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } | null {
  const ab = sub(b, a);
  const length2 = ab.x * ab.x + ab.y * ab.y;
  if (length2 <= 0) return null;
  const t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / length2;
  if (t < 0 || t > 1) return null;
  return { point: { x: a.x + ab.x * t, y: a.y + ab.y * t }, t };
}

export function snapToBoundary(doc: ArchaiDocument, point: Vec2, tolerance: number, options: { faces?: boolean; excludeIds?: readonly string[] } = {}): BoundarySnap | null {
  let best: BoundarySnap | null = null;
  const consider = (candidate: Vec2, kind: BoundarySnapKind) => {
    const gap = distance(point, candidate);
    if (gap > tolerance) return;
    if (!best || gap < best.distance) best = { point: candidate, kind, distance: gap };
  };

  for (const endpoint of boundaryEndpoints(doc)) if (!options.excludeIds?.includes(endpoint.elementId)) consider(endpoint.point, 'endpoint');
  if (best) return best;

  for (const element of Object.values(doc.elements)) {
    if (options.excludeIds?.includes(element.id) || !element.visible || element.kind !== 'line' || !isArchType(element as Element, 'wall', 'curtain-wall', 'room-divider')) continue;
    const matrix = worldMatrix(doc.elements, element);
    const points = linePoints(element, 32).map(([x, y]) => applyToPoint(matrix, { x, y }));
    const half = isArchType(element as Element, 'wall', 'curtain-wall') ? thicknessOf(element) / 2 : 0;
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]!;
      const b = points[index + 1]!;
      const centre = projectOnSegment(point, a, b);
      if (!centre) continue;
      consider(centre.point, 'centre');
      if (!options.faces || half <= 0) continue;
      const ab = sub(b, a);
      const length = Math.hypot(ab.x, ab.y) || 1;
      const normal = { x: -ab.y / length, y: ab.x / length }; // right-hand side = inside
      consider({ x: centre.point.x + normal.x * half, y: centre.point.y + normal.y * half }, 'inside');
      consider({ x: centre.point.x - normal.x * half, y: centre.point.y - normal.y * half }, 'outside');
    }
  }
  return best;
}
