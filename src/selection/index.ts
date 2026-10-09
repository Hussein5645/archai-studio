/**
 * Selection is UI state: a list of element ids. These helpers keep it well-formed (no
 * duplicates, no missing ids, never an element together with one of its ancestors).
 */
import { isAncestor, type Element, type ElementTable } from '@/document';
import { boundsOfIds, type Rect } from '@/geometry';

export function normalizeSelection(elements: ElementTable, ids: readonly string[]): string[] {
  const unique = [...new Set(ids)].filter((id) => id in elements);
  return unique.filter((id) => !unique.some((other) => other !== id && isAncestor(elements, other, id)));
}

export function selectionBounds(elements: ElementTable, ids: readonly string[]): Rect | null {
  return boundsOfIds(elements, ids);
}

/**
 * Canvas selection policy: clicking inside a group selects the group, unless `inside` is set
 * (double-click), in which case the leaf element itself is selected.
 */
export function selectableTarget(elements: ElementTable, hit: Element, inside = false, scopeId: string | null = null): Element {
  if (inside || hit.meta?.['parametricMarker']) return hit;
  let target = hit;
  const seen = new Set<string>();
  // In sheet mode the open paper acts as the board root: its children are the top-level items.
  while (target.parentId && target.parentId !== scopeId && !seen.has(target.id) && !target.meta?.['viewRig']) {
    seen.add(target.id);
    const parent = elements[target.parentId];
    // A camera/section rig's view and marker are picked on their own (the rig has its handle),
    // as are the sketches and notes on an annotation layer.
    if (!parent || parent.meta?.['parametricGraph'] || parent.meta?.['parametricMarker'] || parent.meta?.['viewRig'] || parent.meta?.['annotationLayer']) break;
    target = parent;
  }
  return target;
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
