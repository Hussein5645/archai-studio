import { describe, expect, it } from 'vitest';
import { geoPoint, siteArea, tileXY } from './mapGeometry';

describe('map coordinates and reference area', () => {
  it('round trips a project pin at every supported zoom', () => {
    for (let zoom = 1; zoom <= 19; zoom++) {
      const pixel = tileXY(30.49524, 47.80910, zoom);
      const point = geoPoint(pixel.x, pixel.y, zoom);
      expect(point.lat).toBeCloseTo(30.49524, 8);
      expect(point.lon).toBeCloseTo(47.80910, 8);
    }
  });
  it('measures a small equatorial square independently of winding', () => {
    const points = [{ lat: 0, lon: 0 }, { lat: 0, lon: .001 }, { lat: .001, lon: .001 }, { lat: .001, lon: 0 }];
    expect(siteArea(points)).toBeCloseTo(12364.346, 1);
    expect(siteArea([...points].reverse())).toBeCloseTo(siteArea(points), 4);
    expect(siteArea(points.slice(0, 2))).toBe(0);
  });
  it('handles a boundary crossing the date line without a world-sized area', () => {
    expect(siteArea([{ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 }, { lat: .001, lon: -179.999 }, { lat: .001, lon: 179.999 }])).toBeCloseTo(24728.692, 1);
  });
});

describe('1:1 map frame', () => {
  it('places ground distances at true scale in board millimetres', async () => {
    const { mapFrame, geoToLocal, localToGeo, geoDistance } = await import('./mapGeometry');
    const centre = { lat: 51.5, lon: -0.12 };
    const frame = mapFrame(centre, { x: 1000, y: 2000 });
    expect(geoToLocal(frame, centre)).toEqual({ x: 1000, y: 2000 });
    const east = { lat: 51.5, lon: -0.1186 };
    const local = geoToLocal(frame, east);
    // Web Mercator uses the WGS84 equatorial radius; within 0.2% of the mean-sphere distance.
    expect((local.x - 1000) / (geoDistance(centre, east) * 1000)).toBeCloseTo(1, 2);
    expect(Math.abs(local.y - 2000)).toBeLessThan(1);
    const back = localToGeo(frame, local.x, local.y);
    expect(back.lat).toBeCloseTo(east.lat, 9);
    expect(back.lon).toBeCloseTo(east.lon, 9);
  });
  it('picks the tile zoom whose pixels match the board zoom', async () => {
    const { tileZoomFor, mmPerTilePx } = await import('./mapGeometry');
    for (const pxPerMm of [0.0003, 0.001, 0.002]) {
      const z = tileZoomFor(pxPerMm, 30);
      const screenPxPerTilePx = mmPerTilePx(z, 30) * pxPerMm;
      expect(screenPxPerTilePx).toBeGreaterThan(0.7);
      expect(screenPxPerTilePx).toBeLessThan(1.42);
    }
    expect(tileZoomFor(5, 30)).toBe(19);
  });
});
