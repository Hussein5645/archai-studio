export interface GeoPoint { lat: number; lon: number }
export function tileXY(lat: number, lon: number, zoom: number) {
  const size = 256 * 2 ** zoom;
  const rad = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return { x: (lon + 180) / 360 * size, y: (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * size };
}
export function geoPoint(x: number, y: number, zoom: number): GeoPoint {
  const size = 256 * 2 ** zoom;
  return { lon: ((x / size * 360) % 360 + 360) % 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.max(0, Math.min(size, y)) / size))) * 180 / Math.PI };
}
/** Spherical area in m². Boundary geometry is reference data, never solver geometry. */
export function siteArea(points: GeoPoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const delta = ((b.lon - a.lon + 540) % 360 - 180) * Math.PI / 180;
    sum += delta * (2 + Math.sin(a.lat * Math.PI / 180) + Math.sin(b.lat * Math.PI / 180));
  }
  return Math.abs(sum * 6371008.8 ** 2 / 2);
}
/** Great-circle distance in metres. */
export function geoDistance(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Perimeter in metres of a closed ring (open when `closed` is false). */
export function sitePerimeter(points: GeoPoint[], closed = true): number {
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i++) sum += geoDistance(points[i]!, points[i + 1]!);
  if (closed && points.length >= 3) sum += geoDistance(points.at(-1)!, points[0]!);
  return sum;
}

// ---- 1:1 board scale ---------------------------------------------------------------------------
// The board is in millimetres. A map shows Web-Mercator tiles at true scale around its centre
// latitude, so drawings, the site boundary and generated context all share one linear frame.

const MM_PER_PX_Z0 = 156_543_033.92;
/** Zoom the frame is expressed in; high enough that float precision never matters. */
const FRAME_ZOOM = 22;
export const MAX_TILE_ZOOM = 19;

/** Millimetres on the ground covered by one tile pixel at `zoom`, near `lat`. */
export function mmPerTilePx(zoom: number, lat: number): number {
  return (MM_PER_PX_Z0 * Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)) / 2 ** zoom;
}

/** Tile zoom whose pixels come closest to one screen pixel at a board zoom (px per mm). */
export function tileZoomFor(pxPerMm: number, lat: number): number {
  const exact = Math.log2(MM_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180) * pxPerMm);
  return Math.max(1, Math.min(MAX_TILE_ZOOM, Math.round(exact)));
}

/** Maps a geographic point to the map element's local millimetres and back. */
export interface MapFrame {
  /** Map centre in tile pixels at FRAME_ZOOM. */
  cx: number;
  cy: number;
  /** Local millimetres where the map centre sits. */
  ax: number;
  ay: number;
  /** Millimetres per tile pixel at FRAME_ZOOM. */
  mm: number;
}

export function mapFrame(centre: GeoPoint, anchor: { x: number; y: number }): MapFrame {
  const c = tileXY(centre.lat, centre.lon, FRAME_ZOOM);
  return { cx: c.x, cy: c.y, ax: anchor.x, ay: anchor.y, mm: mmPerTilePx(FRAME_ZOOM, centre.lat) };
}

export function geoToLocal(frame: MapFrame, point: GeoPoint): { x: number; y: number } {
  const p = tileXY(point.lat, point.lon, FRAME_ZOOM);
  return { x: frame.ax + (p.x - frame.cx) * frame.mm, y: frame.ay + (p.y - frame.cy) * frame.mm };
}

export function localToGeo(frame: MapFrame, x: number, y: number): GeoPoint {
  return geoPoint(frame.cx + (x - frame.ax) / frame.mm, frame.cy + (y - frame.ay) / frame.mm, FRAME_ZOOM);
}

/** Local millimetres covered by one tile pixel at `zoom` in this frame. */
export function frameMmPerTilePx(frame: MapFrame, zoom: number): number {
  return frame.mm * 2 ** (FRAME_ZOOM - zoom);
}

/** Tile pixel (at `zoom`) under a local point. */
export function localToTile(frame: MapFrame, x: number, y: number, zoom: number): { x: number; y: number } {
  const k = 2 ** (zoom - FRAME_ZOOM);
  return { x: (frame.cx + (x - frame.ax) / frame.mm) * k, y: (frame.cy + (y - frame.ay) / frame.mm) * k };
}
