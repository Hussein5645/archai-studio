/**
 * The board level: the working elevation of the board (`workspace.boardElevation`, mm). Elements
 * drawn while it is not zero start at that height in 3D (their own base elevation, e.g. a window
 * sill, is added on top), so a storey can be drawn above another without a level region. Elements
 * on a level, hosted in another element or with an elevation of their own are left alone.
 */
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { hostOf } from '@/assets/arch-meta';
import { baseElevationOf, levelElevationOf } from '@/view3d/geometry';

/** Kinds of elements that never get a 3D elevation (views, annotations, helpers). */
function isBoardOnly(element: Element): boolean {
  const meta = element.meta ?? {};
  return (
    element.kind === 'text' ||
    Boolean(meta['annotation'] || meta['annotationLayer'] || meta['view3d'] || meta['paper'] || meta['sectionLine'] || meta['planRegion'] || meta['cameraMarker'] || meta['analysis'] || meta['location'] || meta['sheet']) ||
    levelElevationOf(element) !== null
  );
}

/** Lifts root elements a command created (not in `before`) to the board level. */
export function applyBoardElevation(before: ElementTable, doc: ArchaiDocument): void {
  const board = doc.workspace.boardElevation ?? 0;
  if (!board) return;
  for (const element of Object.values(doc.elements)) {
    if (before[element.id] || element.parentId !== null || isBoardOnly(element) || hostOf(element)) continue;
    const meta = element.meta ?? {};
    if (meta['levelConstraint'] || typeof meta['instanceElevation'] === 'number') continue;
    element.meta = { ...meta, instanceElevation: baseElevationOf(element) + board };
  }
}

/** Default storey height used to step the board level when the document has no levels. */
export const STOREY_STEP = 3000;

/** The next board elevation up or down: the next level's elevation, else one storey. */
export function steppedBoardElevation(doc: ArchaiDocument, direction: 'up' | 'down'): number {
  const current = doc.workspace.boardElevation ?? 0;
  const levels = [...new Set(Object.values(doc.elements).flatMap((element) => {
    const elevation = levelElevationOf(element);
    return elevation === null ? [] : [elevation];
  }))].concat(0).sort((a, b) => a - b);
  if (direction === 'up') return levels.find((elevation) => elevation > current + 0.5) ?? current + STOREY_STEP;
  return [...levels].reverse().find((elevation) => elevation < current - 0.5) ?? current - STOREY_STEP;
}
