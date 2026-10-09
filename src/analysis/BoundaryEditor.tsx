/**
 * Site boundary drawn over a map, Google Earth style: while drawing, each click adds a corner
 * and clicking the first corner (or Enter) closes the outline; afterwards corners drag, the
 * hollow midpoint handles insert a corner, and double-click / right-click / Delete removes one.
 * Works in any pixel space (the board map or the map editor dialog) through `toView`/`toGeo`;
 * give it a `key` that changes with `editing` so each session starts fresh.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { geoDistance, siteArea, sitePerimeter, type GeoPoint } from './mapGeometry';
import styles from './MapView.module.css';

interface Props {
  points: GeoPoint[];
  toView: (point: GeoPoint) => { x: number; y: number };
  toGeo: (x: number, y: number) => GeoPoint;
  width: number;
  height: number;
  editing: boolean;
  /** Commits a finished change (one undo step). */
  onChange: (points: GeoPoint[]) => void;
  /** Shows the floating area / Done panel (the board map; the dialog has its own footer). */
  onDone?: () => void;
  /** Called when a drawn outline is closed (first corner clicked, or Enter / Escape). */
  onClosed?: (points: GeoPoint[]) => void;
  /** Edge length in metres; geographic by default (the concept editor passes plan distances). */
  distance?: (a: GeoPoint, b: GeoPoint) => number;
  /** Once the outline is closed, let clicks between the handles through to what is underneath. */
  passThrough?: boolean;
  /**
   * Snaps a view point to the board (its lines, corners, walls and grid); `moving` while a
   * corner is dragged (the boundary then does not snap to itself). Alt skips it.
   */
  snap?: (point: { x: number; y: number }, moving: boolean) => { x: number; y: number; label: string | null };
}

const ACCENT = '#2563eb';

