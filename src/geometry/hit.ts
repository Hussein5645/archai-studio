/**
 * Hit-testing against the document, not the DOM. Tolerance is in world units (callers derive
 * it from screen pixels / zoom).
 */
import { childrenOf, type ArchaiDocument, type Element, type ElementTable } from '@/document';
import { boundsUnder, localBounds, localMatrix, parentWorldMatrix, worldMatrix } from './bounds';
import { applyToPoint, IDENTITY, invert, multiply, type Mat } from './matrix';
import { distanceToRectEdge, rect, rectContainsPoint, rectContainsRect, rectsIntersect, type Rect } from './rect';
import { distanceToSegment, pointInPolygon, tupleToVec, type Vec2 } from './vec';
import { linePoints } from './curves';

export interface HitOptions {
  /** World-unit tolerance around thin geometry. */
  tolerance: number;
  includeLocked?: boolean;
  includeHidden?: boolean;
  /** Only this element's descendants are tested (sheet mode: the open paper). */
  scopeId?: string | null;
  /** Leaves that may be hit (others are looked through); groups are always descended. */
  accept?: (element: Element) => boolean;
}

function hitLocalShape(elements: ElementTable, element: Element, local: Vec2, tolerance: number): boolean {
  switch (element.kind) {
    case 'rect': {
      const box = rect(0, 0, element.width, element.height);
      if (element.style.fill !== null) return rectContainsPoint(box, local, tolerance);
      return distanceToRectEdge(box, local) <= Math.max(tolerance, element.style.strokeWidth / 2);
    }
    case 'text':
    case 'image':
    case 'instance':
      return rectContainsPoint(rect(0, 0, element.width, element.height), local, tolerance);
    case 'line': {
      const points = linePoints(element, 32).map(tupleToVec);
      const reach = Math.max(tolerance, element.style.strokeWidth / 2);
      const count = element.closed ? points.length : points.length - 1;
      for (let i = 0; i < count; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if (distanceToSegment(local, a, b) <= reach) return true;
      }
      return element.closed && element.style.fill !== null && pointInPolygon(local, points);
    }
    case 'group':
      return rectContainsPoint(localBounds(elements, element), local, tolerance);
  }
}

function isTestable(element: Element, options: HitOptions): boolean {
  if (!element.visible && !options.includeHidden) return false;
  if (element.locked && !options.includeLocked) return false;
  return true;
}

/** Deepest element under `point`, front-most first. Groups are transparent: their children are tested. */
function hitWithin(
  doc: ArchaiDocument,
  parentId: string | null,
  parentWorld: Mat,
  point: Vec2,
  options: HitOptions,
): Element | null {
  const siblings = childrenOf(doc.elements, parentId);
  for (let i = siblings.length - 1; i >= 0; i--) {
    const element = siblings[i]!;
    if (!isTestable(element, options)) continue;
    const m = multiply(parentWorld, localMatrix(element));
    const hasChildren = childrenOf(doc.elements, element.id).length > 0;
    if (hasChildren) {
      const hit = hitWithin(doc, element.id, m, point, options);
      if (hit) return hit;
    }
    if (element.kind === 'group') {
      continue;
    }
    const local = applyToPoint(invert(m), point);
    if ((!options.accept || options.accept(element)) && hitLocalShape(doc.elements, element, local, options.tolerance)) return element;
  }
  return null;
}

/** The deepest (leaf) element under a world point, or null. */
export function hitTest(doc: ArchaiDocument, point: Vec2, options: HitOptions): Element | null {
  const scope = options.scopeId ? doc.elements[options.scopeId] : undefined;
  if (scope) return hitWithin(doc, scope.id, worldMatrix(doc.elements, scope), point, options);
  return hitWithin(doc, null, IDENTITY, point, options);
}

/** Every leaf element under `point`, front-most first (what Tab cycles through on the board). */
export function hitTestAll(doc: ArchaiDocument, point: Vec2, options: HitOptions): Element[] {
  const out: Element[] = [];
  const collect = (parentId: string | null, parentWorld: Mat) => {
    const siblings = childrenOf(doc.elements, parentId);
    for (let i = siblings.length - 1; i >= 0; i--) {
      const element = siblings[i]!;
      if (!isTestable(element, options)) continue;
      const m = multiply(parentWorld, localMatrix(element));
      if (childrenOf(doc.elements, element.id).length > 0) collect(element.id, m);
      if (element.kind === 'group') continue;
      const local = applyToPoint(invert(m), point);
      if ((!options.accept || options.accept(element)) && hitLocalShape(doc.elements, element, local, options.tolerance)) out.push(element);
    }
  };
  const scope = options.scopeId ? doc.elements[options.scopeId] : undefined;
  if (scope) collect(scope.id, worldMatrix(doc.elements, scope));
  else collect(null, IDENTITY);
  return out;
}

/** Root-level elements whose world bounds intersect (or are contained by) `area`. */
export function elementsInArea(
  doc: ArchaiDocument,
  area: Rect,
  mode: 'intersect' | 'contain',
  options: Omit<HitOptions, 'tolerance'> = {},
): Element[] {
  const out: Element[] = [];
  const scopeId = options.scopeId && doc.elements[options.scopeId] ? options.scopeId : null;
  for (const element of childrenOf(doc.elements, scopeId)) {
    if (!isTestable(element, { tolerance: 0, ...options })) continue;
    const bounds = boundsUnder(doc.elements, element, parentWorldMatrix(doc.elements, element));
    const matches = mode === 'contain' ? rectContainsRect(area, bounds) : rectsIntersect(area, bounds);
    if (matches) out.push(element);
  }
  return out;
}
