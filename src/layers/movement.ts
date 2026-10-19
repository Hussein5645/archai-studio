import type { Element, ElementTable, JsonValue } from '@/document';
import { applyToPoint, applyToVector, invert, parentWorldMatrix, worldMatrix, type Vec2 } from '@/geometry';
import { geoToLocal, mapFrame, type GeoPoint } from '@/analysis/mapGeometry';
import { layerParentResolver } from './hierarchy';

type MapPlacement = { lat: number; lon: number; mapCenter?: GeoPoint; anchor?: { x: number; y: number } };

function mapPlacement(item: Element): MapPlacement | null {
  const value = item.meta?.['location'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const location = value as unknown as MapPlacement;
  return typeof location.lat === 'number' && typeof location.lon === 'number' ? location : null;
}

/** A fixed place on a map's ground (its imagery centre), or null for other elements. */
function groundReference(item: Element): GeoPoint | null {
  const location = mapPlacement(item);
  return location ? (location.mapCenter ?? { lat: location.lat, lon: location.lon }) : null;
}

/** Where a place on a map's ground is on the board (see analysis/model locationFrame). */
function groundPoint(table: ElementTable, item: Element, place: GeoPoint): Vec2 | null {
  const location = mapPlacement(item);
  if (!location) return null;
  const width = 'width' in item ? item.width : 0;
  const height = 'height' in item ? item.height : 0;
  const frame = mapFrame(location.mapCenter ?? { lat: location.lat, lon: location.lon }, location.anchor ?? { x: width / 2, y: height / 2 });
  return applyToPoint(worldMatrix(table, item), geoToLocal(frame, place));
}

/** Persist movement for Layers links that are not already inherited through parentId. */
export function moveNestedLayers(before: ElementTable, elements: ElementTable): void {
  // A map's rectangle crops a fixed geographic plane. Re-express its old world
  // anchor after frame movement/resize, including movement of an ancestor group.
  for (const element of Object.values(elements)) {
    const old = before[element.id];
    if (!old || !mapPlacement(old) || !mapPlacement(element)) continue;
    const oldMatrix = worldMatrix(before, old), matrix = worldMatrix(elements, element);
    const resized = 'width' in old && 'width' in element && (old.width !== element.width || ('height' in old && 'height' in element && old.height !== element.height));
    if (!resized && oldMatrix.every((value, index) => Math.abs(value - matrix[index]!) < 1e-9)) continue;
    const reference = groundReference(old)!;
    const world = groundPoint(before, old, reference)!;
    const local = applyToPoint(invert(matrix), world);
    const location = element.meta!['location'] as Record<string, JsonValue>;
    location['anchor'] = { x: local.x, y: local.y };
  }
  // `elements` is a command's draft here, so a plain layerParentOf(elements, id) call would
  // rebuild its view-marker index from scratch every time (see layerParentResolver); resolving
  // every element's layer parent from one shared index keeps this O(n) instead of O(n²).
  const parentOfElements = layerParentResolver(elements);
  const parentOfBefore = layerParentResolver(before);
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = elements[id];
    const old = before[id];
    if (!element || !old) return;
    const parentId = parentOfElements(id);
    if (!parentId || parentId !== parentOfBefore(id)) return;
    visit(parentId);
    if (element.parentId === parentId || element.parentId !== old.parentId) return;
    // An explicit child move (or an existing host operation) already owns its position.
    if (element.x !== old.x || element.y !== old.y) return;
    const parent = elements[parentId];
    const oldParent = before[parentId];
    if (!parent || !oldParent) return;
    const origin = (table: ElementTable, item: typeof element) => applyToPoint(parentWorldMatrix(table, item), { x: item.x, y: item.y });
    // A 1:1 map carries what is placed on its ground along with its imagery, not its rect corner:
    // resizing a map (or re-centring it) moves the corner without moving the ground.
    const reference = groundReference(oldParent);
    const a = reference ? groundPoint(before, oldParent, reference)! : origin(before, oldParent);
    const b = reference ? (groundPoint(elements, parent, reference) ?? origin(elements, parent)) : origin(elements, parent);
    const c = origin(before, old), d = origin(elements, element);
    const delta = applyToVector(invert(parentWorldMatrix(elements, element)), { x: b.x - a.x - (d.x - c.x), y: b.y - a.y - (d.y - c.y) });
    if (Math.abs(delta.x) > 1e-9) element.x += delta.x;
    if (Math.abs(delta.y) > 1e-9) element.y += delta.y;
  };
  for (const id of Object.keys(elements)) visit(id);
}
