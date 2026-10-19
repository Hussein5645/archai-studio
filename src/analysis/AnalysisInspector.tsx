import { useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element, JsonValue } from '@/document';
import { Divider, Field, FieldRow, NumberField, Segmented, SelectField, TextButton, TextField } from '@/ui/primitives';
import { useI18n } from '@/ui/i18n';
import { AnalysisDataPanel } from './AnalysisDataPanel';
import styles from '@/ui/Inspector.module.css';
import { MapEditor } from './MapEditor';
import { siteArea } from './mapGeometry';
import { analysisOf, emittersOf, locationOf, noiseEmitterOf, projectLocation, siteContextOf, siteContextRoot, siteOf, type AnalysisMeta, type WindData, MAP_STYLES, type MapStyle } from './model';
import { setBoundaryEditing, setConceptEditor, useBoundaryEditing } from './boundaryEditing';



/** Inspector sections for analysis origins, the project location and noise emitters. */
export function AnalysisInspector({ element }: { element: Element }) {
  const analysis = analysisOf(element);
  if (analysis) return <OriginInspector element={element} meta={analysis} />;
  const location = locationOf(element);
  if (location) return <LocationInspector element={element} />;
  const emitter = noiseEmitterOf(element);
  if (emitter) return <EmitterInspector element={element} />;
  return null;
}

