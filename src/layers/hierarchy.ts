import { isDraft } from 'immer';
import { hostOf, isArchType } from '@/assets/arch-meta';
import { childrenOf, compareIndex, type Element, type ElementTable } from '@/document';

export const LEVEL_LAYER_ARCH_TYPES = [
  'wall',
  'curtain-wall',
  'stair',
  'column',
  'railing',
  'room',
  'floor',
  'ceiling',
  'door',
  'window',
  'facade-element',
] as const;

export function isLevelLayerEligible(element: { meta?: Record<string, unknown> } | undefined | null): boolean {
  return isArchType(element as never, ...LEVEL_LAYER_ARCH_TYPES);
}

function isLevelElement(element: { meta?: Record<string, unknown> } | undefined | null): boolean {
  const level = element?.meta?.['level'];
  return Boolean(level && typeof level === 'object' && !Array.isArray(level));
}

// ---- view-marker index: which view (if any) a section/camera marker paints beneath -------
// Scanning every element to find the view that references a marker is O(n); memoising it per
// `elements` object (same trick as document/query.ts's children index) makes repeated lookups
// (one per element, every time the board or layers tree paints) O(1) amortised instead of O(n²).

const viewMarkerCache = new WeakMap<ElementTable, Map<string, string>>();

/** Markers and views inside a camera/section rig are listed under the rig itself. */
function inRig(elements: ElementTable, element: Element): boolean {
  return Boolean(element.parentId && elements[element.parentId]?.meta?.['viewRig']);
}

function buildViewMarkerIndex(elements: ElementTable): Map<string, string> {
  const index = new Map<string, string>();
  for (const view of Object.values(elements)) {
    const settings = view.meta?.['view3d'] as { sectionLineId?: string; cameraId?: string; planRegionId?: string } | undefined;
    if (!settings) continue;
    if (settings.planRegionId && !index.has(settings.planRegionId)) index.set(settings.planRegionId, view.id);
    if (settings.sectionLineId && !index.has(settings.sectionLineId)) index.set(settings.sectionLineId, view.id);
    if (settings.cameraId && !index.has(settings.cameraId)) index.set(settings.cameraId, view.id);
  }
  return index;
}

function viewMarkerIndex(elements: ElementTable): Map<string, string> {
  // Drafts mutate in place, so their index can never be cached.
  if (isDraft(elements)) return buildViewMarkerIndex(elements);
  let index = viewMarkerCache.get(elements);
  if (!index) {
    index = buildViewMarkerIndex(elements);
    viewMarkerCache.set(elements, index);
  }
  return index;
}

/** A marker is displayed beneath the view it controls, even though both live at board root. */
export function parentViewOf(elements: ElementTable, elementId: string): string | null {
  const element = elements[elementId];
  if (!element || inRig(elements, element)) return null;
  const section = element.meta?.['sectionLine'] as { portalId?: string } | undefined;
  if (section?.portalId && elements[section.portalId]) return section.portalId;
  const camera = element.meta?.['cameraMarker'] as { portalId?: string } | undefined;
  if (camera?.portalId && elements[camera.portalId]) return camera.portalId;
  return viewMarkerIndex(elements).get(elementId) ?? null;
}

/** An eligible architectural element linked to a level is parented by that level if not in another layer. */
export function parentLevelOf(elements: ElementTable, elementId: string): string | null {
  const element = elements[elementId];
  if (!element || !isLevelLayerEligible(element)) return null;
  const constraint = element.meta?.['levelConstraint'];
  if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) return null;
  const levelId = constraint['levelId'];
  if (typeof levelId !== 'string') return null;
  const level = elements[levelId];
  return isLevelElement(level) ? levelId : null;
}

/** The hierarchy shown in Layers is also the board's paint hierarchy. */
export function layerParentOf(elements: ElementTable, elementId: string): string | null {
  const element = elements[elementId];
  if (!element) return null;
  return (
    parentViewOf(elements, elementId) ??
    (hostOf(element) && elements[hostOf(element)!] ? hostOf(element) : null) ??
    (element.parentId && elements[element.parentId] && !isLevelElement(elements[element.parentId]) ? element.parentId : null) ??
    parentLevelOf(elements, elementId) ??
    element.parentId
  );
}

