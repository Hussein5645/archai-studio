/**
 * The board's point snapping in one place: object snaps (end, mid, centre, intersection,
 * nearest...), tracking and polar lines from an anchor, then the grid. Used by the drafting tools
 * (./drafting.ts) and by editors drawn over the board, such as a map's site boundary.
 */
import type { AppState } from '@/store';
import type { ElementTable } from '@/document';
import { worldMatrix, type Vec2 } from '@/geometry';
import { draftGeometry } from '@/drafting/geometry';
import { resolveSnap, SNAP_CAPTIONS, type OsnapResult } from '@/drafting/osnap';
import { gridStepForZoom } from './snap';

export interface BoardSnapOptions {
  /** Size of one screen pixel in millimetres (the snap reach is 10 px). */
  pixel: number;
  anchor?: Vec2 | null;
  /** Points acquired for tracking lines. */
  trackPoints?: readonly Vec2[];
  /** Element ids not to snap to (what is being moved). */
  exclude?: ReadonlySet<string>;
}

export function snapBoardPoint(state: AppState, world: Vec2, options: BoardSnapOptions): OsnapResult {
  const paperId = state.ui.sheet?.paperId ?? null;
  const paper = paperId ? state.doc.elements[paperId] : undefined;
  const geometry = draftGeometry(state.doc.elements as ElementTable, paper ? paper.id : null, paper ? worldMatrix(state.doc.elements as ElementTable, paper) : undefined);
  const grid = state.doc.workspace.snap.enabled && !paper ? gridStepForZoom(state.doc.workspace.grid.size, state.ui.viewport.zoom) : null;
  return resolveSnap(geometry, world, {
    tolerance: 10 * options.pixel,
    anchor: options.anchor ?? null,
    trackPoints: options.trackPoints ?? [],
    settings: state.ui.drafting.osnap,
    gridStep: grid,
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });
}

/** The short caption of a snap (for a marker), or null when nothing was snapped to. */
export function snapCaption(result: OsnapResult): string | null {
  return result.kind ? SNAP_CAPTIONS[result.kind] : null;
}
