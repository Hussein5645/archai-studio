import { isDraft } from 'immer';
import type { ArchaiDocument, Element, ElementTable, LineElement } from '@/document';
import { angleOf, applyToPoint, distance, invert, pointAtLine, projectOnLine, rotate, sub, worldMatrix, type Vec2 } from '@/geometry';
import { archOf, archTypeOf, hostOf } from '@/assets/arch-meta';

export interface WallOpening {
  wallId: string;
  segment: number;
  start: number;
  end: number;
  /** Centre distance along an analytic curved wall. */
  curveAlong?: number;
}

export interface WallSnap {
  x: number;
  y: number;
  rotation: number;
  thickness: number;
  opening: WallOpening;
  distance: number;
}

function archMeta(element: Element): Record<string, unknown> | null {
  const value = element.meta?.['arch'];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isWall(element: Element): element is LineElement {
  return element.kind === 'line' && archMeta(element)?.['type'] === 'wall';
}

/**
 * Finds the closest usable wall segment and returns a placement whose local X-axis follows it.
 * `centerY` is the asset's local Y coordinate that should sit on the wall centre line.
 */
export function findWallSnap(
  doc: ArchaiDocument,
  point: Vec2,
  width: number,
  centerY: number,
  screenToleranceInWorld: number,
): WallSnap | null {
  let best: WallSnap | null = null;

  for (const element of Object.values(doc.elements)) {
    if (!element.visible || !isWall(element)) continue;
    const matrix = worldMatrix(doc.elements, element);
    const localPoint = applyToPoint(invert(matrix), point);
    const thicknessValue = archMeta(element)?.['thickness'];
    const thickness = typeof thicknessValue === 'number' && thicknessValue > 0 ? thicknessValue : element.style.strokeWidth;

    if (element.path) {
      const projected = projectOnLine(element, localPoint);
      if (!projected || projected.totalLength < width) continue;
      const along = Math.max(width / 2, Math.min(projected.totalLength - width / 2, projected.along));
      const located = pointAtLine(element, along);
      if (!located) continue;
      const worldCenter = applyToPoint(matrix, located.point);
      const worldAhead = applyToPoint(matrix, { x: located.point.x + located.tangent.x, y: located.point.y + located.tangent.y });
      const rotation = angleOf(sub(worldAhead, worldCenter));
      const gap = distance(point, worldCenter);
      if (gap > thickness / 2 + screenToleranceInWorld || (best && gap >= best.distance)) continue;
      const normal = rotate({ x: 1, y: 0 }, rotation + 90);
      best = {
        x: worldCenter.x - Math.cos((rotation * Math.PI) / 180) * width / 2 - normal.x * centerY,
        y: worldCenter.y - Math.sin((rotation * Math.PI) / 180) * width / 2 - normal.y * centerY,
        rotation,
        thickness,
        opening: { wallId: element.id, segment: 0, start: along - width / 2, end: along + width / 2, curveAlong: along },
        distance: gap,
      };
      continue;
    }

    for (let segment = 0; segment < element.points.length - 1; segment++) {
      const a = { x: element.points[segment]![0], y: element.points[segment]![1] };
      const b = { x: element.points[segment + 1]![0], y: element.points[segment + 1]![1] };
      const ab = sub(b, a);
      const length = Math.hypot(ab.x, ab.y);
      if (length < width || length <= 0) continue;

      const along = ((localPoint.x - a.x) * ab.x + (localPoint.y - a.y) * ab.y) / length;
      const clampedCenter = Math.max(width / 2, Math.min(length - width / 2, along));
      const unit = { x: ab.x / length, y: ab.y / length };
      const localCenter = { x: a.x + unit.x * clampedCenter, y: a.y + unit.y * clampedCenter };
      const worldCenter = applyToPoint(matrix, localCenter);
      const gap = distance(point, worldCenter);
      if (gap > thickness / 2 + screenToleranceInWorld || (best && gap >= best.distance)) continue;

      const localStart = { x: a.x + unit.x * (clampedCenter - width / 2), y: a.y + unit.y * (clampedCenter - width / 2) };
      const worldStart = applyToPoint(matrix, localStart);
      const worldEnd = applyToPoint(matrix, { x: localStart.x + unit.x, y: localStart.y + unit.y });
      const rotation = angleOf(sub(worldEnd, worldStart));
      const normal = rotate({ x: 1, y: 0 }, rotation + 90);

      best = {
        x: worldStart.x - normal.x * centerY,
        y: worldStart.y - normal.y * centerY,
        rotation,
        thickness,
        opening: {
          wallId: element.id,
          segment,
          start: clampedCenter - width / 2,
          end: clampedCenter + width / 2,
        },
        distance: gap,
      };
    }
  }

  return best;
}

export function openingOf(element: Element): WallOpening | null {
  const opening = archMeta(element)?.['opening'];
  if (!opening || typeof opening !== 'object' || Array.isArray(opening)) return null;
  const value = opening as Record<string, unknown>;
  if (
    typeof value['wallId'] !== 'string' ||
    typeof value['segment'] !== 'number' ||
    typeof value['start'] !== 'number' ||
    typeof value['end'] !== 'number'
  ) {
    return null;
  }
  return { wallId: value['wallId'], segment: value['segment'], start: value['start'], end: value['end'], ...(typeof value['curveAlong'] === 'number' ? { curveAlong: value['curveAlong'] } : {}) };
}

export interface WallOpeningEntry {
  element: Element;
  opening: WallOpening;
}

/**
 * Dynamically derives or verifies a wall opening for a door or window hosted on/near a wall.
 * Recalculates position along the wall if the element moved, while respecting explicit metadata.
 */
export function resolveWallOpening(
  wall: LineElement,
  element: Element,
  elements: ElementTable,
): WallOpening | null {
  const type = archTypeOf(element);
  if (type !== 'door' && type !== 'window' && type !== 'facade-element') return null;

  const storedOpening = openingOf(element);
  const host = hostOf(element);

  // Must be linked to this wall via host or stored opening
  if (host !== wall.id && storedOpening?.wallId !== wall.id) return null;

  const width = 'width' in element && typeof element.width === 'number' && element.width > 0 ? element.width : 900;
  const arch = archOf(element);
  const mountOffset = typeof arch?.['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : 0;

  const localCenter = { x: width / 2, y: mountOffset };
  const elementMatrix = worldMatrix(elements, element);
  const worldCenter = applyToPoint(elementMatrix, localCenter);

  const wallMatrix = worldMatrix(elements, wall);
  const wallLocalCenter = applyToPoint(invert(wallMatrix), worldCenter);

  const thicknessValue = archMeta(wall)?.['thickness'];
  const wallThick = typeof thicknessValue === 'number' && thicknessValue > 0 ? thicknessValue : wall.style.strokeWidth;
  const maxTolerance = Math.max(300, wallThick * 2.5);

  if (wall.path) {
    const projected = projectOnLine(wall, wallLocalCenter);
    if (projected) {
      const projPoint = pointAtLine(wall, projected.along);
      const dist = projPoint ? distance(wallLocalCenter, projPoint.point) : 0;
      if (dist <= maxTolerance) {
        const along = projected.along;
        return {
          wallId: wall.id,
          segment: 0,
          start: along - width / 2,
          end: along + width / 2,
          curveAlong: along,
        };
      }
    }
  } else if (wall.points && wall.points.length >= 2) {
    let bestSegment = 0;
    let bestDist = Infinity;
    let bestAlong = 0;

    for (let segment = 0; segment < wall.points.length - 1; segment++) {
      const a = { x: wall.points[segment]![0], y: wall.points[segment]![1] };
      const b = { x: wall.points[segment + 1]![0], y: wall.points[segment + 1]![1] };
      const ab = sub(b, a);
      const len = Math.hypot(ab.x, ab.y);
      if (len <= 0) continue;

      const along = ((wallLocalCenter.x - a.x) * ab.x + (wallLocalCenter.y - a.y) * ab.y) / len;
      const clamped = Math.max(0, Math.min(len, along));
      const closest = { x: a.x + (ab.x / len) * clamped, y: a.y + (ab.y / len) * clamped };
      const dist = distance(wallLocalCenter, closest);

      if (dist < bestDist) {
        bestDist = dist;
        bestSegment = segment;
        bestAlong = along;
      }
    }

    if (bestDist <= maxTolerance) {
      return {
        wallId: wall.id,
        segment: bestSegment,
        start: bestAlong - width / 2,
        end: bestAlong + width / 2,
      };
    }
    return null;
  }

  // Fallback to stored opening only if wall had no testable geometry
  if (storedOpening && storedOpening.wallId === wall.id) {
    return storedOpening;
  }

  return null;
}

// ---- wall-candidates index: which doors/windows/facade-elements might belong to a wall -----
// wallOpeningsFor used to scan every element to find the handful hosted on one wall, making
// every wall's render (2D body path, 3D cuts) O(n) — O(n²) for a full-board render with n
// walls. Indexing "host or stored opening → wallId" once per `elements` object (same trick as
// layers/hierarchy.ts's view-marker index) makes it O(1) amortised per wall instead.

const wallCandidatesCache = new WeakMap<ElementTable, Map<string, Element[]>>();

function buildWallCandidatesIndex(elements: ElementTable): Map<string, Element[]> {
  const index = new Map<string, Element[]>();
  const add = (wallId: string, element: Element) => {
    const list = index.get(wallId);
    if (list) list.push(element);
    else index.set(wallId, [element]);
  };
  for (const element of Object.values(elements)) {
    if (!element.visible) continue;
    const type = archTypeOf(element);
    if (type !== 'door' && type !== 'window' && type !== 'facade-element') continue;
    const host = hostOf(element);
    if (host) add(host, element);
    // A door/window is normally hosted and stores the same wall it's linked to, but the two can
    // differ (an explicit meta.host override) — checked independently to match how
    // resolveWallOpening itself treats them.
    const stored = openingOf(element);
    if (stored && stored.wallId !== host) add(stored.wallId, element);
  }
  return index;
}

function wallCandidatesIndex(elements: ElementTable): Map<string, Element[]> {
  // Drafts mutate in place, so their index can never be cached.
  if (isDraft(elements)) return buildWallCandidatesIndex(elements);
  let index = wallCandidatesCache.get(elements);
  if (!index) {
    index = buildWallCandidatesIndex(elements);
    wallCandidatesCache.set(elements, index);
  }
  return index;
}

const EMPTY: readonly Element[] = Object.freeze([]);

/** Doors/windows/facade elements that may cut this wall (hosted or linked to it), unresolved. */
export function wallOpeningCandidates(wallId: string, elements: ElementTable): readonly Element[] {
  return wallCandidatesIndex(elements).get(wallId) ?? EMPTY;
}

/**
 * Returns all door/window openings associated with this wall, derived dynamically from current element positions.
 */
export function wallOpeningsFor(wall: LineElement, elements: ElementTable): WallOpeningEntry[] {
  const result: WallOpeningEntry[] = [];
  for (const element of wallCandidatesIndex(elements).get(wall.id) ?? EMPTY) {
    const opening = resolveWallOpening(wall, element, elements);
    if (opening) {
      result.push({ element, opening });
    }
  }
  return result;
}
