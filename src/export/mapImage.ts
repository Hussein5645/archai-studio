/**
 * The site map for export: tiles are fetched at the zoom the output resolution needs (not the
 * board's current zoom) and painted onto a canvas covering the whole map rect, with the site
 * boundary and the tile provider's attribution, which the tile licences require on prints.
 */
import type { Element } from '@/document';
import { locationFrame, locationOf, mapTileUrls } from '@/analysis/model';
import { frameMmPerTilePx, geoToLocal, localToTile, tileZoomFor } from '@/analysis/mapGeometry';

/** Tiles fetched per map at most; the zoom drops a level until it fits. */
const MAX_TILES = 900;

const ATTRIBUTION: Record<string, string> = {
  satellite: 'Tiles (c) Esri, Maxar, Earthstar',
  hybrid: 'Tiles (c) Esri, Maxar, (c) OSM',
  topo: 'Tiles (c) Esri, USGS, (c) OSM',
  light: '(c) OSM (c) CARTO',
  dark: '(c) OSM (c) CARTO',
  voyager: '(c) OSM (c) CARTO',
  street: '(c) OpenStreetMap contributors',
};

function loadTile(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Renders a map rect at `pxPerMm` (canvas pixels per board millimetre); null if not a map. */
export async function renderMapImage(element: Element, pxPerMm: number, width: number, height: number): Promise<HTMLCanvasElement | null> {
  const meta = locationOf(element);
  if (!meta || element.kind !== 'rect') return null;
  const frame = locationFrame(element, meta);
  const centre = meta.mapCenter ?? { lat: meta.lat, lon: meta.lon };
  let zoom = tileZoomFor(pxPerMm, centre.lat);
  let origin = localToTile(frame, 0, 0, zoom);
  let span = element.width / frameMmPerTilePx(frame, zoom);
  let spanY = element.height / frameMmPerTilePx(frame, zoom);
  while (zoom > 1 && (Math.ceil(span / 256) + 1) * (Math.ceil(spanY / 256) + 1) > MAX_TILES) {
    zoom -= 1;
    origin = localToTile(frame, 0, 0, zoom);
    span = element.width / frameMmPerTilePx(frame, zoom);
    spanY = element.height / frameMmPerTilePx(frame, zoom);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#e5e7eb';
  context.fillRect(0, 0, width, height);
  // Canvas px per tile px at this zoom.
  const scale = width / span;
  const count = 2 ** zoom;
  const tx0 = Math.floor(origin.x / 256);
  const tx1 = Math.floor((origin.x + span) / 256);
  const ty0 = Math.max(0, Math.floor(origin.y / 256));
  const ty1 = Math.min(count - 1, Math.floor((origin.y + spanY) / 256));
  let failed = false;
  for (const layer of ['base', 'overlay'] as const) {
    const draws: Promise<(() => void) | null>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const urls = mapTileUrls(meta.mapStyle, zoom, ((tx % count) + count) % count, ty);
        const url = layer === 'base' ? urls.base : urls.overlay;
        if (!url) continue;
        const left = (tx * 256 - origin.x) * scale;
        const top = (ty * 256 - origin.y) * scale;
        draws.push(
          loadTile(url).then((image) => {
            if (!image) {
              failed = true;
              return null;
            }
            // Overlap by a hair so tile seams never show as hairlines in the print.
            return () => context.drawImage(image, left, top, 256 * scale + 0.5, 256 * scale + 0.5);
          }),
        );
      }
    }
    // Base tiles all land before overlay tiles (labels) are painted.
    for (const paint of await Promise.all(draws)) paint?.();
  }

  // Site boundary, as on the board.
  if (meta.boundary && meta.boundary.length >= 2) {
    const mm = width / element.width;
    context.beginPath();
    meta.boundary.forEach((point, index) => {
      const local = geoToLocal(frame, point);
      if (index === 0) context.moveTo(local.x * mm, local.y * mm);
      else context.lineTo(local.x * mm, local.y * mm);
    });
    context.closePath();
    context.lineWidth = Math.max(2, Math.min(width, height) * 0.002);
    context.strokeStyle = '#dc2626';
    context.setLineDash([context.lineWidth * 4, context.lineWidth * 2]);
    context.stroke();
    context.setLineDash([]);
  }

  // Attribution: bottom-right, sized for print (~2 mm tall at any output size).
  const text = ATTRIBUTION[meta.mapStyle ?? 'street'] ?? ATTRIBUTION['street']!;
  const fontPx = Math.max(10, Math.round(Math.min(width, height) * 0.012));
  context.font = `${fontPx}px sans-serif`;
  const padding = fontPx * 0.4;
  const textWidth = context.measureText(text).width;
  context.fillStyle = 'rgba(255,255,255,0.8)';
  context.fillRect(width - textWidth - padding * 2, height - fontPx - padding * 2, textWidth + padding * 2, fontPx + padding * 2);
  context.fillStyle = '#374151';
  context.textBaseline = 'bottom';
  context.fillText(text, width - textWidth - padding, height - padding);
  if (failed) console.warn('Some map tiles could not be loaded for export');
  return canvas;
}
