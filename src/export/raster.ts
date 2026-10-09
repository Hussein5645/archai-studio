/**
 * Raster output of a board region: the composed layers (see compose.ts) are painted onto one
 * canvas at the requested pixels per millimetre. Vector layers are rasterized in tiles through
 * the SVG's viewBox, so very large prints do not hit the browser's per-image limits, and the
 * encoded PNG/JPEG carries its DPI so it prints at the intended size.
 */
import type { ArchaiDocument } from '@/document';
import type { Rect } from '@/geometry';
import { composeSheet, type SheetLayer } from './compose';
import { clampRaster, jpegWithDpi, pngWithDpi, tileGrid, type ColorMode } from './quality';

export interface RasterOptions {
  /** Output pixels per millimetre of board. */
  pixelsPerMm: number;
  /** CSS colour, or null for a transparent background (PNG only). */
  background?: string | null;
  /** Elements to leave out (e.g. the paper sheet itself). */
  excludeIds?: string[];
  colorMode?: ColorMode;
}

/** Vector layers are drawn through tiles of at most this many px per side. */
const SVG_TILE = 4096;

function loadSvg(markup: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The board could not be rasterized'));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** Paints composed layers onto a canvas covering `region` at `pxPerMm`. */
export async function paintLayers(layers: SheetLayer[], region: Rect, canvas: HTMLCanvasElement, pxPerMm: number): Promise<void> {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  context.imageSmoothingQuality = 'high';
  for (const layer of layers) {
    if (layer.kind === 'raster') {
      context.save();
      context.translate((layer.x - region.x) * pxPerMm, (layer.y - region.y) * pxPerMm);
      context.rotate((layer.rotation * Math.PI) / 180);
      context.drawImage(layer.canvas, 0, 0, layer.width * pxPerMm, layer.height * pxPerMm);
      context.restore();
      continue;
    }
    // One serialization of the content; each tile wraps it in a root with its own viewBox and size.
    const svg = layer.svg;
    const markup = new XMLSerializer().serializeToString(svg);
    const body = markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</svg>'));
    for (const tile of tileGrid(canvas.width, canvas.height, SVG_TILE)) {
      const viewBox = `${region.x + tile.x / pxPerMm} ${region.y + tile.y / pxPerMm} ${tile.width / pxPerMm} ${tile.height / pxPerMm}`;
      const image = await loadSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${tile.width}" height="${tile.height}">${body}</svg>`);
      context.drawImage(image, tile.x, tile.y, tile.width, tile.height);
    }
  }
}

/**
 * Rasterizes a region of the board. The size is clamped to what a canvas can hold; `pixelsPerMm`
 * on the result is the density actually used.
 */
export async function rasterizeBoard(doc: ArchaiDocument, region: Rect, options: RasterOptions): Promise<HTMLCanvasElement & { pixelsPerMm?: number }> {
  const size = clampRaster(region.width * options.pixelsPerMm, region.height * options.pixelsPerMm);
  const pxPerMm = size.width / region.width;
  const layers = await composeSheet(doc, { region, pxPerMm, excludeIds: options.excludeIds, colorMode: options.colorMode });
  const canvas = document.createElement('canvas') as HTMLCanvasElement & { pixelsPerMm?: number };
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.pixelsPerMm = pxPerMm;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  const background = options.background === undefined ? '#ffffff' : options.background;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, size.width, size.height);
  }
  await paintLayers(layers, region, canvas, pxPerMm);
  return canvas;
}

/**
 * Encodes a canvas; with `dpi` the file carries its print density. JPEG has no alpha, so it is
 * flattened onto white first (transparent pixels would otherwise turn black).
 */
export async function canvasBytes(canvas: HTMLCanvasElement, mime: 'image/png' | 'image/jpeg', quality = 0.92, dpi?: number): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  let source = canvas;
  if (mime === 'image/jpeg') {
    source = document.createElement('canvas');
    source.width = canvas.width;
    source.height = canvas.height;
    const context = source.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, source.width, source.height);
    context.drawImage(canvas, 0, 0);
  }
  const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((result) => (result ? resolve(result) : reject(new Error('Could not encode the image'))), mime, quality));
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  if (dpi) bytes = mime === 'image/png' ? pngWithDpi(bytes, dpi) : jpegWithDpi(bytes, dpi);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { bytes, dataUrl: `data:${mime};base64,${btoa(binary)}` };
}
