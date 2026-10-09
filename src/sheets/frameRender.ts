/**
 * Rendering of 3D / section / camera view frames: the source view's live renderer draws the
 * frame's per-element overrides and render style, then the frame's image adjustments are applied
 * on the canvas. The board (live image) and the exporters (print resolution) both go through
 * here, so a styled view looks the same everywhere.
 */
import type { ElementLook, SceneView } from '@/view3d/SceneView';
import { DEFAULT_ACCENT, effectiveOverride, isNeutral, type FrameStyling, type ViewAdjustments } from './model';

/** Every element the view shows gets a look when others fade; otherwise only overridden ones. */
export function looksFor(view: FrameStyling, ids: Iterable<string>): Record<string, ElementLook> {
  const looks: Record<string, ElementLook> = {};
  const candidates = view.adjustments.fadeOthers ? ids : Object.keys(view.overrides);
  for (const id of candidates) {
    const o = effectiveOverride(view, id);
    if (!o) continue;
    const look: ElementLook = {};
    if (o.visibility === 'hidden') look.hidden = true;
    if (o.visibility === 'ghost') look.ghost = true;
    if (o.fill) look.color = o.fill;
    if (o.opacity !== undefined) look.opacity = o.opacity;
    if (o.lift) look.lift = o.lift;
    if (o.emphasis === 'outline' || o.emphasis === 'shadow') look.outline = o.accent ?? DEFAULT_ACCENT;
    if (o.emphasis === 'glow') {
      look.glow = true;
      look.accent = o.accent ?? DEFAULT_ACCENT;
    }
    looks[id] = look;
  }
  return looks;
}

/** Deterministic grain, so re-renders of the same frame do not shimmer. */
function grainTile(size: number, amount: number): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const context = tile.getContext('2d')!;
  const data = context.createImageData(size, size);
  let seed = 1337;
  for (let i = 0; i < data.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = (seed / 2147483647) * 255;
    data.data[i] = v;
    data.data[i + 1] = v;
    data.data[i + 2] = v;
    data.data[i + 3] = Math.round(amount * 70);
  }
  context.putImageData(data, 0, 0);
  return tile;
}

/** Image adjustments applied to a rendered canvas (in place; returns it). */
export function adjustCanvas(canvas: HTMLCanvasElement, adjustments: ViewAdjustments): HTMLCanvasElement {
  if (isNeutral(adjustments)) return canvas;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  const { brightness, contrast, saturation, tint, tintAmount, grain } = adjustments;
  if (brightness !== 1 || contrast !== 1 || saturation !== 1) {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')!.drawImage(canvas, 0, 0);
    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
    context.drawImage(copy, 0, 0);
    context.restore();
  }
  if (tint && tintAmount > 0) {
    context.save();
    context.globalCompositeOperation = 'multiply';
    context.globalAlpha = tintAmount;
    context.fillStyle = tint;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }
  if (grain > 0) {
    context.save();
    context.globalCompositeOperation = 'overlay';
    const pattern = context.createPattern(grainTile(128, grain), 'repeat');
    if (pattern) {
      context.fillStyle = pattern;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.restore();
  }
  return canvas;
}

/** A styled render of a 3D view frame at an exact size. */
export function renderFrame3d(source: SceneView, view: FrameStyling, width: number, height: number, contentIds: Iterable<string>, highlight: readonly string[] = []): HTMLCanvasElement {
  const canvas = source.renderImage(width, height, {
    style: view.style,
    background: view.adjustments.background,
    overrides: looksFor(view, contentIds),
    highlight,
    // Sheet views are presentation drawings: no ground grid.
    grid: false,
  });
  return adjustCanvas(canvas, view.adjustments);
}
