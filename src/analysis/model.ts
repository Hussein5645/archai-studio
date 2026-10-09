/**
 * Environmental analysis on the board. Everything lives in element `meta`, so it saves, undoes
 * and syncs like any other element:
 * - `meta.analysis`: a sun / wind / noise origin (a small rect card), its settings, the 3D view
 *   portals it is linked to and whether it is the project's one running analysis;
 * - `meta.location`: the project's single site map (a rect showing OpenStreetMap tiles);
 * - `meta.noiseEmitter`: a noise source that belongs to one noise origin.
 */
import type { ArchaiDocument, Element, JsonValue } from '@/document';
import { worldMatrix, applyToPoint, invert } from '@/geometry';
import { mapFrame, type MapFrame } from './mapGeometry';
import { instanceElevationOf } from '@/view3d/geometry';
import { compassVector, daySamples, localToUtc, sunDirection, sunPosition } from './sun';

export type AnalysisKind = 'sun' | 'wind' | 'noise';

export type MapStyle = 'street' | 'satellite' | 'hybrid' | 'topo' | 'light' | 'dark' | 'voyager';

export const MAP_STYLES: { value: MapStyle; label: string; description: string }[] = [
  { value: 'street', label: 'Street', description: 'Standard OpenStreetMap' },
  { value: 'satellite', label: 'Satellite', description: 'High-resolution aerial imagery' },
  { value: 'hybrid', label: 'Hybrid', description: 'Satellite imagery with roads & labels' },
  { value: 'topo', label: 'Topographic', description: 'Terrain, elevation contours & landmarks' },
  { value: 'light', label: 'Light', description: 'Minimal light basemap' },
  { value: 'dark', label: 'Dark', description: 'Minimal dark basemap' },
  { value: 'voyager', label: 'Voyager', description: 'Detailed cartographic basemap' },
];

export function mapTileUrls(style: MapStyle | undefined, zoom: number, x: number, y: number): { base: string; overlay?: string } {
  switch (style) {
    case 'satellite':
      return {
        base: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
      };
    case 'hybrid':
      return {
        base: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
        overlay: `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${zoom}/${y}/${x}`,
      };
    case 'topo':
      return {
        base: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${zoom}/${y}/${x}`,
      };
    case 'light':
      return {
        base: `https://basemaps.cartocdn.com/rastertiles/light_all/${zoom}/${x}/${y}.png`,
      };
    case 'dark':
      return {
        base: `https://basemaps.cartocdn.com/rastertiles/dark_all/${zoom}/${x}/${y}.png`,
      };
    case 'voyager':
      return {
        base: `https://basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${x}/${y}.png`,
      };
    case 'street':
    default:
      return {
        base: `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`,
      };
  }
}

export interface LocationMeta {
  /** Visual reference only; deliberately not exposed by siteOf to analysis solvers. */
  boundary?: { lat: number; lon: number }[];
  mapStyle?: MapStyle;
  mapCenter?: { lat: number; lon: number };
  /** Local millimetres (in the map rect) where `mapCenter` sits; the rect centre when absent. */
  anchor?: { x: number; y: number };
  lat: number;
  lon: number;
  zoom: number;
  address: string;
  elevation: number | null;
  utcOffset: number;
  timezone: string;
}

export interface WindData {
  prevailing: number;
  meanSpeed: number;
  /** Share of hours per 16 compass sectors (N, NNE, ...), summing to 1. */
  rose: number[];
  from: string;
  to: string;
}

export interface AnalysisMeta {
  kind: AnalysisKind;
  active: boolean;
  /** Views currently owned by this run; saved links remain available for restarting. */
  activeViews?: string[];
  views: string[];
  locationId: string | null;
  /** Own coordinates, used when no location is linked. */
  lat: number;
  lon: number;
  utcOffset: number;
  /** Board direction of true north, degrees clockwise from the board's up. */
  northAngle: number;
  // sun
  date: string;
  time: string;
  display: 'shadows' | 'sun-hours';
  sunshineHours: number | null;
  // wind
  speed: number;
  direction: number;
  height: number;
  windData: WindData | null;
  // noise
  receiverHeight: number;
  min: number;
  max: number;
  barrier: number;
}

