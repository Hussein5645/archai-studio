/**
 * Site concept editor: a full-screen window for quick conceptual massing on the site boundary.
 * Forms are vertical extrusions of a profile between a start and an end elevation; solids add
 * volume, voids cut it. A profile is the site boundary or a drawn outline, set back by an inset.
 * Every change is a normal command (`upsert-massing-form`), so it is undoable and appears on the
 * board, in Layers and in 3D views right away.
 */
import { Box, Eye, EyeOff, PencilLine, Scan, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState, useDispatch } from '@/app/context';
import { applyToPoint, invert, linePoints, worldMatrix } from '@/geometry';
import type { ElementTable } from '@/document';
import { formBaseWorld } from '@/commands/builtin/analysis';
import { BoundaryEditor } from './BoundaryEditor';
import { ConceptPreview, type ContextSolid } from './ConceptPreview';
import { computeMassing, conceptRoot, formsOf, insetProfileAsync, massingKey, type Form, type MassingMeta, type Plan } from './massing';
import { frameMmPerTilePx, geoToLocal, localToTile, siteArea, tileZoomFor, type GeoPoint } from './mapGeometry';
import { MapAttribution, TileStack } from './MapView';
import { locationFrame, locationOf, siteContextOf, siteContextRoot } from './model';
import styles from './SiteConcept.module.css';

const M = 1000;

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
/** Handlers that keep the editor's input from reaching the board it is mounted under. */
const isolateFromBoard = {
  onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop,
  onMouseDown: stop, onMouseUp: stop, onClick: stop, onDoubleClick: stop, onContextMenu: stop,
  onWheel: stop, onTouchStart: stop, onTouchMove: stop, onTouchEnd: stop,
  onKeyDown: stop, onKeyUp: stop, onDragOver: stop, onDrop: stop,
};
type Tool = 'select' | 'solid' | 'void';

/** Plan points ride through BoundaryEditor as {lon: x, lat: y}; its edge labels use plan metres. */
const toGeoish = ([x, y]: [number, number]): GeoPoint => ({ lon: x, lat: y });
const fromGeoish = (p: GeoPoint): [number, number] => [p.lon, p.lat];
const planDistance = (a: GeoPoint, b: GeoPoint) => Math.hypot(b.lon - a.lon, b.lat - a.lat) / M;

function planArea(points: Plan): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum / 2) / (M * M);
}

function worldPoints(elements: ElementTable, id: string): Plan {
  const element = elements[id];
  if (!element || element.kind !== 'line') return [];
  const matrix = worldMatrix(elements, element);
  return linePoints(element).map(([x, y]) => { const p = applyToPoint(matrix, { x, y }); return [p.x, p.y] as [number, number]; });
}

function MetreField({ label, value, onCommit, min, step = 0.5 }: { label: string; value: number; onCommit: (mm: number) => void; min?: number; step?: number }) {
  const [text, setText] = useState(String(Math.round((value / M) * 100) / 100));
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setText(String(Math.round((value / M) * 100) / 100)); }
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(Math.round(n * M));
    else setText(String(Math.round((value / M) * 100) / 100));
  };
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <span className={styles.input}>
        <input type="number" step={step} value={text} min={min} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} aria-label={label} />
        m
      </span>
    </label>
  );
}

/**
 * The project map under the plan, at the same true scale as the board: tiles follow the plan
 * zoom, and the imagery is drawn in the map rect's own frame so a rotated map lines up too.
 */
