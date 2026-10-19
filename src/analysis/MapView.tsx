/**
 * The project map on the board, at true scale: one board millimetre is one millimetre on the
 * ground, so zooming the board zooms the map (the tile zoom follows the board zoom). Only tiles
 * in the visible part of the rect are mounted, and the two coarser zoom levels stay underneath
 * (keyed by zoom, so the tiles already loaded become the fallback) to avoid blank flashes.
 */
import { Box, Crosshair, MapPin, PenLine, Route } from 'lucide-react';
import { memo, useState, type CSSProperties, type ReactElement } from 'react';
import { useApp, useAppState, useAppStateShallow, useDispatch, useElementsWithAncestors } from '@/app/context';
import { snapBoardPoint, snapCaption } from '@/interaction/boardSnap';
import { boardDoc } from '@/store';
import { isEffectivelyVisible, type JsonValue } from '@/document';
import { applyToPoint, invert, worldMatrix } from '@/geometry';
import { BoundaryEditor } from './BoundaryEditor';
import { setBoundaryEditing, setConceptEditor, useBoundaryEditing, useConceptEditor } from './boundaryEditing';
import { SiteConceptEditor } from './SiteConceptEditor';
import { frameMmPerTilePx, geoToLocal, localToGeo, localToTile, tileZoomFor } from './mapGeometry';
import { locationFrame, locationOf, mapTileUrls, type MapStyle } from './model';
import styles from './MapView.module.css';

const MAX_TILES_PER_LAYER = 400;

