/**
 * The numbers behind the environmental studies, for spreadsheets, reports and sheets:
 * - grid samples of the running analysis (sun hours / lit, dB(A), m/s) on the ground and roofs
 *   and on each level's floor, taken from the same computation the 3D view draws;
 * - summaries per surface and per room or zone (min, mean, max, share at or above a threshold);
 * - site and climate tables (hourly sun positions, the wind rose, sunshine hours).
 * Everything is CSV or JSON; positions are board millimetres, heights millimetres.
 */
import { isArchType } from '@/assets/arch-meta';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { applyToPoint, pointInPolygon, worldMatrix, type Vec2 } from '@/geometry';
import { diagramOf } from '@/diagrams/model';
import { siteOf, type AnalysisMeta } from './model';
import { localToUtc, sunPosition } from './sun';

export interface DataRow {
  x: number;
  y: number;
  z: number;
  surface: string;
  value: number;
}

export interface AnalysisDataset {
  kind: AnalysisMeta['kind'];
  title: string;
  quantity: string;
  unit: string;
  spacing: number;
  rows: DataRow[];
}

/** What a study measures and in which unit. */
export function quantityOf(meta: AnalysisMeta): { quantity: string; unit: string; threshold: number } {
  if (meta.kind === 'sun') return meta.display === 'sun-hours' ? { quantity: 'Direct sun hours', unit: 'h', threshold: 2 } : { quantity: `Direct sun at ${meta.time} (1 = sun, 0 = shade)`, unit: '', threshold: 0.5 };
  if (meta.kind === 'noise') return { quantity: 'Sound level', unit: 'dB(A)', threshold: 55 };
  return { quantity: 'Wind speed', unit: 'm/s', threshold: 5 };
}

/** A level's floor is sampled below this height above it (the plan cut). */
const LEVEL_CUT = 1200;

export interface Sampler {
  /** Board-mm grid samples below `clipTop` (null: everything). */
  sample(spacing: number, clipTop: number | null): { x: number; y: number; z: number; value: number }[];
}

/** Levels by elevation (name and elevation in mm). */
export function levelsOf(doc: ArchaiDocument): { id: string; name: string; elevation: number }[] {
  return Object.values(doc.elements)
    .flatMap((element) => {
      const level = element.meta?.['level'] as { elevation?: number } | undefined;
      return level ? [{ id: element.id, name: element.name ?? 'Level', elevation: Number(level.elevation ?? 0) }] : [];
    })
    .sort((a, b) => a.elevation - b.elevation);
}

/** Collects a dataset from a sampler (the running view's analysis). */
export function collectSamples(doc: ArchaiDocument, meta: AnalysisMeta, sampler: Sampler, spacing: number): AnalysisDataset {
  const { quantity, unit } = quantityOf(meta);
  const rows: DataRow[] = [];
  const round = (row: DataRow): DataRow => ({ ...row, x: Math.round(row.x), y: Math.round(row.y), z: Math.round(row.z), value: Math.round(row.value * 1000) / 1000 });
  if (meta.kind === 'wind') {
    for (const s of sampler.sample(spacing, null)) rows.push(round({ ...s, surface: `${(s.z / 1000).toFixed(1)} m above ground` }));
  } else {
    // Ground and roofs as seen from above.
    for (const s of sampler.sample(spacing, null)) rows.push(round({ ...s, surface: s.z < 400 ? 'Ground' : 'Roof' }));
    // Each level's floor: everything above its plan cut removed, floor-height samples kept.
    for (const level of levelsOf(doc)) {
      for (const s of sampler.sample(spacing, level.elevation + LEVEL_CUT)) {
        if (s.z >= level.elevation - 50 && s.z <= level.elevation + 600) rows.push(round({ ...s, surface: level.name }));
      }
    }
  }
  return { kind: meta.kind, title: quantity, quantity, unit, spacing, rows };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function datasetCsv(dataset: AnalysisDataset): string {
  return toCsv(['x_mm', 'y_mm', 'z_mm', 'surface', dataset.unit ? `${dataset.quantity} (${dataset.unit})` : dataset.quantity], dataset.rows.map((row) => [row.x, row.y, row.z, row.surface, row.value]));
}

export interface SummaryRow {
  name: string;
  kind: 'surface' | 'room' | 'zone';
  count: number;
  min: number;
  mean: number;
  max: number;
  /** Share of samples at or above the threshold, 0..1. */
  share: number;
}

function stats(name: string, kind: SummaryRow['kind'], values: number[], threshold: number): SummaryRow | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let above = 0;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    if (v >= threshold) above += 1;
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return { name, kind, count: values.length, min: r(min), mean: r(sum / values.length), max: r(max), share: r(above / values.length) };
}