function formatMetres(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(m < 10 ? 2 : 1)} m`;
}

export function BoundaryEditor({ points, toView, toGeo, width, height, editing, onChange, onDone, onClosed, distance = geoDistance, passThrough = false, snap }: Props) {
  // Local copy while dragging / until the committed change comes back as new `points`.
  const [draft, setDraft] = useState<{ base: GeoPoint[]; points: GeoPoint[] } | null>(null);
  const [drawing, setDrawing] = useState(() => points.length < 3);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /** Where the pointer snapped and to what (drawn as a marker). */
  const [marker, setMarker] = useState<{ x: number; y: number; label: string } | null>(null);
  const snapped = (p: { x: number; y: number }, moving: boolean, alt: boolean) => {
    if (!snap || alt) {
      setMarker(null);
      return p;
    }
    const result = snap(p, moving);
    setMarker(result.label ? { x: result.x, y: result.y, label: result.label } : null);
    return { x: result.x, y: result.y };
  };
  const root = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number } | null>(null);
  const pending = draft && draft.base === points ? draft.points : null;
  const shown = pending ?? points;
  const closed = !drawing && shown.length >= 3;

  const commit = (next: GeoPoint[]) => {
    setDraft({ base: points, points: next });
    onChange(next);
  };
  const remove = (index: number) => {
    const next = shown.filter((_, i) => i !== index);
    if (next.length < 3) setDrawing(true);
    setSelected(null);
    commit(next);
  };

  const latest = useRef({ drawing, shown, selected, remove, onDone, finish: () => {} });
  useEffect(() => {
    latest.current = { drawing, shown, selected, remove, onDone, finish: () => { if (shown.length >= 3) { setDrawing(false); onClosed?.(shown); } } };
  });
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const s = latest.current;
      let handled = true;
      if (event.key === 'Enter') {
        if (s.drawing && s.shown.length >= 3) s.finish();
        else s.onDone?.();
      } else if (event.key === 'Escape') {
        if (s.drawing && s.shown.length >= 3) s.finish();
        else s.onDone?.();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        // Never let the board delete the map while its outline is being edited.
        if (s.selected !== null) s.remove(s.selected);
        else if (s.drawing && s.shown.length) s.remove(s.shown.length - 1);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && s.drawing && s.shown.length) {
        s.remove(s.shown.length - 1);
      } else handled = false;
      if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing]);

  const viewPoint = (event: ReactPointerEvent | PointerEvent) => {
    const box = root.current!.getBoundingClientRect();
    // The board map may be rotated: undo it through the SVG's own screen matrix.
    const matrix = root.current!.getScreenCTM();
    if (matrix) {
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      return { x: p.x, y: p.y };
    }
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const startDrag = (event: ReactPointerEvent, index: number, next: GeoPoint[]) => {
    drag.current = { index };
    setDraft({ base: points, points: next });
    setSelected(index);
    // On the root: a midpoint handle is replaced by a corner as soon as it is dragged.
    root.current?.setPointerCapture(event.pointerId);
  };

  const view = shown.map(toView);
  const segments: [number, number][] = [];
  for (let i = 0; i + 1 < view.length; i++) segments.push([i, i + 1]);
  if (closed) segments.push([view.length - 1, 0]);
  const stop = (event: { stopPropagation: () => void }) => { if (editing) event.stopPropagation(); };

  return (
    <>
      <svg
        ref={root}
        className={styles.boundary}
        width={width}
        height={height}
        style={{ pointerEvents: editing && (drawing || !passThrough) ? 'auto' : 'none', cursor: editing && drawing ? 'crosshair' : 'default' }}
        aria-label={editing ? 'Site boundary editor' : 'Site boundary (reference only)'}
        onPointerDown={(event) => {
          if (!editing || event.button !== 0) return;
          event.stopPropagation();
          event.preventDefault();
          const p = snapped(viewPoint(event), false, event.altKey);
          if (drawing) {
            const next = [...shown, toGeo(p.x, p.y)];
            setSelected(null);
            commit(next);
          } else setSelected(null);
        }}
        onPointerMove={(event) => {
          if (!editing) return;
          event.stopPropagation();
          const raw = viewPoint(event);
          const state = drag.current;
          if (state && pending) {
            const p = snapped(raw, true, event.altKey);
            setDraft({ base: points, points: pending.map((point, i) => (i === state.index ? toGeo(p.x, p.y) : point)) });
          } else if (drawing) setHover(snapped(raw, false, event.altKey));
          else setMarker(null);
        }}
        onPointerUp={(event) => {
          if (!editing) return;
          event.stopPropagation();
          const state = drag.current;
          drag.current = null;
          setMarker(null);
          if (state && pending) commit(pending);
        }}
        onPointerCancel={() => { drag.current = null; setDraft(null); }}
        onPointerLeave={() => { setHover(null); setMarker(null); }}
        onDoubleClick={stop}
        onContextMenu={(event) => { if (editing) { event.preventDefault(); event.stopPropagation(); } }}
      >
        {view.length >= 2 && (closed
          ? <polygon points={view.map((p) => `${p.x},${p.y}`).join(' ')} fill="#3b82f622" stroke={ACCENT} strokeWidth={editing ? 2 : 3} strokeDasharray={editing ? undefined : '10 7'} strokeLinejoin="round" />
          : <polyline points={view.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" />)}
        {editing && drawing && hover && view.length > 0 && (
          <>
            <line x1={view.at(-1)!.x} y1={view.at(-1)!.y} x2={hover.x} y2={hover.y} stroke={ACCENT} strokeWidth={1.5} strokeDasharray="6 5" pointerEvents="none" />
            {view.length >= 2 && <line x1={hover.x} y1={hover.y} x2={view[0]!.x} y2={view[0]!.y} stroke={ACCENT} strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="6 5" pointerEvents="none" />}
          </>
        )}
        {editing && segments.map(([a, b]) => {
          const pa = view[a]!, pb = view[b]!;
          const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
          if (length < 24) return null;
          const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
          const angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
          const upright = angle > 90 || angle < -90 ? angle + 180 : angle;
          return (
            <g key={`seg-${a}-${b}`}>
              {length > 90 && (
                <text className={styles.edgeLabel} x={mid.x} y={mid.y} dy={-9} textAnchor="middle" transform={`rotate(${upright} ${mid.x} ${mid.y})`}>
                  {formatMetres(distance(shown[a]!, shown[b]!))}
                </text>
              )}
              <circle
                className={styles.midpoint}
                cx={mid.x}
                cy={mid.y}
                r={5}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  event.preventDefault();
                  const next = [...shown];
                  next.splice(a + 1, 0, toGeo(mid.x, mid.y));
                  startDrag(event, a + 1, next);
                }}
              />
            </g>
          );
        })}
        {editing && view.map((p, i) => (
          <circle
            key={`v-${i}`}
            className={styles.vertex}
            data-selected={selected === i || undefined}
            data-closer={(drawing && i === 0 && view.length >= 3) || undefined}
            cx={p.x}
            cy={p.y}
            r={drawing && i === 0 && view.length >= 3 ? 9 : 7}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.preventDefault();
              if (drawing && i === 0 && shown.length >= 3) { setDrawing(false); setHover(null); onClosed?.(shown); return; }
              startDrag(event, i, [...shown]);
            }}
            onDoubleClick={(event) => { event.stopPropagation(); remove(i); }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); remove(i); }}
          >
            <title>{drawing && i === 0 && view.length >= 3 ? 'Close the outline' : 'Drag to move · double-click or Delete to remove'}</title>
          </circle>
        ))}
        {editing && marker && (
          <g pointerEvents="none" data-testid="boundary-snap">
            <rect x={marker.x - 6} y={marker.y - 6} width={12} height={12} fill="none" stroke="#16a34a" strokeWidth={2} />
            <text x={marker.x + 10} y={marker.y - 10} fontSize={11} fontWeight={600} fill="#15803d" stroke="#ffffff" strokeWidth={3} paintOrder="stroke">{marker.label}</text>
          </g>
        )}
      </svg>
      {editing && onDone && (
        <div className={styles.boundaryPanel} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <strong>Site boundary</strong>
          <span>
            Area <b>{siteArea(shown).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</b> · Perimeter <b>{formatMetres(sitePerimeter(shown, closed))}</b>
          </span>
          <small>
            {drawing
              ? shown.length >= 3 ? 'Click to add corners · click the first corner or press Enter to close' : 'Click the map to place each corner'
              : 'Drag corners to move · drag a hollow midpoint to add · double-click a corner to remove'}
          </small>
          <div>
            {!drawing && <button type="button" onClick={() => setDrawing(true)} disabled={shown.length < 3}>Add corners</button>}
            <button type="button" disabled={!shown.length} onClick={() => remove(selected ?? shown.length - 1)}>{selected !== null ? 'Delete corner' : 'Undo corner'}</button>
            <button type="button" disabled={!shown.length} onClick={() => { setDrawing(true); setSelected(null); commit([]); }}>Clear</button>
            <button type="button" data-primary onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </>
  );
}
