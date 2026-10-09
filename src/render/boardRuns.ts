/**
 * The board's paint order split into runs: consecutive SVG-drawn elements share one paint layer,
 * and live HTML content (3D/section portals, AI portals, analysis cards, map overlays) sits
 * between them. The board and the exporters both walk these runs, so an export stacks exactly
 * like the screen.
 */
import type { ElementTable } from '@/document';
import { layerChildrenOf, layerPaintOrder } from '@/layers/hierarchy';
import { sheetSubtree, sheetViewOf } from '@/sheets/model';

export type BoardRun =
  | { kind: 'svg'; ids: string[] }
  /** `hidden`: kept mounted (invisible) because a sheet's view frame renders through it. */
  | { kind: 'portal'; id: string; hidden?: boolean }
  | { kind: 'aiPortal'; id: string }
  | { kind: 'analysis'; ids: string[] }
  | { kind: 'mapOverlay'; id: string };

/**
 * `sheetId` limits the runs to that paper and what is painted under it (sheet mode). The board
 * marks its world with `data-sheet` so exporters rebuild the same runs.
 */
export function boardRuns(elements: ElementTable, sheetId: string | null = null): BoardRun[] {
  const include = sheetId && elements[sheetId] ? sheetSubtree(elements, sheetId) : null;
  const runs: BoardRun[] = [];
  if (include) {
    // One hidden portal per source, however many frames on the sheet show it.
    const sources = new Set<string>();
    for (const id of include) {
      const view = sheetViewOf(elements[id]);
      if (view?.source === 'view' && view.sourceId && elements[view.sourceId] && !include.has(view.sourceId)) sources.add(view.sourceId);
    }
    for (const id of sources) runs.push({ kind: 'portal', id, hidden: true });
  }
  // A map's pin, boundary and labels paint right after the map and what lies under it in
  // Layers (its context and concept), so anything else placed on the map stays on top.
  const openMaps: { id: string; family: Set<string> }[] = [];
  const closeMaps = (id: string | null) => {
    while (openMaps.length && (id === null || !openMaps.at(-1)!.family.has(id))) runs.push({ kind: 'mapOverlay', id: openMaps.pop()!.id });
  };
  for (const id of layerPaintOrder(elements)) {
    if (include && !include.has(id)) continue;
    closeMaps(id);
    const element = elements[id];
    if (element?.kind === 'rect' && element.meta?.['location']) {
      const family = new Set<string>();
      const collect = (parentId: string) => { for (const child of layerChildrenOf(elements, parentId)) if (!family.has(child)) { family.add(child); collect(child); } };
      collect(id);
      openMaps.push({ id, family });
    }
    if (element?.kind === 'rect' && element.meta?.['view3d']) {
      runs.push({ kind: 'portal', id });
      continue;
    }
    if (element?.kind === 'rect' && element.meta?.['aiPortal']) {
      runs.push({ kind: 'aiPortal', id });
      continue;
    }
    const last = runs.at(-1);
    if (element?.kind === 'rect' && (element.meta?.['analysis'] || element.meta?.['location'])) {
      // The SVG rect still carries hit-testing; the card is painted over it.
      if (last?.kind === 'svg') last.ids.push(id);
      else runs.push({ kind: 'svg', ids: [id] });
      runs.push({ kind: 'analysis', ids: [id] });
      continue;
    }
    if (last?.kind === 'svg') last.ids.push(id);
    else runs.push({ kind: 'svg', ids: [id] });
  }
  closeMaps(null);
  return runs;
}