/**
 * Batched `layerParentOf`: builds its view-marker index once, then answers many lookups in
 * O(1) each. `layerParentOf` itself rebuilds that index from scratch on *every* call when
 * `elements` is a draft (it can't be cached — see `viewMarkerIndex`), so a caller that looks up
 * many elements' layer parent from the same draft in one pass (e.g. `moveNestedLayers`, which
 * runs inside every mutating command's `produce()`) would otherwise pay O(n) per lookup, O(n²)
 * for the pass. This builds that index once and answers every lookup in O(1).
 */
export function layerParentResolver(elements: ElementTable): (elementId: string) => string | null {
  const viewMarkers = buildViewMarkerIndex(elements);
  const parentViewOfFast = (element: Element): string | null => {
    if (inRig(elements, element)) return null;
    const section = element.meta?.['sectionLine'] as { portalId?: string } | undefined;
    if (section?.portalId && elements[section.portalId]) return section.portalId;
    const camera = element.meta?.['cameraMarker'] as { portalId?: string } | undefined;
    if (camera?.portalId && elements[camera.portalId]) return camera.portalId;
    return viewMarkers.get(element.id) ?? null;
  };
  return (elementId: string) => {
    const element = elements[elementId];
    if (!element) return null;
    return (
      parentViewOfFast(element) ??
      (hostOf(element) && elements[hostOf(element)!] ? hostOf(element) : null) ??
      (element.parentId && elements[element.parentId] && !isLevelElement(elements[element.parentId]) ? element.parentId : null) ??
      parentLevelOf(elements, elementId) ??
      element.parentId
    );
  };
}

// ---- layer-children index: layerParentOf grouped by parent, built in one O(n) pass --------
// layerPaintOrder and the Layers tree both need "children of X" for many/every element on the
// board; deriving it by filtering the whole table per call (as layerChildrenOf used to) made a
// full board paint O(n²)-O(n³). Building the grouping once per `elements` object and reusing it
// makes both O(n).

const EMPTY: readonly string[] = Object.freeze([]);
const layerChildrenCache = new WeakMap<ElementTable, Map<string | null, string[]>>();

function buildLayerChildrenIndex(elements: ElementTable): Map<string | null, string[]> {
  const byParent = new Map<string | null, Element[]>();
  for (const element of Object.values(elements)) {
    const parent = layerParentOf(elements, element.id);
    const list = byParent.get(parent);
    if (list) list.push(element);
    else byParent.set(parent, [element]);
  }
  const result = new Map<string | null, string[]>();
  for (const [parent, list] of byParent) {
    list.sort((a, b) => compareIndex(a.index, b.index));
    result.set(parent, list.map((element) => element.id));
  }
  return result;
}

function layerChildrenIndex(elements: ElementTable): Map<string | null, string[]> {
  // Drafts mutate in place, so their index can never be cached.
  if (isDraft(elements)) return buildLayerChildrenIndex(elements);
  let index = layerChildrenCache.get(elements);
  if (!index) {
    index = buildLayerChildrenIndex(elements);
    layerChildrenCache.set(elements, index);
  }
  return index;
}

/** Direct hierarchy children, back to front. */
export function layerChildrenOf(elements: ElementTable, parentId: string | null): string[] {
  // Copied out: callers (e.g. the Layers tree) reverse the result in place.
  return [...(layerChildrenIndex(elements).get(parentId) ?? EMPTY)];
}

/** Flattened board paint order: every parent first, followed by its descendants. */
export function layerPaintOrder(elements: ElementTable): string[] {
  const index = layerChildrenIndex(elements);
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id) || !elements[id]) return;
    visited.add(id);
    result.push(id);
    for (const childId of index.get(id) ?? EMPTY) visit(childId);
  };
  for (const id of index.get(null) ?? EMPTY) visit(id);
  // Corrupt/cyclic imported data must remain visible rather than disappearing from the board.
  for (const element of childrenOf(elements, null)) visit(element.id);
  for (const id of Object.keys(elements)) visit(id);
  return result;
}
