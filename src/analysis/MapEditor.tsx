import { MapPin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BoundaryEditor } from './BoundaryEditor';
import { MapAttribution, TileStack } from './MapView';
import { MAP_STYLES, type LocationMeta, type MapStyle } from './model';
import { geoPoint, MAX_TILE_ZOOM, siteArea, sitePerimeter, tileXY } from './mapGeometry';
import styles from './MapEditor.module.css';
import viewStyles from './MapView.module.css';

export function MapEditor({ initial, onSave, onClose }: { initial: LocationMeta; onSave: (meta: LocationMeta) => Promise<unknown>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [mode, setMode] = useState<'pan' | 'pin' | 'boundary'>('pan');
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(node);
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      event.preventDefault();
      if (!event.deltaY) return;
      const rect = node.getBoundingClientRect();
      const dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2;
      setDraft((value) => {
        const zoom = Math.max(1, Math.min(MAX_TILE_ZOOM, value.zoom + (event.deltaY < 0 ? 1 : -1)));
        const centre = tileXY(value.mapCenter?.lat ?? value.lat, value.mapCenter?.lon ?? value.lon, value.zoom);
        const factor = 2 ** (zoom - value.zoom);
        return { ...value, zoom, mapCenter: geoPoint((centre.x + dx) * factor - dx, (centre.y + dy) * factor - dy, zoom) };
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', wheel); };
  }, []);
  const boundary = draft.boundary ?? [];
  const valid = boundary.length === 0 || (boundary.length >= 3 && siteArea(boundary) > 0);
  const zoom = Math.round(draft.zoom);
  const centre = tileXY(draft.mapCenter?.lat ?? draft.lat, draft.mapCenter?.lon ?? draft.lon, zoom);
  const left = centre.x - size.width / 2, top = centre.y - size.height / 2;
  const toView = (p: { lat: number; lon: number }) => { const t = tileXY(p.lat, p.lon, zoom); return { x: t.x - left, y: t.y - top }; };
  const pin = toView(draft);
  return createPortal(<dialog ref={dialog} aria-label="Project location and site boundary" className={styles.dialog} onCancel={(event) => { event.preventDefault(); if (!saving && mode !== 'boundary') onClose(); }}>
    <header><div><strong>Project location & site boundary</strong><p>Drop a pin for the location. Trace the site corners to draw its boundary — or draw it straight on the board map, at real scale.</p></div><button disabled={saving} onClick={onClose} aria-label="Close map editor">×</button></header>
    <div className={styles.tools}>
      {(['pan', 'pin', 'boundary'] as const).map((tool) => <button key={tool} aria-pressed={mode === tool} onClick={() => setMode(tool)}>{tool === 'pan' ? 'Pan map' : tool === 'pin' ? 'Drop pin' : 'Draw boundary'}</button>)}
      <label>Map style <select value={draft.mapStyle ?? 'street'} onChange={(event) => setDraft({ ...draft, mapStyle: event.target.value as MapStyle })}>{MAP_STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}</select></label>
      <button aria-label="Zoom out map" disabled={zoom <= 1} onClick={() => setDraft({ ...draft, zoom: zoom - 1 })}>−</button><span>Zoom {zoom}</span><button aria-label="Zoom in map" disabled={zoom >= MAX_TILE_ZOOM} onClick={() => setDraft({ ...draft, zoom: zoom + 1 })}>+</button>
      <button onClick={() => setDraft({ ...draft, mapCenter: { lat: draft.lat, lon: draft.lon } })}>Find pin</button>
    </div>
    <div ref={canvas} className={styles.canvas} style={{ cursor: mode === 'pan' ? 'grab' : 'crosshair' }} onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      if (mode === 'pin') {
        const point = geoPoint(left + event.clientX - rect.left, top + event.clientY - rect.top, zoom);
        setDraft({ ...draft, ...point, mapCenter: draft.mapCenter ?? { lat: draft.lat, lon: draft.lon }, address: '', elevation: null, timezone: 'UTC', utcOffset: 0 });
        setMode('pan');
        return;
      }
      drag.current = { x: event.clientX, y: event.clientY, cx: centre.x, cy: centre.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => { const start = drag.current; if (start) setDraft({ ...draft, mapCenter: geoPoint(start.cx - event.clientX + start.x, start.cy - event.clientY + start.y, zoom) }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <TileStack style={draft.mapStyle} zoom={zoom} tileAt={(z) => ({ x: left * 2 ** (z - zoom), y: top * 2 ** (z - zoom) })} scaleAt={(z) => 2 ** (zoom - z)} width={size.width} height={size.height} />
      <BoundaryEditor
        key={mode === 'boundary' ? 'edit' : 'view'}
        points={boundary}
        toView={toView}
        toGeo={(x, y) => geoPoint(left + x, top + y, zoom)}
        width={size.width}
        height={size.height}
        editing={mode === 'boundary'}
        onChange={(points) => setDraft((value) => ({ ...value, boundary: points }))}
      />
      <span className={viewStyles.pin} style={{ left: pin.x, top: pin.y }}><MapPin size={36} fill="#fecaca" /></span>
      <MapAttribution style={draft.mapStyle} />
    </div>
    <div className={styles.tools}>
      <span>{mode === 'boundary' ? 'Click to add corners; click the first corner or press Enter to close. Drag corners or hollow midpoints to adjust; double-click a corner to remove it.' : mode === 'pin' ? 'Tap the map to place the project pin.' : 'Drag to pan · scroll to zoom'}</span>
      <button disabled={!boundary.length} onClick={() => setDraft({ ...draft, boundary: boundary.slice(0, -1) })}>Undo corner</button>
      <button disabled={!boundary.length} onClick={() => setDraft({ ...draft, boundary: [] })}>Clear boundary</button>
    </div>
    <footer><div>{draft.lat.toFixed(5)}°, {draft.lon.toFixed(5)}° · {boundary.length} corners · <strong>{siteArea(boundary).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</strong> · perimeter {sitePerimeter(boundary).toFixed(1)} m<p>Boundary is a visual reference only and is excluded from analysis.</p>{!valid && <p role="status">Add at least three non-collinear corners, or clear the boundary.</p>}{error && <p role="alert">{error}</p>}</div><button disabled={saving} onClick={onClose}>Cancel</button><button disabled={!valid || saving} onClick={async () => { setSaving(true); setError(''); try { await onSave(draft); onClose(); } catch { setError('Could not save. Try again.'); } finally { setSaving(false); } }}>{saving ? 'Saving…' : 'Save location & site'}</button></footer>
  </dialog>, document.body);
}
