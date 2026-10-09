/**
 * Builds a print-ready stack of layers for a board region, in the board's own paint order (see
 * render/boardRuns.ts): SVG paint layers become standalone vector SVGs with every computed style
 * inlined, and live HTML content (3D/section portals, the site map) becomes rasters rendered at
 * the output resolution rather than copied from the screen. Every exporter (PDF, PNG/JPG, SVG,
 * view locking) consumes this one stack, so they all look the same.
 */
import type { ArchaiDocument, Element } from '@/document';
import { isEffectivelyVisible } from '@/document';
import { worldBounds, worldMatrix, type Rect } from '@/geometry';
import { boardRuns } from '@/render/boardRuns';
import { mountedViews } from '@/view3d/SceneView';
import { locationOf } from '@/analysis/model';
import { renderMapImage } from './mapImage';
import { sheetViewOf } from '@/sheets/model';
import { renderFrame3d } from '@/sheets/frameRender';
import { isBoardOnly } from '@/annotations/model';
import { clampRaster, mapPaint, type ColorMode } from './quality';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type SheetLayer =
  | { kind: 'vector'; svg: SVGSVGElement }
  | {
      kind: 'raster';
      canvas: HTMLCanvasElement;
      /** Top-left in board millimetres, size in board millimetres, clockwise rotation in degrees. */
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
      /** Opaque renders (3D, maps) can be stored as JPEG; others need alpha. */
      opaque: boolean;
    };

export interface ComposeOptions {
  region: Rect;
  /** Output pixels per board millimetre, for the raster parts. */
  pxPerMm: number;
  excludeIds?: readonly string[];
  colorMode?: ColorMode;
  /**
   * PDF only: jsPDF's built-in fonts cover Latin text; other scripts (Arabic, CJK...) are baked
   * into images at the output resolution instead of printing as boxes.
   */
  rasterizeNonLatinText?: boolean;
}

/** Largest raster a single view or image is rendered at (px per side). */
const MAX_LAYER_SIDE = 12_000;

/** Properties copied from computed style, so the SVG renders the same outside the app's CSS. */
const INLINE_PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'white-space',
  'paint-order',
  'filter',
] as const;

const NON_LATIN = /[^\u0000-ɏḀ-ỿ -⁯₠-⃏℀-⅏←-⇿∀-⋿°×]/;

function worldRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="world"]');
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Top-left, size and rotation of a rect element on the board. */
function placement(doc: ArchaiDocument, element: Element & { kind: 'rect' }): { x: number; y: number; width: number; height: number; rotation: number } {
  const matrix = worldMatrix(doc.elements, element);
  return { x: matrix[4], y: matrix[5], width: element.width, height: element.height, rotation: (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI };
}

/**
 * Copies computed styles from `source` onto its deep clone `target`, dropping hidden nodes and
 * the board's zoom-dependent minimum sizes (`--px`), and applying the colour mode.
 */
function inlineStyles(source: Element_, target: Element_, mode: ColorMode): void {
  if (source instanceof SVGElement && target instanceof SVGElement) {
    const computed = getComputedStyle(source);
    if (computed.display === 'none' || computed.visibility === 'hidden') {
      target.remove();
      return;
    }
    const zoomAware = (source.getAttribute('style') ?? '').includes('--px');
    for (const property of INLINE_PROPERTIES) {
      let value = computed.getPropertyValue(property);
      if (!value) continue;
      if (property === 'filter' && value === 'none') continue;
      if (property === 'fill' || property === 'stroke') value = mapPaint(value, mode, property === 'fill' && source.tagName !== 'text' ? 'fill' : 'stroke');
      target.style.setProperty(property, value);
    }
    if (zoomAware) {
      // Exports are drawn at true size: `max(Wpx, calc(var(--px) * N))` prints as W.
      const width = /max\(\s*([\d.]+)px/.exec(source.style.strokeWidth);
      if (width) target.style.setProperty('stroke-width', width[1]!);
      if (source.hasAttribute('data-min-scale') || source.style.transform.includes('--px')) target.style.removeProperty('transform');
    }
    target.style.removeProperty('--px');
  }
  const sourceChildren = source.children;
  const targetChildren = [...target.children];
  for (let i = 0; i < sourceChildren.length && i < targetChildren.length; i++) inlineStyles(sourceChildren[i]!, targetChildren[i]!, mode);
}
type Element_ = globalThis.Element;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function canvasFilter(filter: string, mode: ColorMode): string {
  const parts = filter && filter !== 'none' ? [filter] : [];
  if (mode !== 'color') parts.push('grayscale(1)');
  return parts.join(' ') || 'none';
}

/**
 * Replaces every <image> href with a PNG data URL at the output resolution, with its CSS filter
 * and the colour mode baked in: blob: URLs and filters do not survive SVG-as-image or PDF.
 */
async function bakeImages(svg: SVGSVGElement, pxPerMm: number, mode: ColorMode): Promise<void> {
  await Promise.all(
    [...svg.querySelectorAll('image')].map(async (node) => {
      const href = node.getAttribute('href') ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href) return;
      const filter = canvasFilter(node.style.getPropertyValue('filter'), mode);
      const isRasterData = href.startsWith('data:image/png') || href.startsWith('data:image/jpeg');
      if (isRasterData && filter === 'none') return;
      const image = await loadImage(href);
      if (!image) {
        node.remove();
        return;
      }
      const width = Number(node.getAttribute('width')) || image.naturalWidth;
      const height = Number(node.getAttribute('height')) || image.naturalHeight;
      // Vector sources (SVG symbols) render at output resolution; bitmaps keep at least their own pixels.
      const vector = href.startsWith('data:image/svg') || /\.svg($|\?)/i.test(href) || image.naturalWidth === 0;
      const wanted = { w: width * pxPerMm, h: height * pxPerMm };
      const base = vector ? wanted : { w: Math.max(wanted.w, image.naturalWidth), h: Math.max(wanted.h, image.naturalHeight) };
      const size = clampRaster(base.w, base.h, 4096, 16_000_000);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.filter = filter;
      context.drawImage(image, 0, 0, size.width, size.height);
      try {
        node.setAttribute('href', canvas.toDataURL('image/png'));
        node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
        node.style.removeProperty('filter');
      } catch {
        // A cross-origin image without CORS taints the canvas; keep the original reference.
      }
    }),
  );
}

/**
 * Replaces `target` (a clone inside an export) with an image of itself, measured on its live
 * `source`: for what svg2pdf cannot draw (non-Latin text, filters, blend modes). `oversample`
 * renders above the output density (small text stays crisp).
 */
async function bakeNode(source: SVGGraphicsElement, target: globalThis.Element, pxPerMm: number, oversample: number, pad: number, limit: number): Promise<void> {
  let box: DOMRect;
  try {
    box = source.getBBox();
  } catch {
    return;
  }
  if (box.width <= 0 || box.height <= 0) return;
  const x = box.x - pad;
  const y = box.y - pad;
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;
  const mini = document.createElementNS(SVG_NS, 'svg');
  mini.setAttribute('xmlns', SVG_NS);
  mini.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  const size = clampRaster(w * pxPerMm * oversample, h * pxPerMm * oversample, limit, limit * limit * 0.5);
  mini.setAttribute('width', String(size.width));
  mini.setAttribute('height', String(size.height));
  const copy = target.cloneNode(true) as SVGElement;
  copy.removeAttribute('transform');
  mini.append(copy);
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(mini))}`);
  if (!image || !target.parentNode) return;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')?.drawImage(image, 0, 0, size.width, size.height);
  const replacement = document.createElementNS(SVG_NS, 'image');
  replacement.setAttribute('x', String(x));
  replacement.setAttribute('y', String(y));
  replacement.setAttribute('width', String(w));
  replacement.setAttribute('height', String(h));
  replacement.setAttribute('preserveAspectRatio', 'none');
  replacement.setAttribute('href', canvas.toDataURL('image/png'));
  const transform = target.getAttribute('transform');
  if (transform) replacement.setAttribute('transform', transform);
  target.replaceWith(replacement);
}

/**
 * Bakes non-Latin text into images (PDF fonts cannot shape it). `sources` are the live nodes
 * (for their measured boxes), `targets` their clones inside `root`, index for index.
 */
async function bakeText(sources: SVGTextElement[], targets: SVGTextElement[], root: SVGElement, pxPerMm: number): Promise<void> {
  await Promise.all(
    sources.map(async (source, index) => {
      const target = targets[index];
      if (!target || !NON_LATIN.test(source.textContent ?? '') || !root.contains(target)) return;
      const height = (() => {
        try {
          return source.getBBox().height;
        } catch {
          return 0;
        }
      })();
      await bakeNode(source, target, pxPerMm, 2, height * 0.2, 4096);
    }),
  );
}

/** One SVG paint layer of the board, cropped to the region's elements, as a standalone SVG. */
async function vectorLayer(doc: ArchaiDocument, source: SVGSVGElement, ids: readonly string[], options: ComposeOptions): Promise<SVGSVGElement | null> {
  const content = source.querySelector<SVGGElement>(':scope > g');
  if (!content) return null;
  const wanted = new Set<string>();
  const excluded = new Set(options.excludeIds ?? []);
  for (const id of ids) {
    const element = doc.elements[id];
    // Board annotations (sketches, sticky notes) stay on the board: never printed or exported.
    if (!element || excluded.has(id) || isBoardOnly(doc.elements, id)) continue;
    try {
      if (!intersects(worldBounds(doc.elements, element), options.region)) continue;
    } catch {
      // Elements without bounds (empty groups) are kept; they draw nothing anyway.
    }
    wanted.add(id);
  }
  if (wanted.size === 0) return null;
  const group = document.createElementNS(SVG_NS, 'g');
  const textSources: SVGTextElement[] = [];
  const textTargets: SVGTextElement[] = [];
  const effectSources: SVGGraphicsElement[] = [];
  const effectTargets: globalThis.Element[] = [];
  for (const node of content.children) {
    const id = node.getAttribute('data-element-id');
    if (id !== null && !wanted.has(id)) continue;
    const copy = node.cloneNode(true) as globalThis.Element;
    group.append(copy);
    // Collected before inlining, which may drop hidden nodes from the copy.
    if (options.rasterizeNonLatinText) {
      textSources.push(...node.querySelectorAll('text'));
      textTargets.push(...copy.querySelectorAll('text'));
      effectSources.push(...node.querySelectorAll<SVGGraphicsElement>('[data-bake-pdf]'));
      effectTargets.push(...copy.querySelectorAll('[data-bake-pdf]'));
    }
    inlineStyles(node, copy, options.colorMode ?? 'color');
  }
  if (group.childElementCount === 0) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `${options.region.x} ${options.region.y} ${options.region.width} ${options.region.height}`);
  svg.append(group);
  // Screen-only guides (view frame outlines) never print.
  for (const node of svg.querySelectorAll('[data-screen-only]')) node.remove();
  // View frames of 3D/section/camera views: re-rendered from their source, with the frame's
  // styling, at output resolution (the board shows a screen-resolution render).
  for (const node of svg.querySelectorAll<SVGImageElement>('image[data-sheet-view-source]')) {
    const source = mountedViews.get(node.getAttribute('data-sheet-view-source') ?? '');
    const frame = sheetViewOf(doc.elements[node.getAttribute('data-sheet-view-frame') ?? '']);
    const width = Number(node.getAttribute('width'));
    const height = Number(node.getAttribute('height'));
    if (!source || !(width > 0) || !(height > 0)) continue;
    const size = rasterSize(width, height, options.pxPerMm);
    const canvas = frame ? renderFrame3d(source, frame, size.width, size.height, Object.keys(doc.elements)) : source.renderImage(size.width, size.height);
    node.setAttribute('href', canvas.toDataURL('image/png'));
  }
  await bakeImages(svg, options.pxPerMm, options.colorMode ?? 'color');
  if (options.rasterizeNonLatinText) {
    // Frames with filters / blend modes first (their text goes with them), then loose text.
    await Promise.all(effectSources.map((source, index) => (group.contains(effectTargets[index]!) ? bakeNode(source, effectTargets[index]!, options.pxPerMm, 1, 0, 8192) : undefined)));
    await bakeText(textSources, textTargets, group, options.pxPerMm);
  }
  return svg;
}

function greyscaleCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const context = out.getContext('2d');
  if (!context) return canvas;
  context.filter = 'grayscale(1)';
  context.drawImage(canvas, 0, 0);
  return out;
}

function rasterSize(width: number, height: number, pxPerMm: number): { width: number; height: number } {
  return clampRaster(width * pxPerMm, height * pxPerMm, MAX_LAYER_SIDE, 100_000_000);
}

/** The region's layers, bottom to top. `doc` must be the document the board is showing. */
export async function composeSheet(doc: ArchaiDocument, options: ComposeOptions): Promise<SheetLayer[]> {
  const root = worldRoot();
  if (!root) throw new Error('The board is not on screen');
  const mode = options.colorMode ?? 'color';
  const excluded = new Set(options.excludeIds ?? []);
  const layers: SheetLayer[] = [];
  // Same runs as the board is painting (sheet mode paints one paper only).
  const runs = boardRuns(doc.elements, root.dataset['sheet'] ?? null);
  for (const [index, run] of runs.entries()) {
    if (run.kind === 'svg') {
      const source = root.querySelector<SVGSVGElement>(`svg[data-run="${index}"]`);
      const svg = source ? await vectorLayer(doc, source, run.ids, options) : null;
      if (svg) layers.push({ kind: 'vector', svg });
      continue;
    }
    if (run.kind === 'portal') {
      if (run.hidden) continue;
      const element = doc.elements[run.id];
      const view = mountedViews.get(run.id);
      if (!view || !element || element.kind !== 'rect' || excluded.has(run.id) || !isEffectivelyVisible(doc.elements, run.id)) continue;
      const place = placement(doc, element);
      if (!intersects(worldBounds(doc.elements, element), options.region)) continue;
      const size = rasterSize(place.width, place.height, options.pxPerMm);
      let canvas = view.renderImage(size.width, size.height);
      if (mode !== 'color') canvas = greyscaleCanvas(canvas);
      layers.push({ kind: 'raster', canvas, ...place, opaque: true });
      continue;
    }
    if (run.kind === 'analysis') {
      // Only the site map has printable content; analysis cards are board controls.
      const element = doc.elements[run.ids[0]!];
      if (!element || element.kind !== 'rect' || !locationOf(element) || excluded.has(element.id) || !isEffectivelyVisible(doc.elements, element.id)) continue;
      if (!intersects(worldBounds(doc.elements, element), options.region)) continue;
      const place = placement(doc, element);
      const size = rasterSize(place.width, place.height, options.pxPerMm);
      let canvas = await renderMapImage(element, size.width / place.width, size.width, size.height);
      if (!canvas) continue;
      if (mode !== 'color') canvas = greyscaleCanvas(canvas);
      layers.push({ kind: 'raster', canvas, ...place, opaque: true });
    }
  }
  return layers;
}

/**
 * A raster layer turned upright: rotated layers are drawn onto a transparent canvas the size of
 * their bounding box, so formats without rotation support (PDF images) place them exactly.
 */
export function uprightRaster(layer: Extract<SheetLayer, { kind: 'raster' }>): { canvas: HTMLCanvasElement; x: number; y: number; width: number; height: number; opaque: boolean } {
  const rotation = ((layer.rotation % 360) + 360) % 360;
  if (Math.abs(rotation) < 0.01 || Math.abs(rotation - 360) < 0.01) return { canvas: layer.canvas, x: layer.x, y: layer.y, width: layer.width, height: layer.height, opaque: layer.opaque };
  const r = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Board-mm corners of the rotated rect about its top-left.
  const corners = [
    [0, 0],
    [layer.width, 0],
    [layer.width, layer.height],
    [0, layer.height],
  ].map(([px, py]) => ({ x: layer.x + px! * cos - py! * sin, y: layer.y + px! * sin + py! * cos }));
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxX = Math.max(...corners.map((c) => c.x));
  const maxY = Math.max(...corners.map((c) => c.y));
  const pxPerMm = layer.canvas.width / layer.width;
  const size = clampRaster((maxX - minX) * pxPerMm, (maxY - minY) * pxPerMm, MAX_LAYER_SIDE, 140_000_000);
  const k = size.width / (maxX - minX);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context) {
    context.setTransform(k * cos, k * sin, -k * sin, k * cos, (layer.x - minX) * k, (layer.y - minY) * k);
    context.drawImage(layer.canvas, 0, 0, layer.width, layer.height);
  }
  return { canvas, x: minX, y: minY, width: maxX - minX, height: maxY - minY, opaque: false };
}
