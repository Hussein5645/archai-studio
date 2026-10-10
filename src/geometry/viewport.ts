import type { Rect } from './rect';
import type { Vec2 } from './vec';

/** screen = world · zoom + (x, y) */
export interface ViewportLike {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.00002; // 50 km across 1000 px
export const MAX_ZOOM = 5; // 1 mm = 5 px

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export function worldToScreen(v: ViewportLike, p: Vec2): Vec2 {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

export function screenToWorld(v: ViewportLike, p: Vec2): Vec2 {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

/** Zooms by `factor` keeping the world point under `screenPoint` fixed. */
export function zoomAt(v: ViewportLike, screenPoint: Vec2, factor: number): ViewportLike {
  const zoom = clampZoom(v.zoom * factor);
  const ratio = zoom / v.zoom;
  return {
    zoom,
    x: screenPoint.x - (screenPoint.x - v.x) * ratio,
    y: screenPoint.y - (screenPoint.y - v.y) * ratio,
  };
}

export function panBy(v: ViewportLike, delta: Vec2): ViewportLike {
  return { x: v.x + delta.x, y: v.y + delta.y, zoom: v.zoom };
}

/** A viewport that shows `bounds` centred with `padding` screen pixels around it. */
export function fitBounds(
  bounds: Rect,
  canvas: { width: number; height: number },
  padding = 48,
  maxZoom = 1,
): ViewportLike {
  const availableWidth = Math.max(1, canvas.width - padding * 2);
  const availableHeight = Math.max(1, canvas.height - padding * 2);
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      bounds.width > 0 ? availableWidth / bounds.width : maxZoom,
      bounds.height > 0 ? availableHeight / bounds.height : maxZoom,
    ),
  );
  return {
    zoom,
    x: canvas.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: canvas.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** Visible world rectangle for a canvas of the given size. */
export function visibleWorldRect(v: ViewportLike, canvas: { width: number; height: number }): Rect {
  const topLeft = screenToWorld(v, { x: 0, y: 0 });
  return { x: topLeft.x, y: topLeft.y, width: canvas.width / v.zoom, height: canvas.height / v.zoom };
}
