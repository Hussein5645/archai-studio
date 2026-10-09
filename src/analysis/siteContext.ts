/**
 * Surrounding context from OpenStreetMap (Overpass API, free and key-less; ODbL, attribution
 * required): building footprints with a height estimate and road centre lines with a width
 * estimate, ready to become editable board solids.
 */
import type { GeoPoint } from './mapGeometry';

export interface ContextFeature {
  kind: 'building' | 'road';
  osmId: number;
  name?: string;
  /** OSM `building` or `highway` value. */
  type: string;
  /** Footprint (buildings, open ring) or centre line (roads). */
  points: GeoPoint[];
  /** Millimetres: building height or road width. */
  size: number;
}

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEDGE_DELAY = 4_000;
const REQUEST_TIMEOUT = 45_000;
const LEVEL_HEIGHT = 3200;
const SKIPPED_HIGHWAYS = new Set(['proposed', 'construction', 'abandoned', 'platform', 'corridor', 'elevator', 'raceway', 'bus_stop', 'razed', 'escape']);
const ROAD_WIDTH: Record<string, number> = {
  motorway: 15_000, trunk: 12_000, primary: 10_000, secondary: 8_500, tertiary: 7_000,
  motorway_link: 6_000, trunk_link: 6_000, primary_link: 6_000, secondary_link: 5_500, tertiary_link: 5_500,
  unclassified: 6_000, residential: 6_000, living_street: 5_000, road: 6_000, busway: 6_000,
  service: 4_000, pedestrian: 4_000, track: 3_000,
  footway: 2_000, path: 1_800, cycleway: 2_000, bridleway: 2_000, steps: 2_000, sidewalk: 2_000,
};

export function overpassQuery(lat: number, lon: number, radius: number): string {
  const around = `(around:${Math.round(radius)},${lat.toFixed(7)},${lon.toFixed(7)})`;
  return `[out:json][timeout:40];(way["building"]${around};way["highway"]${around};);out geom qt;`;
}

/** "12", "12 m", "12.5m", "40'" → millimetres. */
function metres(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|')?/.exec(value);
  if (!match) return null;
  const n = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return (match[2] === 'ft' || match[2] === "'" ? n * 0.3048 : n) * 1000;
}

export function buildingHeight(tags: Record<string, string>): number {
  const explicit = metres(tags['height']) ?? metres(tags['building:height']);
  if (explicit) return Math.min(explicit, 900_000);
  const levels = Number(tags['building:levels']);
  const roof = Number(tags['roof:levels']);
  if (Number.isFinite(levels) && levels > 0) return (levels + (Number.isFinite(roof) && roof > 0 ? roof * 0.5 : 0)) * LEVEL_HEIGHT;
  const type = tags['building'] ?? 'yes';
  if (['garage', 'garages', 'shed', 'hut', 'kiosk', 'carport', 'roof', 'cabin', 'toilets'].includes(type)) return LEVEL_HEIGHT;
  if (['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'static_caravan'].includes(type)) return 2 * LEVEL_HEIGHT;
  return 3 * LEVEL_HEIGHT;
}

export function roadWidth(tags: Record<string, string>): number {
  const explicit = metres(tags['width']) ?? metres(tags['est_width']);
  if (explicit) return explicit;
  const lanes = Number(tags['lanes']);
  if (Number.isFinite(lanes) && lanes > 0) return lanes * 3_500;
  return ROAD_WIDTH[tags['highway'] ?? ''] ?? 5_000;
}

export interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
}

export function parseOverpass(data: { elements?: OverpassWay[] }): ContextFeature[] {
  const features: ContextFeature[] = [];
  for (const way of data.elements ?? []) {
    if (way.type !== 'way' || !way.tags || !way.geometry) continue;
    const points = way.geometry.filter((p): p is GeoPoint => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => ({ lat: p.lat, lon: p.lon }));
    const tags = way.tags;
    const name = tags['name'] || tags['addr:housename'] || undefined;
    if (tags['building'] && tags['building'] !== 'no') {
      const first = points[0], last = points.at(-1);
      if (first && last && first.lat === last.lat && first.lon === last.lon) points.pop();
      if (points.length < 3) continue;
      features.push({ kind: 'building', osmId: way.id, type: tags['building'], points, size: buildingHeight(tags), ...(name ? { name } : {}) });
    } else if (tags['highway'] && !SKIPPED_HIGHWAYS.has(tags['highway']) && tags['area'] !== 'yes') {
      if (points.length < 2) continue;
      features.push({ kind: 'road', osmId: way.id, type: tags['highway'], points, size: roadWidth(tags), ...(name ? { name } : {}) });
    }
  }
  return features;
}

/**
 * Public Overpass instances are often busy (504s, or requests that hang), so requests are hedged:
 * the next instance starts if the previous one has not answered after a few seconds, the first
 * good answer wins and the others are aborted.
 */
export async function fetchSiteContext(lat: number, lon: number, radius: number): Promise<ContextFeature[]> {
  const query = overpassQuery(lat, lon, radius);
  const controllers = OVERPASS.map(() => new AbortController());
  const errors: string[] = [];
  const attempt = async (endpoint: string, i: number): Promise<ContextFeature[]> => {
    await new Promise((resolve) => setTimeout(resolve, i * HEDGE_DELAY));
    const signal = controllers[i]!.signal;
    if (signal.aborted) throw new Error('cancelled');
    const timeout = setTimeout(() => controllers[i]!.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { Accept: 'application/json' }, signal });
      if (!response.ok) throw new Error(`${new URL(endpoint).host} answered HTTP ${response.status}`);
      return parseOverpass((await response.json()) as { elements?: OverpassWay[] });
    } catch (error) {
      errors.push(error instanceof Error && error.name !== 'AbortError' ? error.message : `${new URL(endpoint).host} did not answer`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    return await Promise.any(OVERPASS.map(attempt));
  } catch {
    throw new Error(`OpenStreetMap (Overpass) is busy right now; try again in a minute (${errors.join('; ')})`);
  } finally {
    for (const controller of controllers) controller.abort();
  }
}
