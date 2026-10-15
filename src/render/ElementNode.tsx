import { memo } from 'react';
import { useApp, useAppState, useAppStateShallow } from '@/app/context';
import { hostOf } from '@/assets/arch-meta';
import { ancestorsOf, isEffectivelyVisible, type Element, type ElementTable } from '@/document';
import { worldMatrix } from '@/geometry';
import { isWall } from '@/interaction/wallSnap';
import { layerPaintOrder } from '@/layers/hierarchy';
import { boardDoc } from '@/store';
import { inGroup } from '@/selection/groupScope';
import { Shape } from './shapes';
import { wallPathDependencies } from './wallBody';

/**
 * Everything whose change can alter how `id` draws: the element and its ancestors (world matrix,
 * visibility, stair/graph parents), a section line's portal (label), and for walls the joined
 * walls and openings plus their ancestor and host chains (world matrices, opening elevations).
 * The element itself comes first.
 */
function renderDependencies(elements: ElementTable, id: string): readonly Element[] {
  const element = elements[id];
  if (!element) return [];
  const out: Element[] = [];
  const seen = new Set<string>();
  const add = (itemId: string) => {
    const item = elements[itemId];
    if (!item || seen.has(itemId)) return;
    seen.add(itemId);
    out.push(item);
    for (const ancestor of ancestorsOf(elements, itemId)) {
      if (seen.has(ancestor.id)) continue;
      seen.add(ancestor.id);
      out.push(ancestor);
    }
    const host = hostOf(item);
    if (host) add(host);
  };
  add(id);
  const sectionLine = element.meta?.['sectionLine'];
  if (sectionLine && typeof sectionLine === 'object' && !Array.isArray(sectionLine) && typeof sectionLine['portalId'] === 'string') add(sectionLine['portalId']);
  if (element.kind === 'line' && !element.closed && isWall(element)) {
    for (const dependency of wallPathDependencies(element, elements)) add(dependency);
  }
  return out;
}

// Keyed by the (immutable) element table, so the ~1 selector per node that runs on every store
// update (pointermoves while panning included) costs a lookup unless the document changed.
const dependencyCache = new WeakMap<ElementTable, Map<string, readonly Element[]>>();

function cachedDependencies(elements: ElementTable, id: string): readonly Element[] {
  let byId = dependencyCache.get(elements);
  if (!byId) {
    byId = new Map();
    dependencyCache.set(elements, byId);
  }
  let dependencies = byId.get(id);
  if (!dependencies) {
    dependencies = renderDependencies(elements, id);
    byId.set(id, dependencies);
  }
  return dependencies;
}

/**
 * One document element in world coordinates. Flattening the hierarchy lets hosted elements and
 * linked view markers participate in the exact same z-order as ordinary parented elements.
 *
 * It re-renders only when one of its render dependencies changes, not on every edit anywhere in
 * the document: with ~1000 elements, subscribing to the whole table made a one-element drag
 * re-render every node on every pointermove.
 */
export const ElementNode = memo(function ElementNode({ id }: { id: string }) {
  const { store } = useApp();
  const dependencies = useAppStateShallow((s) => cachedDependencies(boardDoc(s).elements, id));
  const editing = useAppState((s) => s.ui.editingTextId === id);
  const outsideGroup = useAppState((s) => Boolean(s.ui.groupEditId) && !inGroup(boardDoc(s).elements, s.ui.groupEditId, id));
  const definitions = useAppState((s) => boardDoc(s).definitions);
  const blobs = useAppState((s) => boardDoc(s).blobs);
  const workspace = useAppState((s) => boardDoc(s).workspace);
  const element = dependencies[0];
  // The live table: identical to the subscribed one for everything this node reads.
  const elements = boardDoc(store.getState()).elements;
  if (!element || editing || !isEffectivelyVisible(elements, id)) return null;
  const matrix = worldMatrix(elements, element);
  return (
    <g transform={`matrix(${matrix.join(' ')})`} data-element-id={id} opacity={outsideGroup ? 0.2 : undefined} data-outside-group={outsideGroup || undefined}>
      {element.kind !== 'group' && <Shape element={element} context={{ definitions, blobs, elements, workspace }} />}
    </g>
  );
});

export function RootElements() {
  const paintIds = useAppStateShallow((s) => layerPaintOrder(boardDoc(s).elements));
  return (
    <>
      {paintIds.map((id) => (
        <ElementNode key={id} id={id} />
      ))}
    </>
  );
}
