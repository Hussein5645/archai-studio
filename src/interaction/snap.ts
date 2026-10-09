/**
 * Grid snapping. The visible grid step adapts to zoom (1–2–5 multiples of the workspace grid
 * size) and snapping follows whatever step is currently drawn.
 */
import type { Rect, Vec2 } from '@/geometry';

const STEP_MULTIPLIERS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
export const MIN_GRID_PIXELS = 18;

/** The grid step (mm) drawn at this zoom: the smallest multiple that is at least 18 px apart. */
export function gridStepForZoom(gridSize: number, zoom: number): number {
  for (const multiplier of STEP_MULTIPLIERS) {
    const step = gridSize * multiplier;
    if (step * zoom >= MIN_GRID_PIXELS) return step;
  }
  return gridSize * STEP_MULTIPLIERS[STEP_MULTIPLIERS.length - 1]!;
}

export const snapValue = (value: number, step: number): number => Math.round(value / step) * step;

export function snapPoint(p: Vec2, step: number): Vec2 {
  return { x: snapValue(p.x, step), y: snapValue(p.y, step) };
}

/** Snap one stable reference point; never alternate between edges and centre during a drag. */
export function snapMoveDelta(bounds: Rect, delta: Vec2, step: number): Vec2 {
  return { x: snapValue(bounds.x + delta.x, step) - bounds.x, y: snapValue(bounds.y + delta.y, step) - bounds.y };
}
