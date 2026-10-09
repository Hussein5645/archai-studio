/**
 * Reference points: a small round rect carrying `meta.point = {}`. Its height is the element's
 * ordinary elevation (`meta.instanceElevation`, so level links, the Inspector's Elevation field
 * and parametric graph sockets apply as for any element). The board draws it at a fixed screen
 * size; 3D views show a fixed-size marker (see src/view3d/pointMarker.ts).
 */
import type { Element } from './schema';

/** Plan size of a point's symbol in mm (the board never draws it smaller than a few pixels). */
export const POINT_SIZE = 300;

export function isPoint(element: Element | undefined): boolean {
  const value = element?.meta?.['point'];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && element?.kind === 'rect');
}