/** World polygon of a room (closed line) or a zone (rect), with the level it belongs to. */
function regionOf(elements: ElementTable, element: Element): { name: string; kind: 'room' | 'zone'; polygon: Vec2[]; level: string | null } | null {
  const levelId = (element.meta?.['levelConstraint'] as { levelId?: string } | undefined)?.levelId;
  const level = levelId ? (elements[levelId]?.name ?? null) : null;
  const m = worldMatrix(elements, element);
  if (element.kind === 'line' && element.closed && isArchType(element, 'room')) {
    return { name: element.name ?? 'Room', kind: 'room', polygon: element.points.map(([x, y]) => applyToPoint(m, { x, y })), level };
  }
  const diagram = diagramOf(element);
  if (element.kind === 'rect' && diagram?.kind === 'zone') {
    const corners: [number, number][] = [[0, 0], [element.width, 0], [element.width, element.height], [0, element.height]];
    return { name: diagram.text || element.name || 'Zone', kind: 'zone', polygon: corners.map(([x, y]) => applyToPoint(m, { x, y })), level };
  }
  return null;
}

/** Statistics per surface, then per room and zone (samples inside each, on its level if it has one). */
export function summarize(doc: ArchaiDocument, dataset: AnalysisDataset, threshold: number): SummaryRow[] {
  const out: SummaryRow[] = [];
  const surfaces = [...new Set(dataset.rows.map((row) => row.surface))];
  for (const surface of surfaces) {
    const row = stats(surface, 'surface', dataset.rows.filter((r) => r.surface === surface).map((r) => r.value), threshold);
    if (row) out.push(row);
  }
  if (dataset.kind === 'wind') return out;
  const elements = doc.elements as ElementTable;
  for (const element of Object.values(elements)) {
    const region = regionOf(elements, element);
    if (!region) continue;
    // A room on a level reads that level's floor; free regions read the ground.
    const surface = region.level ?? 'Ground';
    const values = dataset.rows.filter((r) => r.surface === surface && pointInPolygon({ x: r.x, y: r.y }, region.polygon)).map((r) => r.value);
    const row = stats(region.name, region.kind, values, threshold);
    if (row) out.push(row);
  }
  return out;
}

export function summaryCsv(rows: SummaryRow[], dataset: AnalysisDataset, threshold: number): string {
  const unit = dataset.unit ? ` (${dataset.unit})` : '';
  return toCsv(['name', 'type', 'samples', `min${unit}`, `mean${unit}`, `max${unit}`, `share >= ${threshold}${unit}`], rows.map((r) => [r.name, r.kind, r.count, r.min, r.mean, r.max, `${Math.round(r.share * 100)}%`]));
}

const DEG = 180 / Math.PI;

/** Hourly sun altitude and azimuth on a date at the site (daylight hours only). */
export function sunTable(doc: ArchaiDocument, meta: AnalysisMeta, date: string): { time: string; altitude: number; azimuth: number }[] {
  const site = siteOf(doc, meta);
  const out: { time: string; altitude: number; azimuth: number }[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const time = `${String(hour).padStart(2, '0')}:00`;
    const p = sunPosition(localToUtc(date, time, site.utcOffset), site.lat, site.lon);
    if (p.altitude <= 0) continue;
    out.push({ time, altitude: Math.round(p.altitude * DEG * 10) / 10, azimuth: Math.round(p.azimuth * DEG * 10) / 10 });
  }
  return out;
}

const SECTORS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Site and climate data as one CSV: location, sun positions (study date, solstices, equinox), wind, sunshine. */
export function climateCsv(doc: ArchaiDocument, meta: AnalysisMeta): string {
  const site = siteOf(doc, meta);
  const year = (meta.date || new Date().toISOString().slice(0, 10)).slice(0, 4);
  const rows: (string | number)[][] = [
    ['site', 'location', site.label, ''],
    ['site', 'latitude', site.lat, '°'],
    ['site', 'longitude', site.lon, '°'],
    ['site', 'UTC offset', site.utcOffset, 'h'],
  ];
  const dates = [...new Set([meta.date, `${year}-03-20`, `${year}-06-21`, `${year}-12-21`].filter(Boolean))];
  for (const date of dates) for (const row of sunTable(doc, meta, date)) rows.push([`sun ${date}`, row.time, row.altitude, `altitude °; azimuth ${row.azimuth}°`]);
  if (meta.windData) {
    rows.push(['wind', 'prevailing', meta.windData.prevailing, '° from']);
    rows.push(['wind', 'mean speed', meta.windData.meanSpeed, 'm/s']);
    meta.windData.rose.forEach((share, i) => rows.push(['wind rose', SECTORS[i] ?? String(i), Math.round(share * 1000) / 10, '% of hours']));
  }
  if (meta.sunshineHours !== null) rows.push(['sun', 'sunshine hours', meta.sunshineHours, 'h / year']);
  return toCsv(['group', 'item', 'value', 'unit / note'], rows);
}