function PlanMap({ elements, mapId, view, width, height, opacity }: { elements: ElementTable; mapId: string; view: { scale: number; ox: number; oy: number }; width: number; height: number; opacity: number }) {
  const map = elements[mapId];
  const meta = locationOf(map);
  if (!map || !meta || width < 1 || height < 1) return null;
  const s = view.scale;
  const m = worldMatrix(elements, map);
  const toLocal = invert(m);
  // The plan's visible area in the map's local millimetres (the imagery extends past the rect).
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => applyToPoint(toLocal, { x: x! / s + view.ox, y: y! / s + view.oy }));
  const lx0 = Math.min(...corners.map((c) => c.x)), lx1 = Math.max(...corners.map((c) => c.x));
  const ly0 = Math.min(...corners.map((c) => c.y)), ly1 = Math.max(...corners.map((c) => c.y));
  const frame = locationFrame(map, meta);
  const centre = meta.mapCenter ?? { lat: meta.lat, lon: meta.lon };
  // Local px (local mm × scale) → plan px: the map's rotation plus the plan offset.
  const transform = `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${(m[4] - view.ox) * s}, ${(m[5] - view.oy) * s})`;
  return (
    <div className={styles.planMap} style={{ transform, opacity }} aria-hidden="true">
      <div style={{ position: 'absolute', left: lx0 * s, top: ly0 * s, width: (lx1 - lx0) * s, height: (ly1 - ly0) * s, overflow: 'hidden' }}>
        <TileStack
          style={meta.mapStyle}
          zoom={tileZoomFor(s, centre.lat)}
          tileAt={(z) => localToTile(frame, lx0, ly0, z)}
          scaleAt={(z) => frameMmPerTilePx(frame, z) * s}
          width={(lx1 - lx0) * s}
          height={(ly1 - ly0) * s}
        />
      </div>
    </div>
  );
}