function useUpdate(id: string) {
  const dispatch = useDispatch();
  return (patch: Record<string, JsonValue>) => void dispatch('update-analysis', { id, patch });
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

function OriginInspector({ element, meta }: { element: Element; meta: AnalysisMeta }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const update = useUpdate(element.id);
  const [busy, run] = useBusy();
  const location = projectLocation(doc);
  const site = siteOf(doc, meta);
  const { unit, precision } = doc.workspace;
  const views = Object.values(doc.elements).filter((e) => e.kind === 'rect' && e.meta?.['view3d']);
  const siteOptions = [...(location ? [{ value: location.id, label: t('Project location') }] : []), { value: 'manual', label: t('Manual coordinates') }];

  return (
    <>
      <div className={styles.section} data-testid="analysis-inspector">
        <h3 className="u-section-title">{t(meta.kind === 'sun' ? 'Sun analysis' : meta.kind === 'wind' ? 'Wind analysis' : 'Noise analysis')}</h3>
        <div className={styles.actions}>
          <TextButton primary disabled={!meta.active && !meta.views.length} onClick={() => void dispatch(meta.active ? 'stop-analysis' : 'run-analysis', { id: element.id })}>
            {meta.active ? t('Stop analysis') : t('Run analysis')}
          </TextButton>
        </div>
        <p className="u-hint">One analysis per view. Different views can run different analyses. Changes update running views automatically.</p>
      </div>

      <div className={styles.section}>
        <h3 className="u-section-title">Choose views · {meta.views.length} selected</h3>
        {!views.length && <><p className="u-hint">Add a 3D view to run this analysis.</p><TextButton onClick={() => void dispatch('create-view3d')}>Add 3D view</TextButton></>}
        {views.map((view, index) => {
          const owner = Object.values(doc.elements).find((item) => { const a = analysisOf(item); return a?.active && (a.activeViews ?? a.views).includes(view.id); });
          const linked = meta.views.includes(view.id);
          return <label key={view.id} className={styles.analysisViewChoice}>
            <input type="checkbox" checked={linked} onChange={(event) => void dispatch('link-analysis-view', { id: element.id, viewId: view.id, linked: event.target.checked })} />
            <span><strong>{view.name || '3D view'} · {index + 1}</strong><small>{owner?.id === element.id ? 'Running this analysis' : owner ? 'Running: ' + (owner.name || analysisOf(owner)!.kind) + (linked ? ' · replaced when you run' : '') : linked ? 'Ready to run' : 'No active analysis'}</small></span>
          </label>;
        })}
      </div>
      <Divider />
      {meta.kind !== 'noise' && (
        <>
          <div className={styles.section}>
            <h3 className="u-section-title">{t('Site')}</h3>
            <FieldRow single>
              <Field label="Coordinates from">
                <SelectField
                  value={meta.locationId && location?.id === meta.locationId ? meta.locationId : 'manual'}
                  options={siteOptions}
                  onChange={(value) => update({ locationId: value === 'manual' ? null : value })}
                  ariaLabel="Coordinates from"
                />
              </Field>
            </FieldRow>
            {!meta.locationId || !location ? (
              <>
                <FieldRow>
                  <Field label="Latitude">
                    <NumberField value={meta.lat} precision={5} min={-90} max={90} suffix="°" onCommit={(lat) => update({ lat })} ariaLabel="Latitude" />
                  </Field>
                  <Field label="Longitude">
                    <NumberField value={meta.lon} precision={5} min={-180} max={180} suffix="°" onCommit={(lon) => update({ lon })} ariaLabel="Longitude" />
                  </Field>
                </FieldRow>
                <FieldRow single>
                  <Field label="UTC offset">
                    <NumberField value={meta.utcOffset} precision={2} min={-12} max={14} suffix="h" onCommit={(utcOffset) => update({ utcOffset })} ariaLabel="UTC offset" />
                  </Field>
                </FieldRow>
              </>
            ) : (
              <p className="u-hint">{site.label}</p>
            )}
            <FieldRow single>
              <Field label="True north (clockwise from board up)">
                <NumberField value={meta.northAngle} precision={1} min={-360} max={360} suffix="°" onCommit={(northAngle) => update({ northAngle })} ariaLabel="North angle" />
              </Field>
            </FieldRow>
          </div>
          <Divider />
        </>
      )}

      {meta.kind === 'sun' && (
        <div className={styles.section}>
          <h3 className="u-section-title">{t('Sun')}</h3>
          <FieldRow>
            <Field label="Date">
              <input className={styles.analysisDateTime} type="date" aria-label="Sun date" value={meta.date} onChange={(event) => { if (event.target.validity.valid && event.target.value) update({ date: event.target.value, sunshineHours: null }); }} />
            </Field>
            <Field label="Local time">
              <input className={styles.analysisDateTime} type="time" step="60" aria-label="Sun local time" value={meta.time} onChange={(event) => { if (event.target.validity.valid && event.target.value) update({ time: event.target.value }); }} />
            </Field>
          </FieldRow>
          <FieldRow single>
            <Field label="Show">
              <Segmented value={meta.display} options={[{ value: 'shadows', label: 'Shadows' }, { value: 'sun-hours', label: 'Sun hours' }]} onChange={(display) => update({ display })} ariaLabel="Sun display" />
            </Field>
          </FieldRow>
          <div className={styles.actions}>
            <TextButton disabled={busy} onClick={() => void run(() => dispatch('fetch-sunshine', { id: element.id }))}>
              {busy ? t('Loading…') : t('Fetch typical sunshine (Open-Meteo)')}
            </TextButton>
          </div>
          {meta.sunshineHours !== null && (
            <p className="u-hint">
              {t('Typical sunshine this month')}: <b>{meta.sunshineHours} h/day</b>
            </p>
          )}
        </div>
      )}

      {meta.kind === 'wind' && (
        <div className={styles.section}>
          <h3 className="u-section-title">{t('Wind')}</h3>
          <FieldRow>
            <Field label="Speed">
              <NumberField value={meta.speed} precision={1} min={0.1} max={80} suffix="m/s" onCommit={(speed) => update({ speed })} ariaLabel="Wind speed" />
            </Field>
            <Field label="From (bearing)">
              <NumberField value={meta.direction} precision={0} min={0} max={360} suffix="°" onCommit={(direction) => update({ direction: ((direction % 360) + 360) % 360 })} ariaLabel="Wind direction" />
            </Field>
          </FieldRow>
          <FieldRow single>
            <Field label="Analysis height">
              <NumberField value={meta.height} unit={unit} precision={precision} min={100} onCommit={(height) => update({ height })} ariaLabel="Analysis height" />
            </Field>
          </FieldRow>
          <div className={styles.actions}>
            <TextButton disabled={busy} onClick={() => void run(() => dispatch('fetch-wind-data', { id: element.id }))}>
              {busy ? t('Loading…') : t('Fetch 12 months of wind (Open-Meteo)')}
            </TextButton>
          </div>
          {meta.windData && <WindRose data={meta.windData} onUse={(direction) => update({ direction })} />}
        </div>
      )}

      {meta.kind === 'noise' && (
        <div className={styles.section}>
          <h3 className="u-section-title">{t('Noise')}</h3>
          <div className={styles.actions}>
            <TextButton primary onClick={() => void dispatch('tool-noise-emitter', { originId: element.id })}>
              {t('Add point emitter')}
            </TextButton>
            <TextButton onClick={() => void dispatch('tool-noise-emitter', { originId: element.id, shape: 'area' })}>
              {t('Draw area emitter')}
            </TextButton>
          </div>
          <p className="u-hint">
            {emittersOf(doc, element.id).length} emitters · click the board to add more, Esc to finish. In a running noise view, select a red marker and drag its XYZ gizmo to move it in 3D.
          </p>
          <FieldRow>
            <Field label="Scale from">
              <NumberField value={meta.min} precision={0} suffix="dB" onCommit={(min) => update({ min })} ariaLabel="Scale minimum" />
            </Field>
            <Field label="Scale to">
              <NumberField value={meta.max} precision={0} suffix="dB" onCommit={(max) => update({ max })} ariaLabel="Scale maximum" />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Barrier loss">
              <NumberField value={meta.barrier} precision={0} min={0} max={40} suffix="dB" onCommit={(barrier) => update({ barrier })} ariaLabel="Barrier loss" />
            </Field>
            <Field label="Ground receiver height">
              <NumberField value={meta.receiverHeight} unit={unit} precision={precision} min={0} onCommit={(receiverHeight) => update({ receiverHeight })} ariaLabel="Receiver height" />
            </Field>
          </FieldRow>
          <p className="u-hint">{t('Point sources: level at 1 m minus 20·log10(distance); a blocked sight line loses the barrier value.')}</p>
        </div>
      )}

      <AnalysisDataPanel element={element} meta={meta} />
    </>
  );
}

const SECTORS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function WindRose({ data, onUse }: { data: WindData; onUse: (direction: number) => void }) {
  const { t } = useI18n();
  const max = Math.max(...data.rose, 0.0001);
  return (
    <div>
      <svg width={140} height={140} viewBox="-70 -70 140 140" role="img" aria-label={t('Wind rose')}>
        <circle r={60} fill="none" stroke="#d0d7de" />
        <circle r={30} fill="none" stroke="#eaeef2" />
        {data.rose.map((share, i) => {
          const angle = ((i * 22.5 - 90) * Math.PI) / 180;
          const width = (11.25 * Math.PI) / 180;
          const r = 8 + (share / max) * 52;
          const p = (a: number, radius: number) => `${Math.cos(a) * radius},${Math.sin(a) * radius}`;
          return <path key={i} d={`M0,0 L${p(angle - width, r)} A${r},${r} 0 0 1 ${p(angle + width, r)} Z`} fill={i * 22.5 === data.prevailing ? '#0284c7' : '#7dd3fc'} />;
        })}
        <text y={-62} textAnchor="middle" fontSize={10} fill="#57606a">N</text>
      </svg>
      <p className="u-hint">
        {t('Prevailing')}: <b>{SECTORS[Math.round(data.prevailing / 22.5) % 16]} ({data.prevailing}°)</b> · {t('mean from there')} <b>{data.meanSpeed.toFixed(1)} m/s</b>
        <br />
        ERA5 · Open-Meteo · {data.from} → {data.to}
      </p>
      <div className={styles.actions}>
        <TextButton onClick={() => onUse(data.prevailing)}>{t('Use prevailing direction')}</TextButton>
      </div>
    </div>
  );
}

function LocationInspector({ element }: { element: Element }) {
  const [mapOpen, setMapOpen] = useState(false);
  const { t } = useI18n();
  const dispatch = useDispatch();
  const update = useUpdate(element.id);
  const [busy, run] = useBusy();
  const [contextBusy, runContext] = useBusy();
  const [radius, setRadius] = useState(250);
  const editingBoundary = useBoundaryEditing() === element.id;
  const context = useAppState((s) => siteContextRoot(s.doc, element.id));
  const contextCounts = useAppState((s) => {
    if (!context) return '';
    let buildings = 0, roads = 0;
    for (const e of Object.values(s.doc.elements)) {
      const role = siteContextOf(e)?.mapId === element.id ? siteContextOf(e)!.role : null;
      if (role === 'building') buildings++;
      else if (role === 'road') roads++;
    }
    return `${buildings} buildings, ${roads} roads`;
  });
  const meta = locationOf(element)!;
  return (
    <>
      <div className={styles.section} data-testid="location-inspector">
        <h3 className="u-section-title">{t('Project location')}</h3>
        <p className="u-hint">Move or resize the map frame to reveal another area. The project pin and site geometry stay fixed on the board.</p>
        <p className="u-hint">The map is at real scale (1:1): zoom the board to zoom the map, resize the rect to see more ground.</p>
        <div className={styles.actions}>
          <TextButton primary={editingBoundary} onClick={() => setBoundaryEditing(editingBoundary ? null : element.id)}>
            {editingBoundary ? 'Finish boundary' : meta.boundary?.length ? 'Edit site boundary on board' : 'Draw site boundary on board'}
          </TextButton>
          <TextButton onClick={() => setMapOpen(true)}>Pin, pan & style…</TextButton>
          <TextButton onClick={() => void dispatch('recenter-map', { id: element.id })}>Recenter on pin</TextButton>
        </div>
        <div className={styles.actions}>
          <TextButton primary onClick={() => setConceptEditor(element.id)}>Open site concept editor</TextButton>
        </div>
        {mapOpen && <MapEditor initial={meta} onClose={() => setMapOpen(false)} onSave={async (value) => {
          const result = await dispatch('update-analysis', { id: element.id, patch: value as unknown as Record<string, JsonValue> });
          if (!result.ok) throw new Error(result.error.message);
          if (value.lat !== meta.lat || value.lon !== meta.lon) await dispatch('refresh-location-details', { id: element.id });
        }} />}
        <FieldRow single>
          <Field label="Search address or place">
            <TextField value="" placeholder={busy ? 'Searching…' : 'e.g. Tower Bridge, London'} disabled={busy} onCommit={(query) => query.trim().length > 1 && void run(() => dispatch('search-location', { id: element.id, query: query.trim() }))} ariaLabel="Search location" />
          </Field>
        </FieldRow>
        <div className={styles.actions}>
          <TextButton disabled={busy} onClick={() => void run(() => dispatch('locate-project', { id: element.id }))}>
            {busy ? t('Loading…') : 'Use my location'}
          </TextButton>
        </div>
        {meta.address && <p className="u-hint">{meta.address}</p>}
        <FieldRow>
          <Field label="Latitude">
            <NumberField value={meta.lat} precision={5} min={-90} max={90} suffix="°" onCommit={(lat) => update({ lat })} ariaLabel="Latitude" />
          </Field>
          <Field label="Longitude">
            <NumberField value={meta.lon} precision={5} min={-180} max={180} suffix="°" onCommit={(lon) => update({ lon })} ariaLabel="Longitude" />
          </Field>
        </FieldRow>
        <FieldRow single>
          <Field label="Map style">
            <SelectField
              value={meta.mapStyle ?? 'street'}
              options={MAP_STYLES.map((style) => ({ value: style.value, label: `${style.label} (${style.description})` }))}
              onChange={(value) => update({ mapStyle: value as MapStyle })}
              ariaLabel="Map style"
            />
          </Field>
        </FieldRow>
      </div>
      <Divider />
      <div className={styles.section}>
        <h3 className="u-section-title">Surroundings</h3>
        <FieldRow single>
          <Field label="Radius around the pin">
            <NumberField value={radius} precision={0} min={25} max={1500} step={50} suffix="m" onCommit={(value) => setRadius(Math.round(value))} ariaLabel="Context radius" />
          </Field>
        </FieldRow>
        <div className={styles.actions}>
          <TextButton disabled={contextBusy} onClick={() => void runContext(() => dispatch('generate-site-context', { id: element.id, radius }))}>
            {contextBusy ? t('Loading…') : context ? 'Regenerate roads & buildings' : 'Generate roads & buildings'}
          </TextButton>
        </div>
        <p className="u-hint">
          {context ? <><b>{context.name}</b> · {contextCounts}. Regenerating replaces it. </> : null}
          Buildings become extruded footprints (height from OSM, else from levels), roads solid strips; each is its own element under the map in Layers. Data © OpenStreetMap contributors (ODbL).
        </p>
      </div>
      <Divider />
      <div className={styles.section}>
        <h3 className="u-section-title">{t('Site data')}</h3>
        {!!meta.boundary?.length && <p className="u-hint"><b>Site boundary · {siteArea(meta.boundary).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</b><br />{meta.boundary.length} corners · Reference only, excluded from analysis.</p>}
        <p className="u-hint">
          {t('Elevation')}: <b>{meta.elevation === null ? '—' : `${Math.round(meta.elevation)} m`}</b>
          <br />
          {t('Time zone')}: <b>{meta.timezone}</b> (UTC{meta.utcOffset >= 0 ? '+' : ''}
          {meta.utcOffset})
        </p>
        <div className={styles.actions}>
          <TextButton disabled={busy} onClick={() => void run(() => dispatch('refresh-location-details', { id: element.id }))}>
            {busy ? t('Loading…') : t('Update from Open-Meteo')}
          </TextButton>
        </div>
        <p className="u-hint">{t('Sun and wind origins linked to this location use its coordinates and time zone. Map data © OpenStreetMap contributors.')}</p>
      </div>
    </>
  );
}

function EmitterInspector({ element }: { element: Element }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const update = useUpdate(element.id);
  const meta = noiseEmitterOf(element)!;
  const { unit, precision } = doc.workspace;
  return (
    <div className={styles.section} data-testid="emitter-inspector">
      <h3 className="u-section-title">{t('Noise emitter')}</h3>
      <label>Source shape <select value={meta.shape ?? 'point'} onChange={(event) => update({ shape: event.target.value })}>
        <option value="point">Point</option><option value="area">Area</option>
      </select></label>
      {meta.shape === 'area' && <p className="u-hint">Resize and rotate the area on the board. Its total reference level is distributed across the area; this is an approximate outdoor screening model.</p>}
      {meta.shape === 'area' && 'width' in element && 'height' in element && <FieldRow>
        <Field label="Area width"><NumberField value={element.width} unit={unit} precision={precision} min={100} ariaLabel="Emitter area width" onCommit={(width) => void dispatch('set-transform', { id: element.id, width })} /></Field>
        <Field label="Area depth"><NumberField value={element.height} unit={unit} precision={precision} min={100} ariaLabel="Emitter area depth" onCommit={(height) => void dispatch('set-transform', { id: element.id, height })} /></Field>
      </FieldRow>}
      <p className="u-hint">
        {t('Belongs to')}: <b>{doc.elements[meta.originId]?.name ?? t('missing origin')}</b>
      </p>
      <FieldRow>
        <Field label="Level at 1 m">
          <NumberField value={meta.level} precision={0} min={0} max={160} suffix="dB" onCommit={(level) => update({ level })} ariaLabel="Emitter level" />
        </Field>
        <Field label="Height above level">
          <NumberField value={meta.height} unit={unit} precision={precision} min={0} onCommit={(height) => update({ height })} ariaLabel="Emitter height" />
        </Field>
      </FieldRow>
      <p className="u-hint">{t('Typical: conversation 60, busy road 80, construction 95, generator 100 dB.')}</p>
    </div>
  );
}
