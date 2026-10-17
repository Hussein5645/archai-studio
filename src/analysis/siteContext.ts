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
const REQUEST_TIMEOUT = 25_000;
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
  return `[out:json][timeout:20];(way["building"]${around};way["highway"]${around};);out geom qt;`;
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


interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

/** Keep the editing API fallback small: a single manual request, at most a 1 km-wide box. */
export function contextMapUrl(lat: number, lon: number, radius: number): string | null {
  if (radius > 500 || Math.abs(lat) > 85) return null;
  const dy = radius / 111_195;
  const dx = dy / Math.cos(lat * Math.PI / 180);
  if (lon - dx < -180 || lon + dx > 180) return null;
  return 'https://api.openstreetmap.org/api/0.6/map.json?bbox=' + [lon - dx, lat - dy, lon + dx, lat + dy].map(n => n.toFixed(7)).join(',');
}

/** Reconstruct complete ways and retain those intersecting the requested circle (not the box). */
export function parseContextMap(data: { elements: OsmElement[] }, lat: number, lon: number, radius: number): ContextFeature[] {
  const nodes = new Map(data.elements.filter(e => e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)).map(e => [e.id, {lat:e.lat!, lon:e.lon!}]));
  const ways: OverpassWay[] = [];
  for (const way of data.elements) {
    if (way.type !== 'way' || !way.tags || !way.nodes || !(way.tags['building'] || way.tags['highway'])) continue;
    const geometry = way.nodes.map(id => nodes.get(id));
    if (geometry.some(point => !point)) continue;
    const points = geometry as GeoPoint[];
    const local = points.map(p => ({ x:(p.lon - lon)*111_195*Math.cos(lat*Math.PI/180), y:(p.lat-lat)*111_195 }));
    const intersects = local.some((a,i) => {
      const b = local[i+1] ?? a;
      const dx=b.x-a.x,dy=b.y-a.y;
      const t=Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/(dx*dx+dy*dy || 1)));
      return Math.hypot(a.x+t*dx,a.y+t*dy) <= radius;
    });
    // A footprint surrounding the whole requested circle has no edge inside the radius.
    let contains = false;
    if (way.tags['building'] && way.nodes[0] === way.nodes.at(-1)) {
      for(let i=0,j=local.length-1;i<local.length;j=i++) {
        const a=local[i]!,b=local[j]!;
        if ((a.y>0)!==(b.y>0) && 0 < (b.x-a.x)*(-a.y)/(b.y-a.y)+a.x) contains=!contains;
      }
    }
    if(intersects || contains) ways.push({type:'way',id:way.id,tags:way.tags,geometry:points});
  }
  return parseOverpass({elements:ways});
}

const contextCache = new Map<string, { at: number; features: ContextFeature[] }>();
const pendingContext = new Map<string, Promise<ContextFeature[]>>();
const CACHE_TTL = 5 * 60_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve,reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled','AbortError')); };
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

async function downloadSiteContext(lat: number, lon: number, radius: number): Promise<ContextFeature[]> {
  const query=overpassQuery(lat,lon,radius);
  const mapUrl=contextMapUrl(lat,lon,radius);
  const sources=[...OVERPASS.map((url,i)=>({url,wait:i*HEDGE_DELAY,map:false})),...(mapUrl ? [{url:mapUrl,wait:HEDGE_DELAY,map:true}] : [])];
  const controllers=sources.map(()=>new AbortController());
  const errors:string[]=[];
  const attempt=async(source:typeof sources[number],i:number):Promise<ContextFeature[]>=>{
    const controller=controllers[i]!;
    await delay(source.wait,controller.signal);
    const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);
    try {
      const response=await fetch(source.url,{
        ...(source.map ? {} : {method:'POST',body:new URLSearchParams({data:query})}),
        headers:{Accept:'application/json'},signal:controller.signal,
      });
      const host=new URL(source.url).host;
      if(!response.ok) throw new Error(host+' returned HTTP '+response.status);
      const data=await response.json() as {elements?:unknown;remark?:string};
      if(data.remark) throw new Error(host+': '+data.remark.slice(0,240));
      if(!Array.isArray(data.elements)) throw new Error(host+' returned invalid map data');
      return source.map ? parseContextMap(data as {elements:OsmElement[]},lat,lon,radius) : parseOverpass(data as {elements:OverpassWay[]});
    } catch(error) {
      errors.push(error instanceof Error && error.name!=='AbortError' ? error.message : new URL(source.url).host+' timed out');
      throw error;
    } finally {clearTimeout(timer);}
  };
  try {return await Promise.any(sources.map(attempt));}
  catch {throw new Error('Could not download buildings and roads from OpenStreetMap. '+(mapUrl ? 'The data services are unavailable; try again later.' : 'Try a radius of 500 m or less to use the backup map service.')+' ('+errors.join('; ')+')');}
  finally {controllers.forEach(controller=>controller.abort());}
}

/** Coalesce repeated clicks and cache successful downloads; failed requests remain retryable. */
export async function fetchSiteContext(lat:number,lon:number,radius:number):Promise<ContextFeature[]> {
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(radius)||Math.abs(lat)>90||Math.abs(lon)>180||radius<25||radius>1500) throw new Error('Invalid context location or radius');
  const key=[lat.toFixed(7),lon.toFixed(7),radius].join(':');
  const cached=contextCache.get(key);
  if(cached && Date.now()-cached.at<CACHE_TTL) return structuredClone(cached.features);
  let pending=pendingContext.get(key);
  if(!pending) {
    pending=downloadSiteContext(lat,lon,radius).then(features=>{
      contextCache.delete(key);
      contextCache.set(key,{at:Date.now(),features});
      while(contextCache.size>12) contextCache.delete(contextCache.keys().next().value!);
      return features;
    }).finally(()=>pendingContext.delete(key));
    pendingContext.set(key,pending);
  }
  return structuredClone(await pending);
}
