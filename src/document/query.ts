/**
 * Read-only helpers over the flat element table. The children index is memoised per
 * `elements` object: Immer's structural sharing means it is rebuilt only when an element changed.
 */
import { isDraft } from 'immer';
import { compareIndex } from './order';
import type { ArchaiDocument, Element, GroupElement } from './schema';

export type ElementTable = Readonly<Record<string, Element>>;

const childrenCache = new WeakMap<ElementTable, Map<string | null, Element[]>>();

function buildChildrenIndex(elements: ElementTable): Map<string | null, Element[]> {
  const byParent = new Map<string | null, Element[]>();
  for (const element of Object.values(elements)) {
    const list = byParent.get(element.parentId);
    if (list) list.push(element);
    else byParent.set(element.parentId, [element]);
  }
  for (const list of byParent.values()) list.sort((a, b) => compareIndex(a.index, b.index));
  return byParent;
}

function childrenIndex(elements: ElementTable): Map<string | null, Element[]> {
  // Drafts mutate in place, so their index can never be cached.
  if (isDraft(elements)) return buildChildrenIndex(elements);
  let index = childrenCache.get(elements);
  if (!index) {
    index = buildChildrenIndex(elements);
    childrenCache.set(elements, index);
  }
  return index;
}

const EMPTY: readonly Element[] = Object.freeze([]);

/** Children of `parentId` (null = root), back → front. */
export function childrenOf(elements: ElementTable, parentId: string | null): readonly Element[] {
  return childrenIndex(elements).get(parentId) ?? EMPTY;
}

export function getElement(doc: ArchaiDocument, id: string): Element | undefined {
  return doc.elements[id];
}

export function requireElement(doc: ArchaiDocument, id: string): Element {
  const element = doc.elements[id];
  if (!element) throw new Error(`Unknown element: ${id}`);
  return element;
}

export function isGroup(element: Element): element is GroupElement {
  return element.kind === 'group';
}

/** Ancestors from the direct parent up to the root-level element. */
export function ancestorsOf(elements: ElementTable, id: string): Element[] {
  const out: Element[] = [];
  let current = elements[id];
  const seen = new Set<string>([id]);
  while (current && current.parentId !== null) {
    const parent = elements[current.parentId];
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent);
    current = parent;
  }
  return out;
}

/** The root-level element that contains `id` (or `id` itself when it is at the root). */
export function topLevelAncestor(elements: ElementTable, id: string): Element | undefined {
  const ancestors = ancestorsOf(elements, id);
  return ancestors.length > 0 ? ancestors[ancestors.length - 1] : elements[id];
}

/** All descendants (depth-first, back → front within each level). */
export function descendantsOf(elements: ElementTable, id: string): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [...childrenOf(elements, id)].reverse();
  while (stack.length > 0) {
    const element = stack.pop()!;
    out.push(element);
    const children = childrenOf(elements, element.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return out;
}

export function isAncestor(elements: ElementTable, ancestorId: string, id: string): boolean {
  return ancestorsOf(elements, id).some((a) => a.id === ancestorId);
}

/** Visible only when every ancestor is visible too. */
export function isEffectivelyVisible(elements: ElementTable, id: string): boolean {
  const element = elements[id];
  if (!element || !element.visible) return false;
  return ancestorsOf(elements, id).every((a) => a.visible);
}

/** Locked when the element or any ancestor is locked. */
export function isEffectivelyLocked(elements: ElementTable, id: string): boolean {
  const element = elements[id];
  if (!element) return false;
  return element.locked || ancestorsOf(elements, id).some((a) => a.locked);
}

/** Root elements plus every descendant, in render order (back → front, parents before children). */
export function elementsInRenderOrder(elements: ElementTable): Element[] {
  const out: Element[] = [];
  const visit = (parentId: string | null) => {
    for (const element of childrenOf(elements, parentId)) {
      out.push(element);
      if (childrenOf(elements, element.id).length > 0) visit(element.id);
    }
  };
  visit(null);
  return out;
}

export function lastIndexAmong(elements: ElementTable, parentId: string | null): string | null {
  const siblings = childrenOf(elements, parentId);
  return siblings.length > 0 ? siblings[siblings.length - 1]!.index : null;
}