export interface NoiseEmitterMeta {
  originId: string;
  /** Sound pressure level measured 1 m from the source, dB(A). */
  level: number;
  height: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export function defaultAnalysis(kind: AnalysisKind): AnalysisMeta {
  return {
    kind,
    active: false,
    views: [],
    locationId: null,
    lat: 51.5074,
    lon: -0.1278,
    utcOffset: 0,
    northAngle: 0,
    date: today(),
    time: '12:00',
    display: 'shadows',
    sunshineHours: null,
    speed: 5,
    direction: 225,
    height: 1500,
    windData: null,
    receiverHeight: 1500,
    min: 35,
    max: 85,
    barrier: 15,
  };
}

export const DEFAULT_LOCATION: LocationMeta = { lat: 51.5074, lon: -0.1278, zoom: 16, address: '', elevation: null, utcOffset: 0, timezone: 'UTC' };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function analysisOf(element: Element | undefined | null): AnalysisMeta | null {
  const value = record(element?.meta?.['analysis']);
  if (!value || (value['kind'] !== 'sun' && value['kind'] !== 'wind' && value['kind'] !== 'noise')) return null;
  return { ...defaultAnalysis(value['kind']), ...(value as Partial<AnalysisMeta>) };
}

export function locationOf(element: Element | undefined | null): LocationMeta | null {
  const value = record(element?.meta?.['location']);
  return value ? { ...DEFAULT_LOCATION, ...(value as Partial<LocationMeta>) } : null;
}

/** The 1:1 frame of a map rect: which local millimetre shows which place. */
export function locationFrame(element: Element, meta: LocationMeta): MapFrame {
  const width = 'width' in element ? element.width : 0;
  const height = 'height' in element ? element.height : 0;
  return mapFrame(meta.mapCenter ?? { lat: meta.lat, lon: meta.lon }, meta.anchor ?? { x: width / 2, y: height / 2 });
}

/** World position of a map's anchor, or null for other elements. */
export function mapAnchorWorld(elements: ArchaiDocument['elements'], element: Element): { x: number; y: number } | null {
  const meta = locationOf(element);
  if (!meta) return null;
  const frame = locationFrame(element, meta);
  return applyToPoint(worldMatrix(elements, element), { x: frame.ax, y: frame.ay });
}

/** Keeps the imagery still while a map rect is resized: re-expresses its anchor locally. */
export function setMapAnchorWorld(elements: ArchaiDocument['elements'], element: Element, world: { x: number; y: number }): void {
  const location = element.meta?.['location'];
  if (!location || typeof location !== 'object' || Array.isArray(location)) return;
  const local = applyToPoint(invert(worldMatrix(elements, element)), world);
  (location as Record<string, JsonValue>)['anchor'] = { x: local.x, y: local.y };
}

/** Generated OpenStreetMap context: a group hosted by the map, its two sub-groups and features. */
export interface SiteContextMeta {
  mapId: string;
  role: 'root' | 'buildings' | 'roads' | 'building' | 'road';
  osmId?: number;
}

export function siteContextOf(element: Element | undefined | null): SiteContextMeta | null {
  const value = record(element?.meta?.['siteContext']);
  return value && typeof value['mapId'] === 'string' && typeof value['role'] === 'string' ? (value as unknown as SiteContextMeta) : null;
}

/** The generated context group of a map, if any. */
export function siteContextRoot(doc: ArchaiDocument, mapId: string): Element | null {
  return Object.values(doc.elements).find((e) => { const c = siteContextOf(e); return c?.role === 'root' && c.mapId === mapId; }) ?? null;
}

export function noiseEmitterOf(element: Element | undefined | null): NoiseEmitterMeta | null {
  const value = record(element?.meta?.['noiseEmitter']);
  return value && typeof value['originId'] === 'string' ? { level: 80, height: 1000, ...(value as Partial<NoiseEmitterMeta>), originId: value['originId'] } : null;
}

export function isAnalysisElement(element: Element | undefined | null): boolean {
  return Boolean(element?.meta && (element.meta['analysis'] || element.meta['location'] || element.meta['noiseEmitter']));
}

export function projectLocation(doc: ArchaiDocument): Element | null {
  return Object.values(doc.elements).find((e) => locationOf(e)) ?? null;
}

/** Coordinates an origin works with: its linked location's, else its own. */
export function siteOf(doc: ArchaiDocument, meta: AnalysisMeta): { lat: number; lon: number; utcOffset: number; label: string } {
  const location = meta.locationId ? locationOf(doc.elements[meta.locationId]) : null;
  if (location) return { lat: location.lat, lon: location.lon, utcOffset: location.utcOffset, label: location.address || `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}` };
  return { lat: meta.lat, lon: meta.lon, utcOffset: meta.utcOffset, label: `${meta.lat.toFixed(4)}, ${meta.lon.toFixed(4)}` };
}

export function emittersOf(doc: ArchaiDocument, originId: string): Element[] {
  return Object.values(doc.elements).filter((e) => noiseEmitterOf(e)?.originId === originId);
}

// ---- what a 3D view renders ---------------------------------------------------------------------

export type AnalysisSpec =
  | { kind: 'sun'; display: 'shadows' | 'sun-hours'; current: [number, number, number] | null; samples: { dir: [number, number, number]; hours: number }[]; title: string }
  | { kind: 'wind'; flow: [number, number]; speed: number; height: number; title: string }
  | { kind: 'noise'; emitters: { id: string; x: number; y: number; z: number; level: number }[]; min: number; max: number; barrier: number; receiverHeight: number; title: string };

/** The running analysis if `portalId` is one of its linked views. */
export function viewAnalysis(doc: ArchaiDocument, portalId: string | null): AnalysisSpec | null {
  if (!portalId) return null;
  for (const element of Object.values(doc.elements)) {
    const meta = analysisOf(element);
    if (!meta?.active || !(meta.activeViews ?? meta.views).includes(portalId) || !element.visible) continue;
    return specOf(doc, element, meta);
  }
  return null;
}

export function specOf(doc: ArchaiDocument, element: Element, meta: AnalysisMeta): AnalysisSpec {
  const site = siteOf(doc, meta);
  if (meta.kind === 'sun') {
    const position = sunPosition(localToUtc(meta.date, meta.time, site.utcOffset), site.lat, site.lon);
    const current = position.altitude > 0 ? sunDirection(position, meta.northAngle) : null;
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
    return {
      kind: 'sun',
      display: meta.display,
      current,
      samples: meta.display === 'sun-hours' ? daySamples(meta.date, site.utcOffset, site.lat, site.lon, meta.northAngle, 60) : [],
      title: meta.display === 'sun-hours' ? `Direct sun hours · ${meta.date}` : `Sun ${meta.date} ${meta.time} · alt ${deg(position.altitude)}° · az ${deg(position.azimuth)}°`,
    };
  }
  if (meta.kind === 'wind') {
    const from = compassVector(meta.direction, meta.northAngle);
    return { kind: 'wind', flow: [-from[0], -from[1]], speed: meta.speed, height: meta.height, title: `Wind ${meta.speed.toFixed(1)} m/s from ${Math.round(meta.direction)}° · at ${(meta.height / 1000).toFixed(1)} m` };
  }
  const emitters = emittersOf(doc, element.id).filter((e) => e.visible).map((e) => {
    const emitter = noiseEmitterOf(e)!;
    const centre = applyToPoint(worldMatrix(doc.elements, e), { x: 'width' in e ? e.width / 2 : 0, y: 'height' in e ? e.height / 2 : 0 });
    return { id: e.id, x: centre.x, y: instanceElevationOf(e, doc.elements) + emitter.height, z: centre.y, level: emitter.level };
  });
  return { kind: 'noise', emitters, min: meta.min, max: meta.max, barrier: meta.barrier, receiverHeight: meta.receiverHeight, title: `Noise · ${emitters.length} source${emitters.length === 1 ? '' : 's'} · dB(A)` };
}
