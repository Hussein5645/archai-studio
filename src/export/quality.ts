/**
 * Print maths and file-format details shared by every exporter: output sizes from DPI, tiling
 * large renders under GPU/canvas limits, DPI metadata for PNG/JPEG, and ink colour modes.
 * Pure functions only (no DOM), so they are unit-tested under Node.
 */

export const MM_PER_INCH = 25.4;

export type ExportFormat = 'pdf' | 'png' | 'jpg' | 'svg' | 'dxf';
/** `color` as drawn; `grayscale` keeps tones; `black` prints every line and text in black ink. */
export type ColorMode = 'color' | 'grayscale' | 'black';

export const EXPORT_DPI_OPTIONS = [72, 150, 200, 300, 600] as const;

/** Pixels for a printed length at a DPI (at least 1). */
export function pixelsForPrint(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

/** Largest side and area a single browser canvas reliably holds (Chromium: 32767 px, ~268 MP). */
export const MAX_CANVAS_SIDE = 32_000;
export const MAX_CANVAS_AREA = 250_000_000;

/**
 * Fits a requested raster size under the canvas limits, keeping the aspect ratio. Returns the
 * size to use and the factor applied (1 when it already fits).
 */
export function clampRaster(width: number, height: number, maxSide = MAX_CANVAS_SIDE, maxArea = MAX_CANVAS_AREA): { width: number; height: number; factor: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const factor = Math.min(1, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
  if (factor >= 1) return { width: w, height: h, factor: 1 };
  return { width: Math.max(1, Math.floor(w * factor)), height: Math.max(1, Math.floor(h * factor)), factor };
}

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Splits a width x height image into tiles no larger than `max` px per side, row by row. */
export function tileGrid(width: number, height: number, max: number): Tile[] {
  const size = Math.max(1, Math.floor(max));
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) tiles.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
  }
  return tiles;
}

// ---- DPI metadata ------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Writes a `pHYs` chunk so the PNG prints at its intended size (browsers encode 72 dpi-less
 * PNGs). Any existing pHYs is replaced; bytes that are not a PNG come back unchanged.
 */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [png.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  const ppm = Math.round(dpi / 0.0254);
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const end = offset + 12 + length;
    if (end > png.length) return png;
    if (type !== 'pHYs') chunks.push(png.subarray(offset, end));
    if (type === 'IHDR' && !inserted) {
      const chunk = new Uint8Array(21);
      const out = new DataView(chunk.buffer);
      out.setUint32(0, 9);
      chunk.set([112, 72, 89, 115], 4); // pHYs
      out.setUint32(8, ppm);
      out.setUint32(12, ppm);
      chunk[16] = 1; // unit: metre
      out.setUint32(17, crc32(chunk, 4, 17));
      chunks.push(chunk);
      inserted = true;
    }
    offset = end;
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}

/** Sets the JFIF density (dots per inch) of a JPEG in place; other JPEGs are left alone. */
export function jpegWithDpi(jpeg: Uint8Array, dpi: number): Uint8Array {
  // SOI, APP0 marker, length, "JFIF\0", version (2 bytes), units, Xdensity, Ydensity.
  const isJfif = jpeg.length > 18 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff && jpeg[3] === 0xe0 && jpeg[6] === 0x4a && jpeg[7] === 0x46 && jpeg[8] === 0x49 && jpeg[9] === 0x46 && jpeg[10] === 0;
  if (!isJfif) return jpeg;
  const out = jpeg.slice();
  const density = Math.max(1, Math.min(0xffff, Math.round(dpi)));
  out[13] = 1;
  out[14] = density >> 8;
  out[15] = density & 0xff;
  out[16] = density >> 8;
  out[17] = density & 0xff;
  return out;
}

// ---- colour modes ------------------------------------------------------------------------

/** Parses #rgb, #rrggbb(aa), rgb() and rgba(); null for anything else (none, url(), names). */
export function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const hex = m[1]!;
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** Rec. 709 luma, 0..255. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Maps a paint value for a colour mode. `role` decides the black-ink rule: strokes and text
 * print black unless nearly white (paper-coloured masks stay white); fills become greys.
 * Unparseable values (none, url(#hatch), currentColor) pass through.
 */
export function mapPaint(value: string, mode: ColorMode, role: 'stroke' | 'fill'): string {
  if (mode === 'color') return value;
  const color = parseColor(value);
  if (!color) return value;
  const y = luminance(color.r, color.g, color.b);
  const alpha = color.a < 1 ? hex2(color.a * 255) : '';
  if (mode === 'black' && role === 'stroke') return y > 245 ? `#ffffff${alpha}` : `#000000${alpha}`;
  return `#${hex2(y)}${hex2(y)}${hex2(y)}${alpha}`;
}