export function SiteConceptEditor({ mapId, onClose }: { mapId: string; onClose: () => void }) {
  const dispatch = useDispatch();
  const elements = useAppState((s) => s.doc.elements);
  const map = elements[mapId];
  const location = locationOf(map);
  // Newest solid - void mesh from the worker, and which forms it was computed for.
  const [result, setResult] = useState<{ key: string; positions: Float32Array | null } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GeoPoint[]>([]);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(0);
  const [view, setView] = useState<{ scale: number; ox: number; oy: number } | null>(null);
  const [mapShade, setMapShade] = useState<'faded' | 'full' | 'off'>('faded');
  // Measured by the ResizeObserver below; the plan fits itself once it has a real size.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const plan = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);


  // Site boundary and context in world millimetres.
  const boundary: Plan = useMemo(() => {
    const element = elements[mapId];
    const meta = locationOf(element);
    if (!element || !meta?.boundary || meta.boundary.length < 3) return [];
    const frame = locationFrame(element, meta);
    const matrix = worldMatrix(elements, element);
    return meta.boundary.map((p) => { const w = applyToPoint(matrix, geoToLocal(frame, p)); return [w.x, w.y] as [number, number]; });
  }, [elements, mapId]);
  const context: ContextSolid[] = useMemo(() => {
    const root = siteContextRoot({ elements } as never, mapId);
    if (!root) return [];
    return Object.values(elements).filter((e) => siteContextOf(e)?.role === 'building' && e.visible).map((e) => ({
      profile: worldPoints(elements, e.id),
      height: typeof (e.meta?.['solid'] as { height?: unknown } | undefined)?.height === 'number' ? (e.meta!['solid'] as { height: number }).height : 9000,
    }));
  }, [elements, mapId]);
  const root = conceptRoot({ elements }, mapId);
  const forms: Form[] = useMemo(() => (root ? formsOf(elements, root.id) : []), [elements, root]);
  const selected = forms.find((f) => f.id === selectedId) ?? null;

  // Solids minus voids, from the massing worker; the newest request wins.
  const formsKey = useMemo(() => massingKey(forms), [forms]);
  useEffect(() => {
    let current = true;
    computeMassing(forms)
      .then((positions) => { if (current) setResult({ key: formsKey, positions }); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : 'The geometry engine failed'); });
    return () => { current = false; };
  }, [forms, formsKey]);
  // The last result stays on screen while a newer one is computed.
  const massing = result ? result.positions : undefined;
  const computing = result?.key !== formsKey;

  // Fit the plan to the site (or the forms, or the map rect) once there is something to show.
  useEffect(() => {
    const node = plan.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const fit = useCallback(() => {
    let pts: Plan = boundary.length ? boundary : forms.flatMap((f) => f.profile);
    if (!pts.length && map && map.kind === 'rect') {
      const m = worldMatrix(elements, map);
      pts = [[m[4], m[5]], [m[4] + map.width, m[5] + map.height]];
    }
    if (!pts.length) return;
    const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
    const scale = Math.min(size.width / ((maxX - minX) * 1.35 || 1), size.height / ((maxY - minY) * 1.35 || 1));
    setView({ scale, ox: (minX + maxX) / 2 - size.width / 2 / scale, oy: (minY + maxY) / 2 - size.height / 2 / scale });
  }, [boundary, forms, map, elements, size]);
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && size.width > 50) { fitted.current = true; fit(); } }, [fit, size]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]') && event.key !== 'Escape') return;
      const undo = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
      // The board underneath must not act on keys (Delete would remove its selection); undo/redo
      // still reach it so edits made here can be undone. Handlers on window itself still run.
      if (!undo) event.stopPropagation();
      if (event.key !== 'Escape') return;
      if (tool !== 'select') {
        // A closable outline is finished by the drawing handler; otherwise Esc cancels drawing.
        if (draft.length < 3) { event.stopImmediatePropagation(); setTool('select'); setDraft([]); }
        return;
      }
      event.stopImmediatePropagation();
      if (selectedId) setSelectedId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tool, selectedId, onClose, draft.length]);

  const v = view ?? { scale: 0.01, ox: 0, oy: 0 };
  const toView = (p: [number, number]) => ({ x: (p[0] - v.ox) * v.scale, y: (p[1] - v.oy) * v.scale });
  const points = (profile: Plan) => profile.map((p) => { const q = toView(p); return `${q.x},${q.y}`; }).join(' ');

  /** Saves a form, deriving its profile from the boundary or its drawn outline and the inset. */
  const save = async (form: { id?: string; kind: MassingMeta['kind']; source: MassingMeta['source']; base?: Plan; inset: number; start: number; end: number; name?: string; visible?: boolean }) => {
    setError('');
    const base = form.source === 'boundary' ? boundary : form.base ?? [];
    if (base.length < 3) { setError(form.source === 'boundary' ? 'Draw a site boundary on the map first.' : 'The outline needs at least three corners.'); return null; }
    if (form.end <= form.start) { setError('The end elevation must be above the start.'); return null; }
    let profile: Plan;
    try { profile = await insetProfileAsync(base, form.inset); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The geometry engine failed'); return null; }
    if (profile.length < 3) { setError('The setback is larger than the profile: nothing is left.'); return null; }
    const result = await dispatch('upsert-massing-form', { mapId, ...form, ...(form.source === 'drawn' ? { base } : {}), profile });
    return result.ok ? (result.value as string) : null;
  };
  const update = (form: Form, patch: Partial<MassingMeta> & { name?: string; visible?: boolean }) =>
    void save({ id: form.id, kind: patch.kind ?? form.meta.kind, source: form.meta.source, base: formBaseWorld(elements, form.id) ?? undefined, inset: patch.inset ?? form.meta.inset, start: patch.start ?? form.meta.start, end: patch.end ?? form.meta.end, name: patch.name ?? form.name, visible: patch.visible ?? form.visible });

  const topOfSolids = Math.max(0, ...forms.filter((f) => f.meta.kind === 'solid').map((f) => f.meta.end));
  const addFromBoundary = async () => {
    const tier = forms.filter((f) => f.meta.kind === 'solid' && f.meta.source === 'boundary').length;
    const id = await save({ kind: 'solid', source: 'boundary', inset: (3 + tier * 3) * M, start: topOfSolids, end: topOfSolids + (tier === 0 ? 12 : 18) * M });
    if (id) setSelectedId(id);
  };
  const finishDrawing = async (outline: GeoPoint[]) => {
    const base = outline.map(fromGeoish);
    const kind = tool === 'void' ? 'void' : 'solid';
    const id = await save(kind === 'void'
      ? { kind, source: 'drawn', base, inset: 0, start: 0, end: Math.max(topOfSolids, 6 * M) }
      : { kind, source: 'drawn', base, inset: 0, start: 0, end: 12 * M });
    setDraft([]);
    setTool('select');
    if (id) setSelectedId(id);
  };

  const siteM2 = location?.boundary && location.boundary.length >= 3 ? siteArea(location.boundary) : planArea(boundary);
  const maxHeight = Math.max(0, ...forms.filter((f) => f.meta.kind === 'solid' && f.visible).map((f) => f.meta.end));
  const editingBase = tool === 'select' && selected?.meta.source === 'drawn' ? formBaseWorld(elements, selected.id) : null;

  if (!map || !location) return null;
  return createPortal(
    // A portal still bubbles React events to its React ancestors: the Workboard, whose
    // pointerdown would capture the pointer (swallowing clicks here and never ending a pan).
    <div className={styles.window} role="dialog" aria-modal="true" aria-label="Site concept editor" {...isolateFromBoard}>
      <header className={styles.header}>
        <Box size={18} />
        <strong>Site concept</strong>
        <span className={styles.muted}>{location.address || `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`}</span>
        <span className={styles.spacer} />
        <span className={styles.stat}>Site <b>{siteM2.toLocaleString(undefined, { maximumFractionDigits: 0 })} m²</b></span>
        <span className={styles.stat}>Volume <b>{volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³</b></span>
        <span className={styles.stat}>Height <b>{(maxHeight / M).toFixed(1)} m</b></span>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close site concept editor"><X size={18} /> Back to project</button>
      </header>
      <div className={styles.body}>
        <aside className={styles.panel}>
          <section>
            <h3>Add</h3>
            <button type="button" className={styles.primary} disabled={!boundary.length} onClick={() => void addFromBoundary()} title={boundary.length ? 'A solid on the site boundary, set back from it' : 'Draw a site boundary on the map first'}>
              <Scan size={15} /> Solid from site boundary
            </button>
            <div className={styles.row}>
              <button type="button" aria-pressed={tool === 'solid'} onClick={() => { setTool(tool === 'solid' ? 'select' : 'solid'); setDraft([]); setSelectedId(null); }}><PencilLine size={15} /> Draw solid</button>
              <button type="button" aria-pressed={tool === 'void'} onClick={() => { setTool(tool === 'void' ? 'select' : 'void'); setDraft([]); setSelectedId(null); }}><PencilLine size={15} /> Draw void</button>
            </div>
            {tool !== 'select' && <p className={styles.hint}>Click corners in the plan; click the first corner or press Enter to close. Esc cancels.</p>}
            {!boundary.length && <p className={styles.hint}>No site boundary yet: draw one on the board map (Draw boundary) to derive forms from it.</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
          </section>
          <section className={styles.list}>
            <h3>Forms · {forms.length}</h3>
            {!forms.length && <p className={styles.hint}>Start with a solid from the site boundary, then cut voids into it.</p>}
            {forms.map((form) => (
              <div key={form.id} className={styles.item} data-selected={form.id === selectedId || undefined} data-kind={form.meta.kind} onClick={() => { setTool('select'); setSelectedId(form.id); }}>
                <span className={styles.swatch} />
                <span className={styles.itemName}>{form.name}</span>
                <span className={styles.muted}>{(form.meta.start / M).toFixed(1)}–{(form.meta.end / M).toFixed(1)} m</span>
                <button type="button" className={styles.iconButton} aria-label={form.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); update(form, { visible: !form.visible }); }}>{form.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
              </div>
            ))}
          </section>
          {selected && (
            <section key={selected.id}>
              <h3>{selected.meta.kind === 'solid' ? 'Solid' : 'Void'}</h3>
              <label className={styles.field}>
                <span>Name</span>
                <input defaultValue={selected.name} onBlur={(e) => e.target.value.trim() && e.target.value !== selected.name && update(selected, { name: e.target.value.trim() })} aria-label="Form name" />
              </label>
              <div className={styles.segmented}>
                {(['solid', 'void'] as const).map((kind) => <button key={kind} type="button" aria-pressed={selected.meta.kind === kind} onClick={() => update(selected, { kind })}>{kind === 'solid' ? 'Solid' : 'Void'}</button>)}
              </div>
              <p className={styles.hint}>Profile: {selected.meta.source === 'boundary' ? 'site boundary' : 'drawn outline — drag its corners in the plan'} · {planArea(selected.profile).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</p>
              <MetreField label="Setback (inset)" value={selected.meta.inset} onCommit={(inset) => update(selected, { inset })} />
              <div className={styles.row}>
                <MetreField label="Start elevation" value={selected.meta.start} onCommit={(start) => update(selected, { start })} />
                <MetreField label="End elevation" value={selected.meta.end} onCommit={(end) => update(selected, { end })} />
              </div>
              <p className={styles.hint}>Height {((selected.meta.end - selected.meta.start) / M).toFixed(2)} m · negative setback grows the profile.</p>
              <button type="button" className={styles.danger} onClick={() => { void dispatch('delete-selection', { ids: [selected.id] }); setSelectedId(null); }}><Trash2 size={15} /> Delete form</button>
            </section>
          )}
        </aside>
        <main className={styles.plan} ref={plan}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - rect.left, py = e.clientY - rect.top;
            const factor = Math.exp(-e.deltaY * 0.0015);
            const scale = v.scale * factor;
            setView({ scale, ox: v.ox + px / v.scale - px / scale, oy: v.oy + py / v.scale - py / scale });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 1) return;
            if (e.button === 0 && tool !== 'select') return;
            if (e.button === 0 && e.target !== e.currentTarget && !(e.target as Element).hasAttribute('data-plan-bg')) return;
            if (e.button === 0) setSelectedId(null);
            pan.current = { x: e.clientX, y: e.clientY, ox: v.ox, oy: v.oy };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => { const p = pan.current; if (p) setView({ scale: v.scale, ox: p.ox - (e.clientX - p.x) / v.scale, oy: p.oy - (e.clientY - p.y) / v.scale }); }}
          onPointerUp={() => { pan.current = null; }}
          onPointerCancel={() => { pan.current = null; }}
          onLostPointerCapture={() => { pan.current = null; }}
        >
          {mapShade !== 'off' && <PlanMap elements={elements} mapId={mapId} view={v} width={size.width} height={size.height} opacity={mapShade === 'faded' ? 0.55 : 1} />}
          <svg className={styles.planSvg} width={size.width} height={size.height}>
            <rect data-plan-bg="" width={size.width} height={size.height} fill="transparent" />
            {context.map((building, i) => building.profile.length >= 3 && <polygon key={i} points={points(building.profile)} className={styles.context} />)}
            {boundary.length >= 3 && <polygon points={points(boundary)} className={styles.boundary} />}
            {forms.filter((f) => f.visible).sort((a, b) => (a.meta.kind === b.meta.kind ? a.meta.start - b.meta.start : a.meta.kind === 'solid' ? -1 : 1)).map((form) => (
              <polygon key={form.id} points={points(form.profile)} className={styles.form} data-kind={form.meta.kind} data-selected={form.id === selectedId || undefined}
                onPointerDown={(e) => { if (tool !== 'select' || e.button !== 0) return; e.stopPropagation(); setSelectedId(form.id); }} />
            ))}
            {forms.filter((f) => f.visible).map((form) => {
              const c = form.profile.reduce((s, p) => [s[0] + p[0] / form.profile.length, s[1] + p[1] / form.profile.length], [0, 0]);
              const q = toView(c as [number, number]);
              return <text key={`t${form.id}`} x={q.x} y={q.y} className={styles.formLabel}>{form.name} · {(form.meta.end / M).toFixed(1)} m</text>;
            })}
          </svg>
          {tool !== 'select' && (
            <BoundaryEditor key={`draw-${tool}`} points={draft} editing toView={(p) => toView(fromGeoish(p))} toGeo={(x, y) => toGeoish([x / v.scale + v.ox, y / v.scale + v.oy])} width={size.width} height={size.height}
              onChange={setDraft} onClosed={(outline) => void finishDrawing(outline)} distance={planDistance} onDone={undefined} />
          )}
          {editingBase && selected && (
            <BoundaryEditor key={`edit-${selected.id}`} points={editingBase.map(toGeoish)} editing passThrough toView={(p) => toView(fromGeoish(p))} toGeo={(x, y) => toGeoish([x / v.scale + v.ox, y / v.scale + v.oy])} width={size.width} height={size.height}
              onChange={(outline) => outline.length >= 3 && void save({ id: selected.id, kind: selected.meta.kind, source: 'drawn', base: outline.map(fromGeoish), inset: selected.meta.inset, start: selected.meta.start, end: selected.meta.end })} distance={planDistance} />
          )}
          <div className={styles.planTools}>
            <button type="button" onClick={fit}>Fit</button>
            <label className={styles.muted}>
              Map{' '}
              <select value={mapShade} onChange={(e) => setMapShade(e.target.value as typeof mapShade)} aria-label="Map under the plan">
                <option value="faded">Faded</option>
                <option value="full">Full</option>
                <option value="off">Off</option>
              </select>
            </label>
            <span className={styles.muted}>Scroll to zoom · drag empty space to pan</span>
          </div>
          {mapShade !== 'off' && <MapAttribution style={location.mapStyle} />}
        </main>
        <section className={styles.previewPane}>
          <ConceptPreview forms={forms} boundary={boundary} context={context} massing={massing} selectedId={selectedId} onVolume={setVolume} />
          {computing && <span className={styles.loading}>Computing solids and voids…</span>}
        </section>
      </div>
    </div>,
    document.body,
  );
}
