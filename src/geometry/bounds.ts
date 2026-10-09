/**
 * Element transforms and bounds. Everything here is pure and renderer-agnostic so that the
 * SVG renderer stays replaceable and an automated agent can ask the same questions the UI does.
 */
import { ancestorsOf, childrenOf, type Element, type ElementTable } from '@/document';
import { applyToPoint, compose, fromTRS, multiply, transformRect, type Mat } from './matrix';
import { boundsOfPoints, EMPTY_RECT, expandRect, rect, rectCorners, unionRects, type Rect } from './rect';
import { tupleToVec, type Vec2 } from './vec';
import { linePoints } from './curves';

/** Element-local → parent space. */
export function localMatrix(element: Element): Mat {
  return fromTRS(element.x, element.y, element.rotation);
}

/** Bounds in the element's own local space (before its own transform). */
export function localBounds(elements: ElementTable, element: Element): Rect {
  switch (element.kind) {
    case 'rect':
    case 'text':
    case 'image':
    case 'instance':
      return rect(0, 0, element.width, element.height);
    case 'line':
      return expandRect(boundsOfPoints(linePoints(element).map(tupleToVec)), element.style.strokeWidth / 2);
    case 'group': {
      const rects = childrenOf(elements, element.id)
        .filter((child) => child.visible)
        .map((child) => transformRect(localMatrix(child), localBounds(elements, child)));
      return unionRects(rects) ?? EMPTY_RECT;
    }
  }
}

/** Parent space → world space for the element's parent chain. */
export function parentWorldMatrix(elements: ElementTable, element: Element): Mat {
  const ancestors = ancestorsOf(elements, element.id); // nearest first
  return compose(...ancestors.reverse().map(localMatrix));
}

/** Element-local → world space. */
export function worldMatrix(elements: ElementTable, element: Element): Mat {
  return multiply(parentWorldMatrix(elements, element), localMatrix(element));
}

/** Axis-aligned world bounds; groups use the union of their children for a tight box. */
export function boundsUnder(elements: ElementTable, element: Element, parentWorld: Mat): Rect {
  const m = multiply(parentWorld, localMatrix(element));
  if (element.kind === 'group') {
    const rects = childrenOf(elements, element.id)
      .filter((child) => child.visible)
      .map((child) => boundsUnder(elements, child, m));
    return unionRects(rects) ?? transformRect(m, EMPTY_RECT);
  }
  return transformRect(m, localBounds(elements, element));
}

export function worldBounds(elements: ElementTable, element: Element): Rect {
  return boundsUnder(elements, element, parentWorldMatrix(elements, element));
}

export function boundsOfIds(elements: ElementTable, ids: readonly string[]): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const element = elements[id];
    if (element) rects.push(worldBounds(elements, element));
  }
  return unionRects(rects);
}

/** The four world-space corners of the element's local bounds (an oriented box). */
export function orientedCorners(elements: ElementTable, element: Element): [Vec2, Vec2, Vec2, Vec2] {
  const m = worldMatrix(elements, element);
  const corners = rectCorners(localBounds(elements, element));
  return [
    applyToPoint(m, corners[0]),
    applyToPoint(m, corners[1]),
    applyToPoint(m, corners[2]),
    applyToPoint(m, corners[3]),
  ];
}

/** World-space bounds of every root element, in render order. */
export function rootBounds(elements: ElementTable): Rect | null {
  const rects = childrenOf(elements, null)
    .filter((element) => element.visible)
    .map((element) => worldBounds(elements, element));
  return unionRects(rects);
}
