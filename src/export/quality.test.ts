import { describe, expect, it } from 'vitest';
import { clampRaster, crc32, jpegWithDpi, mapPaint, parseColor, pixelsForPrint, pngWithDpi, tileGrid } from './quality';

describe('print sizes', () => {
  it('converts printed millimetres to pixels', () => {
    expect(pixelsForPrint(25.4, 300)).toBe(300);
    // A1 landscape at 300 dpi.
    expect(pixelsForPrint(841, 300)).toBe(9933);
    expect(pixelsForPrint(0, 300)).toBe(1);
  });

  it('clamps rasters to the canvas limits keeping the aspect ratio', () => {
    expect(clampRaster(1000, 500)).toEqual({ width: 1000, height: 500, factor: 1 });
    const side = clampRaster(64_000, 1000);
    expect(side.width).toBeLessThanOrEqual(32_000);
    expect(side.width / side.height).toBeCloseTo(64, 0);
    const area = clampRaster(20_000, 20_000);
    expect(area.width * area.height).toBeLessThanOrEqual(250_000_000);
    expect(area.factor).toBeLessThan(1);
  });

  it('tiles an image without gaps or overlaps', () => {
    const tiles = tileGrid(5000, 3000, 2048);
    expect(tiles).toHaveLength(6);
    expect(tiles.reduce((sum, t) => sum + t.width * t.height, 0)).toBe(5000 * 3000);
    expect(tiles.at(-1)).toEqual({ x: 4096, y: 2048, width: 904, height: 952 });
  });
});

function fakePng(): Uint8Array {
  // Signature + IHDR (13 bytes of data) + IEND.
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([73, 72, 68, 82], 4);
  view.setUint32(8, 10);
  view.setUint32(12, 10);
  view.setUint32(21, crc32(ihdr, 4, 21));
  const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82]);
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...ihdr, ...iend]);
}

describe('DPI metadata', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });

  it('inserts a pHYs chunk after IHDR', () => {
    const out = pngWithDpi(fakePng(), 300);
    // IHDR occupies bytes 8..33; the pHYs chunk follows: length, type, x/y ppm, unit, CRC.
    const view = new DataView(out.buffer);
    expect(view.getUint32(33)).toBe(9);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe('pHYs');
    expect(view.getUint32(41)).toBe(11811);
    expect(out[49]).toBe(1);
    expect(view.getUint32(50)).toBe(crc32(out, 37, 50));
    // Applying twice replaces rather than duplicates.
    expect(pngWithDpi(out, 150).length).toBe(out.length);
  });

  it('leaves non-PNG bytes alone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(pngWithDpi(bytes, 300)).toBe(bytes);
  });

  it('writes the JFIF density', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const out = jpegWithDpi(jpeg, 300);
    expect([...out.subarray(13, 18)]).toEqual([1, 1, 44, 1, 44]);
  });
});

describe('colour modes', () => {
  it('parses common colour syntaxes', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#2563eb80')?.a).toBeCloseTo(0.5, 1);
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10 20 30 / 50%)')?.a).toBe(0.5);
    expect(parseColor('url(#hatch)')).toBeNull();
  });

  it('maps paints per mode', () => {
    expect(mapPaint('#2563eb', 'color', 'stroke')).toBe('#2563eb');
    expect(mapPaint('#2563eb', 'black', 'stroke')).toBe('#000000');
    expect(mapPaint('#ffffff', 'black', 'stroke')).toBe('#ffffff');
    expect(mapPaint('#ff0000', 'grayscale', 'fill')).toBe('#363636');
    expect(mapPaint('none', 'black', 'fill')).toBe('none');
  });
});