/** Tiles at one zoom covering `width` × `height` screen px whose top-left shows tile pixel (x, y). */
export const TileLayer = memo(function TileLayer({ style, zoom, x, y, scale, width, height }: { style: MapStyle | undefined; zoom: number; x: number; y: number; scale: number; width: number; height: number }) {
  const count = 2 ** zoom;
  const tx0 = Math.floor(x / 256), tx1 = Math.floor((x + width / scale) / 256);
  const ty0 = Math.max(0, Math.floor(y / 256)), ty1 = Math.min(count - 1, Math.floor((y + height / scale) / 256));
  if (!(scale > 0) || (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_TILES_PER_LAYER) return null;
  const base: ReactElement[] = [];
  const overlay: ReactElement[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    const top = Math.round((ty * 256 - y) * scale);
    const bottom = Math.round(((ty + 1) * 256 - y) * scale);
    for (let tx = tx0; tx <= tx1; tx++) {
      const left = Math.round((tx * 256 - x) * scale);
      const right = Math.round(((tx + 1) * 256 - x) * scale);
      const urls = mapTileUrls(style, zoom, ((tx % count) + count) % count, ty);
      const box = { left, top, width: right - left, height: bottom - top };
      base.push(<img key={`${tx}/${ty}`} src={urls.base} alt="" draggable={false} decoding="async" style={box} />);
      if (urls.overlay) overlay.push(<img key={`o${tx}/${ty}`} src={urls.overlay} alt="" draggable={false} decoding="async" style={box} />);
    }
  }
  return <div className={styles.tiles}>{base}{overlay}</div>;
});

export function MapAttribution({ style }: { style: MapStyle | undefined }) {
  const esri = <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a>;
  const osm = <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OSM</a>;
  switch (style) {
    case 'satellite': return <span className={styles.attribution}>Tiles © {esri}, Maxar, Earthstar</span>;
    case 'hybrid': return <span className={styles.attribution}>Tiles © {esri}, Maxar · © {osm}</span>;
    case 'topo': return <span className={styles.attribution}>Tiles © {esri}, USGS, © {osm}</span>;
    case 'light':
    case 'dark':
    case 'voyager': return <span className={styles.attribution}>© {osm} · © <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a></span>;
    default: return <span className={styles.attribution}>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></span>;
  }
}

/** Layers (screen px per tile px from `scaleAt`) at `zoom` and the two coarser levels, keyed by zoom so loaded tiles are reused as fallback. */
export function TileStack({ style, zoom, tileAt, scaleAt, width, height }: { style: MapStyle | undefined; zoom: number; tileAt: (zoom: number) => { x: number; y: number }; scaleAt: (zoom: number) => number; width: number; height: number }) {
  const levels = [zoom - 2, zoom - 1, zoom].filter((z) => z >= 1);
  return <>{levels.map((z) => { const origin = tileAt(z); return <TileLayer key={z} style={style} zoom={z} x={origin.x} y={origin.y} scale={scaleAt(z)} width={width} height={height} />; })}</>;
}

function niceLength(target: number): number {
  const power = 10 ** Math.floor(Math.log10(target));
  const n = target / power;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * power;
}

const RADII = [100, 250, 500, 1000];

/** Where the map's action bar floats: above the map (clear of the rotate handle), else below, else pinned to the top. */
function actionsPlacement(box: { left: number; right: number; top: number; bottom: number }, canvas: { width: number; height: number }): CSSProperties {
  // Keep the (about 420 px wide) bar on the board even when the map centre is off-screen.
  const x = Math.max(230, Math.min(canvas.width - 230, (box.left + box.right) / 2));
  if (box.top > 96) return { left: x, top: box.top - 40, transform: 'translate(-50%, -100%)' };
  if (canvas.height - box.bottom > 72) return { left: x, top: box.bottom + 16, transform: 'translateX(-50%)' };
  return { left: canvas.width / 2, top: 64, transform: 'translateX(-50%)' };
}


/** Where a map rect sits on screen and which part of it (in local millimetres) is visible. */
function useMapLayout(id: string) {
  const elements = useElementsWithAncestors([id]);
  const viewport = useAppState((s) => s.ui.viewport);
  const canvas = useAppState((s) => s.ui.canvasSize);
  const element = elements[id];
  const meta = locationOf(element);
  if (!element || element.kind !== 'rect' || !meta || !isEffectivelyVisible(elements, id)) return null;
  const zoom = viewport.zoom;
  const matrix = worldMatrix(elements, element);
  const outer = {
    left: matrix[4] * zoom + viewport.x,
    top: matrix[5] * zoom + viewport.y,
    width: element.width * zoom,
    height: element.height * zoom,
    transform: `rotate(${(Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI}deg)`,
  };
  const toLocal = invert(matrix);
  const corners = [[0, 0], [canvas.width, 0], [canvas.width, canvas.height], [0, canvas.height]].map(([sx, sy]) => applyToPoint(toLocal, { x: (sx! - viewport.x) / zoom, y: (sy! - viewport.y) / zoom }));
  const vx0 = Math.max(0, Math.min(...corners.map((c) => c.x)));
  const vy0 = Math.max(0, Math.min(...corners.map((c) => c.y)));
  const vx1 = Math.min(element.width, Math.max(...corners.map((c) => c.x)));
  const vy1 = Math.min(element.height, Math.max(...corners.map((c) => c.y)));
  const visible = vx1 > vx0 && vy1 > vy0;
  const view = { left: vx0 * zoom, top: vy0 * zoom, width: Math.max(0, (vx1 - vx0) * zoom), height: Math.max(0, (vy1 - vy0) * zoom) };
  const frame = locationFrame(element, meta);
  // Screen bounds of the (possibly rotated) rect, for UI that floats next to the map.
  const screen = [[0, 0], [element.width, 0], [element.width, element.height], [0, element.height]].map(([x, y]) => { const w = applyToPoint(matrix, { x: x!, y: y! }); return { x: w.x * zoom + viewport.x, y: w.y * zoom + viewport.y }; });
  const box = { left: Math.min(...screen.map((p) => p.x)), right: Math.max(...screen.map((p) => p.x)), top: Math.min(...screen.map((p) => p.y)), bottom: Math.max(...screen.map((p) => p.y)) };
  return { element, meta, zoom, outer, view, visible, frame, vx0, vy0, box, canvas };
}

/** The imagery, in the board's paint order (generated context and drawings go on top of it). */
export const BoardMap = memo(function BoardMap({ id }: { id: string }) {
  const layout = useMapLayout(id);
  const selected = useAppState((s) => s.ui.selection.length === 1 && s.ui.selection[0] === id);
  const editing = useBoundaryEditing() === id;
  if (!layout) return null;
  const { meta, zoom, outer, view, visible, frame, vx0, vy0 } = layout;
  const centre = meta.mapCenter ?? { lat: meta.lat, lon: meta.lon };
  return (
    <div className={styles.boardMap} style={outer} data-selected={selected || editing || undefined} data-testid={`analysis-node-${id}`}>
      {visible && (
        <div className={styles.view} style={view}>
          <TileStack
            style={meta.mapStyle}
            zoom={tileZoomFor(zoom, centre.lat)}
            tileAt={(z) => localToTile(frame, vx0, vy0, z)}
            scaleAt={(z) => frameMmPerTilePx(frame, z) * zoom}
            width={view.width}
            height={view.height}
          />
        </div>
      )}
    </div>
  );
});

/**
 * Site boundary, pin and labels. Painted in the board's order right after the map and what
 * lies under it in Layers (see Workboard), so other things placed on the map stay on top; while
 * the boundary is edited it is drawn above everything instead, so nothing blocks its handles.
 */
export const BoardMapOverlay = memo(function BoardMapOverlay({ id, top = false }: { id: string; top?: boolean }) {
  const layout = useMapLayout(id);
  const editing = useBoundaryEditing() === id;
  const dispatch = useDispatch();
  const { store } = useApp();
  if (!layout?.visible || editing !== top) return null;
  const { meta, zoom, outer, view, frame, vx0, vy0 } = layout;
  const toView = (p: { lat: number; lon: number }) => { const l = geoToLocal(frame, p); return { x: (l.x - vx0) * zoom, y: (l.y - vy0) * zoom }; };
  const pin = toView(meta);
  const barMetres = niceLength(90 / (zoom * 1000));
  const roomy = view.width > 260 && view.height > 140;
  return (
    <div className={styles.overlay} style={outer}>
      <div className={styles.view} style={view}>
        {(editing || !!meta.boundary?.length) && (
          <BoundaryEditor
            key={editing ? 'edit' : 'view'}
            points={meta.boundary ?? []}
            toView={toView}
            toGeo={(x, y) => localToGeo(frame, x / zoom + vx0, y / zoom + vy0)}
            width={view.width}
            height={view.height}
            editing={editing}
            onChange={(boundary) => void dispatch('update-analysis', { id, patch: { boundary: boundary as unknown as JsonValue } })}
            onDone={() => setBoundaryEditing(null)}
            snap={(point, moving) => {
              // View pixels -> the map's millimetres -> the board, snapped like any board point.
              const state = store.getState();
              const map = state.doc.elements[id];
              if (!map) return { ...point, label: null };
              const toWorld = worldMatrix(state.doc.elements, map);
              const world = applyToPoint(toWorld, { x: point.x / zoom + vx0, y: point.y / zoom + vy0 });
              const result = snapBoardPoint(state, world, { pixel: 1 / state.ui.viewport.zoom, ...(moving ? { exclude: new Set([id]) } : {}) });
              const local = applyToPoint(invert(toWorld), result.point);
              return { x: (local.x - vx0) * zoom, y: (local.y - vy0) * zoom, label: snapCaption(result) };
            }}
          />
        )}
        <span className={styles.pin} style={{ left: pin.x, top: pin.y }} data-testid={`map-pin-${id}`}>
          <MapPin size={28} fill="#fecaca" />
        </span>
        {roomy && <span className={`${styles.chip} ${styles.label}`}>{meta.address || `${meta.lat.toFixed(5)}, ${meta.lon.toFixed(5)}`}</span>}
        <span className={`${styles.chip} ${styles.north}`}>N ↑</span>
        {roomy && (
          <span className={`${styles.chip} ${styles.scale}`}>
            {barMetres >= 1000 ? `${barMetres / 1000} km` : `${barMetres} m`}
            <i style={{ width: barMetres * 1000 * zoom }} />
          </span>
        )}
        <MapAttribution style={meta.mapStyle} />
      </div>
    </div>
  );
});

/**
 * The selected map's action bar. Floats outside the map (above it, else below it, else at the
 * top of the board) so it never covers the site, and stays unrotated and screen-sized.
 */
const MapActions = memo(function MapActions({ id }: { id: string }) {
  const layout = useMapLayout(id);
  const selected = useAppState((s) => s.ui.selection.length === 1 && s.ui.selection[0] === id);
  const editing = useBoundaryEditing() === id;
  const dispatch = useDispatch();
  const [radius, setRadius] = useState(250);
  const [busy, setBusy] = useState(false);
  if (!layout?.visible || !selected || editing) return null;
  const { meta, box, canvas } = layout;
  const generate = async () => {
    setBusy(true);
    try { await dispatch('generate-site-context', { id, radius }); } finally { setBusy(false); }
  };
  return (
    <div className={styles.floatingActions} style={actionsPlacement(box, canvas)} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={() => setBoundaryEditing(id)} title={meta.boundary?.length ? 'Edit the site boundary' : 'Draw the site boundary'}><PenLine size={14} /> Boundary</button>
      <button type="button" onClick={() => void dispatch('recenter-map', { id })} title="Center the map frame on the fixed project pin"><Crosshair size={14} /> Recenter</button>
      <button type="button" onClick={() => setConceptEditor(id)} title="Open the site concept editor: setbacks, solids and voids on the site boundary"><Box size={14} /> Concept</button>
      <span className={styles.divider} />
      <label>
        <Route size={14} aria-hidden="true" />{' '}
        <select value={radius} aria-label="Context radius" onChange={(event) => setRadius(Number(event.target.value))}>
          {RADII.map((r) => <option key={r} value={r}>{r < 1000 ? `${r} m` : `${r / 1000} km`}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => void generate()} title="Load buildings and roads from OpenStreetMap as editable solids">
        {busy ? 'Loading…' : 'Generate context'}
      </button>
    </div>
  );
});

const mapIdCache = new WeakMap<object, string[]>();
/** Ids of map rects, memoised per elements table (it only changes identity on an edit). */
function mapIds(elements: Record<string, { id: string; kind: string; meta?: Record<string, unknown> }>): string[] {
  let ids = mapIdCache.get(elements);
  if (!ids) {
    ids = Object.values(elements).filter((e) => e.kind === 'rect' && e.meta?.['location']).map((e) => e.id);
    mapIdCache.set(elements, ids);
  }
  return ids;
}

/** What sits above the whole board for each map: its action bar, a boundary being edited, the concept editor. */
export function MapOverlays() {
  const ids = useAppStateShallow((s) => mapIds(boardDoc(s).elements));
  const concept = useConceptEditor();
  return (
    <>
      {ids.map((id) => <BoardMapOverlay key={`top-${id}`} id={id} top />)}
      {ids.map((id) => <MapActions key={`actions-${id}`} id={id} />)}
      {concept && ids.includes(concept) && <SiteConceptEditor mapId={concept} onClose={() => setConceptEditor(null)} />}
    </>
  );
}
