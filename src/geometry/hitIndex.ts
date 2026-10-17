/** Immutable-document broad phase for pointer picking. Exact shape tests stay in hit.ts. */
import { isDraft } from 'immer';
import { childrenOf, type Element, type ElementTable } from '@/document';
import { localMatrix } from './bounds';
import { IDENTITY, invert, multiply, transformRect, type Mat } from './matrix';
import { boundsOfPoints, expandRect, rect, rectsIntersect, unionRects, type Rect } from './rect';
import { linePoints } from './curves';
import { tupleToVec, type Vec2 } from './vec';

interface Entry {
  element: Element;
  ancestors: readonly Element[];
  inverse: Mat;
  bounds: Rect;
  order: number;
}

interface Branch {
  bounds: Rect;
  entries?: Entry[];
  left?: Branch;
  right?: Branch;
}

const cache = new WeakMap<ElementTable, Branch>();

function branch(entries: Entry[]): Branch {
  const bounds = unionRects(entries.map((entry) => entry.bounds)) ?? rect(0, 0, 0, 0);
  if (entries.length <= 8) return { bounds, entries };
  const axis = bounds.width >= bounds.height ? 'x' : 'y';
  const size = axis === 'x' ? 'width' : 'height';
  entries.sort((a, b) => a.bounds[axis] + a.bounds[size] / 2 - b.bounds[axis] - b.bounds[size] / 2);
  const middle = entries.length >>> 1;
  return { bounds, left: branch(entries.slice(0, middle)), right: branch(entries.slice(middle)) };
}

function build(elements: ElementTable): Branch {
  const entries: Entry[] = [];
  const visit = (parentId: string | null, parentWorld: Mat, ancestors: readonly Element[]) => {
    for (const element of childrenOf(elements, parentId)) {
      const matrix = multiply(parentWorld, localMatrix(element));
      // Match hitWithin's paint order: descendants are tested before their parent's shape.
      if (element.kind !== 'group') {
        const local = element.kind === 'line'
          ? boundsOfPoints(linePoints(element, 32).map(tupleToVec))
          : rect(0, 0, element.width, element.height);
        entries.push({
          element, ancestors, inverse: invert(matrix), order: entries.length,
          bounds: transformRect(matrix, expandRect(local, element.kind === 'rect' || element.kind === 'line' ? element.style.strokeWidth / 2 : 0)),
        });
      }
      if (childrenOf(elements, element.id).length) visit(element.id, matrix, [element, ...ancestors]);
    }
  };
  visit(null, IDENTITY, []);
  return branch(entries);
}

/** Null keeps small documents and mutable command drafts on the simple traversal path. */
export function indexedHitCandidates(
  elements: ElementTable,
  point: Vec2,
  tolerance: number,
): Entry[] | null {
  if (isDraft(elements)) return null;
  let root = cache.get(elements);
  if (!root) {
    if (Object.keys(elements).length < 256) return null;
    root = build(elements);
    cache.set(elements, root);
  }
  // Local tolerance is a square; rotation can increase its world AABB reach by sqrt(2).
  const reach = Math.max(0, tolerance) * Math.SQRT2;
  const area = rect(point.x - reach, point.y - reach, reach * 2, reach * 2);
  const result: Entry[] = [];
  const query = (node: Branch) => {
    if (!rectsIntersect(node.bounds, area)) return;
    if (node.entries) {
      for (const entry of node.entries) if (rectsIntersect(entry.bounds, area)) result.push(entry);
    } else {
      query(node.left!);
      query(node.right!);
    }
  };
  query(root);
  return result.sort((a, b) => b.order - a.order);
}
