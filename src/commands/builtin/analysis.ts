/**
 * Environmental analysis commands (see src/analysis/model.ts for the element meta). Only one
 * analysis runs per project; it shows only in the 3D views linked to its origin.
 */
import { z } from 'zod';
import { IdSchema, JsonValueSchema, indexAfter, type Element, type ElementTable, type GroupElement, type JsonValue, type LineElement } from '@/document';
import { applyToPoint, worldMatrix } from '@/geometry';
import { analysisOf, DEFAULT_LOCATION, defaultAnalysis, locationFrame, locationOf, noiseEmitterOf, projectLocation, siteContextRoot, siteOf, type AnalysisKind, type LocationMeta } from '@/analysis/model';
import { geoToLocal, localToGeo } from '@/analysis/mapGeometry';
import { fetchSiteContext } from '@/analysis/siteContext';
import { conceptRoot, massingOf } from '@/analysis/massing';
import { reverseGeocode, searchPlace, siteDetails, sunshineForMonth, userPosition, windHistory } from '@/analysis/data';
import { CommandError, defineEffect, defineMutation, type MutationContext } from '../contract';
import { removeSubtree, setSelection, topIndex } from '../helpers';
import { createRect } from './create';
import { moveSelection } from './transform';

const KIND_STYLE: Record<AnalysisKind, { stroke: string; name: string }> = {
  sun: { stroke: '#d97706', name: 'Sun analysis' },
  wind: { stroke: '#0284c7', name: 'Wind analysis' },
  noise: { stroke: '#dc2626', name: 'Noise analysis' },
};

function viewportCentre(ctx: MutationContext, width: number, height: number) {
  const { viewport, canvasSize } = ctx.ui;
  return { x: (canvasSize.width / 2 - viewport.x) / viewport.zoom - width / 2, y: (canvasSize.height / 2 - viewport.y) / viewport.zoom - height / 2 };
}

function metaKeyOf(meta: Record<string, unknown> | undefined): 'analysis' | 'location' | 'noiseEmitter' | null {
  if (meta?.['analysis']) return 'analysis';
  if (meta?.['location']) return 'location';
  if (meta?.['noiseEmitter']) return 'noiseEmitter';
  return null;
}

export const createAnalysisOrigin = defineMutation({
  id: 'create-analysis-origin',
  label: 'Add analysis origin',
  description: 'Places a sun, wind or noise analysis origin; link 3D views to it and run it to see the analysis in those views.',
  aliases: ['sun study', 'shadow study', 'wind study', 'noise study', 'acoustic'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ kind: z.enum(['sun', 'wind', 'noise']), x: z.number().finite().optional(), y: z.number().finite().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() }),
  run: (ctx, input) => {
    const width = input.width ?? 8000;
    const height = input.height ?? 5000;
    const drawn = input.width !== undefined && input.height !== undefined;
    const at = input.x !== undefined && input.y !== undefined ? { x: input.x - (drawn ? 0 : width / 2), y: input.y - (drawn ? 0 : height / 2) } : viewportCentre(ctx, width, height);
    const location = projectLocation(ctx.doc as never);
    const analysis = { ...defaultAnalysis(input.kind), locationId: location?.id ?? null };
    return createRect.run(ctx, {
      ...at,
      width,
      height,
      radius: Math.min(300, width / 2, height / 2),
      rotation: 0,
      style: { fill: '#ffffff', stroke: KIND_STYLE[input.kind].stroke, strokeWidth: 30, opacity: 1 },
      name: KIND_STYLE[input.kind].name,
      meta: { analysis: analysis as unknown as JsonValue },
      parentId: null,
      select: true,
    });
  },
});

export const createLocation = defineMutation({
  id: 'create-location',
  label: 'Add project location',
  description: 'Draws the project site map (OpenStreetMap) at true 1:1 scale: board millimetres are ground millimetres. A project has at most one location.',
  aliases: ['map', 'site', 'geolocation', 'openstreetmap'],
  group: 'create',
  history: 'record',
  input: z
    .object({ x: z.number().finite().optional(), y: z.number().finite().optional(), width: z.number().positive().default(200_000), height: z.number().positive().default(140_000) })
    .prefault({}),
  when: (ctx) => !projectLocation(ctx.doc),
  run: (ctx, input) => {
    if (projectLocation(ctx.doc as never)) throw new CommandError('rejected', 'This project already has a location; edit the existing map instead');
    const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : viewportCentre(ctx, input.width, input.height);
    const id = createRect.run(ctx, {
      ...at,
      width: input.width,
      height: input.height,
      radius: 0,
      rotation: 0,
      style: { fill: '#e5e7eb', stroke: '#6b7280', strokeWidth: 24, opacity: 1 },
      name: 'Project location',
      meta: { location: { ...DEFAULT_LOCATION } },
      parentId: null,
      select: true,
    });
    // Existing origins without a site pick the new location up.
    for (const element of Object.values(ctx.doc.elements)) {
      const analysis = element.meta?.['analysis'] as Record<string, JsonValue> | undefined;
      if (analysis && !analysis['locationId']) analysis['locationId'] = id;
    }
    return id;
  },
});

export const createNoiseEmitter = defineMutation({
  id: 'create-noise-emitter',
  label: 'Add noise emitter',
  description: 'Adds a noise source to a noise analysis origin (level at 1 m in dB(A), height above its level).',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ originId: IdSchema, x: z.number().finite(), y: z.number().finite(), level: z.number().finite().default(80), height: z.number().finite().default(1000) }),
  run: (ctx, input) => {
    const origin = ctx.doc.elements[input.originId];
    if (analysisOf(origin as never)?.kind !== 'noise') throw new CommandError('rejected', 'Pick a noise analysis origin first');
    const size = 900;
    const count = Object.values(ctx.doc.elements).filter((e) => noiseEmitterOf(e as never)?.originId === input.originId).length;
    return createRect.run(ctx, {
      x: input.x - size / 2,
      y: input.y - size / 2,
      width: size,
      height: size,
      radius: size / 2,
      rotation: 0,
      style: { fill: '#fecaca', stroke: '#dc2626', strokeWidth: 30, opacity: 1 },
      name: `Emitter ${count + 1}`,
      meta: { noiseEmitter: { originId: input.originId, level: input.level, height: input.height } },
      parentId: null,
      select: false,
    });
  },
});

export const updateAnalysis = defineMutation({
  id: 'update-analysis',
  label: 'Update analysis settings',
  description: 'Merges settings into an analysis origin, the project location or a noise emitter.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, patch: z.record(z.string(), JsonValueSchema) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const key = metaKeyOf(element?.meta as Record<string, unknown> | undefined);
    if (!element || !key) throw new CommandError('rejected', 'Not an analysis element');
    const current = element.meta![key] as Record<string, JsonValue>;
    const { active: _ignored, activeViews: _running, views: _views, ...patch } = input.patch;
    const before = key === 'location' ? locationOf(element as never) : null;
    element.meta![key] = { ...current, ...patch };
    // Re-centring the imagery (the map editor's pan, recenter-map) slides everything placed on it
    // (generated context and the site concept) along, so it stays on the same ground.
    if (before && ('mapCenter' in patch || 'anchor' in patch || 'lat' in patch || 'lon' in patch)) {
      const after = locationOf(element as never);
      const riders = [siteContextRoot(ctx.doc as never, element.id), conceptRoot(ctx.doc as never, element.id)].filter((e) => e !== null);
      if (riders.length && after) {
        const place = before.mapCenter ?? { lat: before.lat, lon: before.lon };
        const from = geoToLocal(locationFrame(element as never, before), place);
        const to = geoToLocal(locationFrame(element as never, after), place);
        const m = worldMatrix(ctx.doc.elements as ElementTable, element as never);
        const dx = to.x - from.x, dy = to.y - from.y;
        for (const rider of riders) {
          const target = ctx.doc.elements[rider.id]!;
          target.x += m[0] * dx + m[2] * dy;
          target.y += m[1] * dx + m[3] * dy;
        }
      }
    }
  },
});

export const recenterMap = defineMutation({
  id: 'recenter-map',
  label: 'Recenter map on pin',
  description: 'Moves the map frame to the project pin while keeping the geographic plane and site geometry fixed on the board.',
  aliases: ['refresh map', 'recenter', 'find pin'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const location = locationOf(element as never);
    if (!element || element.kind !== 'rect' || !location) throw new CommandError('rejected', 'Not the project location');
    const pin = geoToLocal(locationFrame(element as never, location), location);
    const m = worldMatrix(ctx.doc.elements as ElementTable, element as never);
    const dx = pin.x - element.width / 2, dy = pin.y - element.height / 2;
    moveSelection.run(ctx, { ids: [element.id], dx: m[0] * dx + m[2] * dy, dy: m[1] * dx + m[3] * dy });
  },
});

// ---- site context (OpenStreetMap buildings and roads) ---------------------------------------------

const ContextFeatureInput = z.object({
  kind: z.enum(['building', 'road']),
  osmId: z.number(),
  name: z.string().max(200).optional(),
  type: z.string().max(100),
  points: z.array(z.object({ lat: z.number().finite(), lon: z.number().finite() })).min(2),
  size: z.number().positive(),
});

const BUILDING_STYLE = { fill: '#d6d3d1', stroke: '#57534e', strokeWidth: 120, opacity: 1 };
const ROAD_STYLE = { fill: null, stroke: '#a8a29e', strokeWidth: 6000, opacity: 0.85 };
const ROAD_HEIGHT = 100;

export const insertSiteContext = defineMutation({
  id: 'insert-site-context',
  label: 'Insert site context',
  description: 'Places buildings (extruded footprints) and roads (solid strips) at 1:1 under the project map, replacing context generated earlier. Each one is its own editable element.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, radius: z.number().positive(), features: z.array(ContextFeatureInput) }),
  run: (ctx, input) => {
    const map = ctx.doc.elements[input.id];
    const meta = locationOf(map as never) as LocationMeta | null;
    if (!map || !meta) throw new CommandError('rejected', 'Not the project location');
    const old = siteContextRoot(ctx.doc as never, map.id);
    if (old) removeSubtree(ctx.doc, old.id);
    const elements = ctx.doc.elements as ElementTable;
    const frame = locationFrame(map as never, meta);
    const matrix = worldMatrix(elements, map as never);
    const toWorld = (p: { lat: number; lon: number }) => applyToPoint(matrix, geoToLocal(frame, p));
    const group = (name: string, parentId: string | null, role: string, extra: Record<string, JsonValue> = {}) => {
      const element: GroupElement = {
        id: ctx.ids.next('el'), kind: 'group', parentId, index: topIndex(elements, parentId), x: 0, y: 0, rotation: 0, visible: true, locked: false, name,
        meta: { ...extra, siteContext: { mapId: map.id, role } },
      };
      ctx.doc.elements[element.id] = element;
      return element.id;
    };
    const root = group(`Site context · ${input.radius < 1000 ? `${input.radius} m` : `${input.radius / 1000} km`}`, null, 'root', { host: map.id, osm: { radius: input.radius, source: 'OpenStreetMap contributors (ODbL)' } });
    const roads = group('Roads', root, 'roads');
    const buildings = group('Buildings', root, 'buildings');
    const index: Record<string, string | null> = { [roads]: null, [buildings]: null };
    const counts = { buildings: 0, roads: 0 };
    for (const feature of input.features) {
      const building = feature.kind === 'building';
      const parentId = building ? buildings : roads;
      const points = feature.points.map(toWorld);
      const minX = Math.min(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y));
      index[parentId] = indexAfter(index[parentId] ?? null);
      counts[building ? 'buildings' : 'roads'] += 1;
      const style = building ? BUILDING_STYLE : { ...ROAD_STYLE, strokeWidth: feature.size };
      const line: LineElement = {
        id: ctx.ids.next('el'),
        kind: 'line',
        parentId,
        index: index[parentId]!,
        x: minX,
        y: minY,
        rotation: 0,
        visible: true,
        locked: false,
        name: feature.name ?? (building ? `Building ${counts.buildings}` : `${feature.type.replace(/_/g, ' ')} ${counts.roads}`),
        points: points.map((p) => [p.x - minX, p.y - minY] as [number, number]),
        closed: building,
        style,
        meta: {
          solid: { height: building ? Math.round(feature.size) : ROAD_HEIGHT, elevation: 0 },
          siteContext: { mapId: map.id, role: feature.kind, osmId: feature.osmId },
          osm: { id: feature.osmId, type: feature.type },
          // Keep their own colours in the (default) Hidden line style too; still editable per element.
          graphics: { hiddenLine: { ...style } },
        },
      };
      ctx.doc.elements[line.id] = line;
    }
    setSelection(ctx, [root]);
    return { root, ...counts };
  },
});

export const generateSiteContext = defineEffect({
  id: 'generate-site-context',
  label: 'Generate roads & buildings',
  description: 'Loads buildings (with heights) and roads from OpenStreetMap within a radius (metres) of what the map shows (the site boundary centre, else the centre of the map rect) and places them under the map as editable solids, replacing earlier generated context.',
  aliases: ['site context', 'context model', 'osm buildings', 'surroundings'],
  group: 'create',
  palette: false,
  input: z.object({ id: IdSchema, radius: z.number().min(25).max(1500).default(250) }),
  run: async (ctx, input) => {
    const element = ctx.getState().doc.elements[input.id];
    const location = locationOf(element);
    if (!element || !location) throw new CommandError('rejected', 'Not the project location');
    const centre = siteContextCentre(element, location);
    const features = await fetchSiteContext(centre.lat, centre.lon, input.radius).catch(failed);
    if (!features.length) throw new CommandError('failed', `OpenStreetMap has no buildings or roads within ${input.radius} m of the map centre`);
    const result = await ctx.dispatch('insert-site-context', { id: input.id, radius: input.radius, features });
    if (!result.ok) throw new CommandError('failed', result.error.message);
    return result.value;
  },
});


/** Claim only overlapping views; unrelated runs and saved view links are preserved. */
function claimViews(ctx: MutationContext, id: string, views: string[]) {
  for (const element of Object.values(ctx.doc.elements)) {
    const meta = analysisOf(element as never);
    if (!meta) continue;
    const value = element.meta!['analysis'] as Record<string, JsonValue>;
    if (element.id === id) { value['activeViews'] = views; value['active'] = views.length > 0; }
    else if (meta.active) {
      const remaining = (meta.activeViews ?? meta.views).filter((view) => !views.includes(view));
      value['activeViews'] = remaining; value['active'] = remaining.length > 0;
    }
  }
}

export const moveNoiseEmitters = defineMutation({
  id: 'move-noise-emitters', label: 'Move noise emitters in 3D', group: 'edit', palette: false, history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), dx: z.number().finite(), dy: z.number().finite(), dz: z.number().finite() }),
  run: (ctx, input) => {
    for (const id of input.ids) if (!noiseEmitterOf(ctx.doc.elements[id] as never) || ctx.doc.elements[id]!.locked) throw new CommandError('rejected', 'Select unlocked noise emitters');
    moveSelection.run(ctx, { ids: input.ids, dx: input.dx, dy: input.dy });
    for (const id of input.ids) {
      const emitter = ctx.doc.elements[id]!.meta!['noiseEmitter'] as Record<string, JsonValue>;
      emitter['height'] = Math.max(0, Number(emitter['height'] ?? 1000) + input.dz);
    }
  },
});

export const runAnalysis = defineMutation({
  id: 'run-analysis',
  label: 'Run analysis',
  description: 'Runs this origin in its linked views, replacing only analyses in those views.',
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    if (!analysisOf(ctx.doc.elements[input.id] as never)) throw new CommandError('rejected', 'Not an analysis origin');
    const origin = ctx.doc.elements[input.id]!;
    const meta = analysisOf(origin as never)!;
    const views = meta.views.filter((id) => ctx.doc.elements[id]?.meta?.['view3d']);
    if (!views.length) throw new CommandError('rejected', 'Choose at least one 3D view first');
    claimViews(ctx, input.id, views);
  },
});

export const stopAnalysis = defineMutation({
  id: 'stop-analysis',
  label: 'Stop analysis',
  description: 'Stops the running analysis; linked 3D views go back to their normal display.',
  group: 'view',
  history: 'record',
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  run: (ctx, input) => {
    for (const element of Object.values(ctx.doc.elements)) {
      const analysis = element.meta?.['analysis'] as Record<string, JsonValue> | undefined;
      if (analysis && (!input.id || element.id === input.id)) { analysis['active'] = false; analysis['activeViews'] = []; }
    }
  },
});

export const linkAnalysisView = defineMutation({
  id: 'link-analysis-view',
  label: 'Link 3D view to analysis',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, viewId: IdSchema, linked: z.boolean() }),
  run: (ctx, input) => {
    const analysis = ctx.doc.elements[input.id]?.meta?.['analysis'] as Record<string, JsonValue> | undefined;
    if (!analysis) throw new CommandError('rejected', 'Not an analysis origin');
    if (!ctx.doc.elements[input.viewId]?.meta?.['view3d']) throw new CommandError('rejected', 'Not a 3D view');
    const views = new Set(Array.isArray(analysis['views']) ? (analysis['views'] as string[]) : []);
    if (input.linked) views.add(input.viewId);
    else views.delete(input.viewId);
    analysis['views'] = [...views];
    if (analysis['active']) {
      const running = new Set((analysis['activeViews'] ?? [...views]) as string[]);
      if (input.linked) running.add(input.viewId); else running.delete(input.viewId);
      claimViews(ctx, input.id, [...running]);
    }
  },
});

function toolFor(id: string, label: string, tool: 'analysis-sun' | 'analysis-wind' | 'analysis-noise' | 'analysis-location', aliases: string[]) {
  return defineMutation({
    id,
    label,
    aliases,
    group: 'select',
    history: 'none',
    input: z.void(),
    run: (ctx) => {
      ctx.ui.tool = tool;
      ctx.ui.placingAsset = null;
      ctx.ui.editingTextId = null;
    },
  });
}

export const toolAnalysisSun = toolFor('tool-analysis-sun', 'Sun analysis tool', 'analysis-sun', ['sun', 'shadow']);
export const toolAnalysisWind = toolFor('tool-analysis-wind', 'Wind analysis tool', 'analysis-wind', ['wind', 'airflow']);
export const toolAnalysisNoise = toolFor('tool-analysis-noise', 'Noise analysis tool', 'analysis-noise', ['noise', 'acoustic']);
export const toolAnalysisLocation = toolFor('tool-analysis-location', 'Location tool', 'analysis-location', ['map', 'site', 'location']);

export const toolNoiseEmitter = defineMutation({
  id: 'tool-noise-emitter',
  label: 'Place noise emitters',
  group: 'select',
  palette: false,
  history: 'none',
  input: z.object({ originId: IdSchema }),
  run: (ctx, input) => {
    ctx.ui.tool = 'noise-emitter';
    ctx.ui.analysisTargetId = input.originId;
    ctx.ui.placingAsset = null;
    ctx.ui.editingTextId = null;
  },
});

// ---- open data ----------------------------------------------------------------------------------

function failed(error: unknown): never {
  throw new CommandError('failed', error instanceof Error ? error.message : String(error));
}

export const searchLocation = defineEffect({
  id: 'search-location',
  label: 'Find project location',
  description: 'Looks an address or place up on OpenStreetMap (Nominatim) and moves the project location there.',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema, query: z.string().min(2) }),
  run: async (ctx, input) => {
    if (!locationOf(ctx.getState().doc.elements[input.id])) throw new CommandError('rejected', 'Not the project location');
    const place = await searchPlace(input.query).catch(failed);
    const details = await siteDetails(place.lat, place.lon).catch(() => null);
    const result = await ctx.dispatch('update-analysis', { id: input.id, patch: { ...place, mapCenter: { lat: place.lat, lon: place.lon }, ...(details ?? {}) } });
    if (!result.ok) throw new CommandError('failed', result.error.message);
    return place;
  },
});

export const locateProject = defineEffect({
  id: 'locate-project',
  label: 'Use my location',
  description: "Moves the project location (pin and map) to the device's current position, then updates its address, elevation and time zone.",
  aliases: ['my location', 'current location', 'gps'],
  group: 'edit',
  palette: false,
  input: z.object({
    id: IdSchema,
    /** Skip when the location was already moved away from the default (e.g. a search finished first). */
    onlyIfDefault: z.boolean().default(false),
  }),
  run: async (ctx, input) => {
    if (!locationOf(ctx.getState().doc.elements[input.id])) throw new CommandError('rejected', 'Not the project location');
    const position = await userPosition().catch(failed);
    const current = locationOf(ctx.getState().doc.elements[input.id]);
    if (!current) throw new CommandError('rejected', 'The project location was removed');
    if (input.onlyIfDefault && (current.lat !== DEFAULT_LOCATION.lat || current.lon !== DEFAULT_LOCATION.lon)) return null;
    const [address, details] = await Promise.all([reverseGeocode(position.lat, position.lon).catch(() => ''), siteDetails(position.lat, position.lon).catch(() => null)]);
    const result = await ctx.dispatch('update-analysis', { id: input.id, patch: { lat: position.lat, lon: position.lon, mapCenter: { ...position }, address, ...(details ?? {}) } });
    if (!result.ok) throw new CommandError('failed', result.error.message);
    return position;
  },
});

export const refreshLocationDetails = defineEffect({
  id: 'refresh-location-details',
  label: 'Update location details',
  description: 'Fetches elevation, time zone and UTC offset for the project location from Open-Meteo.',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema }),
  run: async (ctx, input) => {
    const location = locationOf(ctx.getState().doc.elements[input.id]);
    if (!location) throw new CommandError('rejected', 'Not the project location');
    const details = await siteDetails(location.lat, location.lon).catch(failed);
    await ctx.dispatch('update-analysis', { id: input.id, patch: { ...details } });
    return details;
  },
});

export const fetchWindData = defineEffect({
  id: 'fetch-wind-data',
  label: 'Fetch wind data',
  description: 'Loads the last 12 months of wind for the origin site (Open-Meteo ERA5) and uses the prevailing wind.',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema }),
  run: async (ctx, input) => {
    const doc = ctx.getState().doc;
    const meta = analysisOf(doc.elements[input.id]);
    if (meta?.kind !== 'wind') throw new CommandError('rejected', 'Not a wind analysis origin');
    const site = siteOf(doc, meta);
    const data = await windHistory(site.lat, site.lon).catch(failed);
    await ctx.dispatch('update-analysis', { id: input.id, patch: { windData: data as unknown as JsonValue, direction: data.prevailing, speed: Math.round(data.meanSpeed * 10) / 10 } });
    return data;
  },
});

export const fetchSunshine = defineEffect({
  id: 'fetch-sunshine',
  label: 'Fetch sunshine data',
  description: 'Loads the typical daily sunshine hours for the chosen month at the origin site (Open-Meteo ERA5).',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema }),
  run: async (ctx, input) => {
    const doc = ctx.getState().doc;
    const meta = analysisOf(doc.elements[input.id]);
    if (meta?.kind !== 'sun') throw new CommandError('rejected', 'Not a sun analysis origin');
    const site = siteOf(doc, meta);
    const hours = await sunshineForMonth(site.lat, site.lon, meta.date).catch(failed);
    await ctx.dispatch('update-analysis', { id: input.id, patch: { sunshineHours: Math.round(hours * 10) / 10 } });
    return hours;
  },
});

// ---- site concept (massing forms) --------------------------------------------------------------

const PlanInput = z.array(z.tuple([z.number().finite(), z.number().finite()]));

const SOLID_STYLE = { fill: '#f4f1ea', stroke: '#44403c', strokeWidth: 80, opacity: 1 };
const VOID_STYLE = { fill: null, stroke: '#dc2626', strokeWidth: 80, opacity: 1 };

/** The map's site concept group, created (hosted by the map) when missing. */
function ensureConceptRoot(ctx: MutationContext, mapId: string): Element {
  const existing = conceptRoot(ctx.doc as never, mapId);
  if (existing) return existing as Element;
  const group: GroupElement = {
    id: ctx.ids.next('el'), kind: 'group', parentId: null, index: topIndex(ctx.doc.elements as ElementTable, null), x: 0, y: 0, rotation: 0, visible: true, locked: false,
    name: 'Site concept', meta: { host: mapId, siteConcept: { mapId } },
  };
  ctx.doc.elements[group.id] = group;
  return group;
}

export const upsertMassingForm = defineMutation({
  id: 'upsert-massing-form',
  label: 'Add or update a concept form',
  description: 'Creates or updates a site concept form: a solid or void extruded from `start` to `end` (mm) with a plan profile (world mm). `source`/`base`/`inset` record how the profile was made (site boundary or a drawn outline, shrunk by the inset setback).',
  aliases: ['massing', 'concept', 'extrusion', 'void'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    mapId: IdSchema,
    id: IdSchema.optional(),
    kind: z.enum(['solid', 'void']),
    name: z.string().max(200).optional(),
    source: z.enum(['boundary', 'drawn']),
    base: PlanInput.optional(),
    inset: z.number().finite().default(0),
    start: z.number().finite(),
    end: z.number().finite(),
    profile: PlanInput.min(3),
    visible: z.boolean().optional(),
  }),
  run: (ctx, input) => {
    if (!locationOf(ctx.doc.elements[input.mapId] as never)) throw new CommandError('rejected', 'Not the project location');
    if (input.end <= input.start) throw new CommandError('invalid-input', 'The end elevation must be above the start');
    const root = ensureConceptRoot(ctx, input.mapId);
    // Forms live in the concept group's frame, which moves with the map.
    const origin = applyToPoint(worldMatrix(ctx.doc.elements as ElementTable, root), { x: 0, y: 0 });
    const local = (plan: [number, number][]) => plan.map(([x, y]) => [x - origin.x, y - origin.y] as [number, number]);
    const profile = local(input.profile);
    const minX = Math.min(...profile.map((p) => p[0]));
    const minY = Math.min(...profile.map((p) => p[1]));
    const existing = input.id ? ctx.doc.elements[input.id] : undefined;
    if (input.id && (!existing || !massingOf(existing as never))) throw new CommandError('rejected', 'Not a concept form');
    const count = Object.values(ctx.doc.elements).filter((e) => massingOf(e as never)?.kind === input.kind && massingOf(e as never)?.mapId === input.mapId).length;
    const style = input.kind === 'solid' ? SOLID_STYLE : VOID_STYLE;
    const massing = { mapId: input.mapId, kind: input.kind, source: input.source, inset: input.inset, start: input.start, end: input.end, ...(input.base ? { base: local(input.base) } : {}) };
    const line: LineElement = {
      id: existing?.id ?? ctx.ids.next('el'),
      kind: 'line',
      parentId: root.id,
      index: existing?.index ?? topIndex(ctx.doc.elements as ElementTable, root.id),
      x: minX,
      y: minY,
      rotation: 0,
      visible: input.visible ?? existing?.visible ?? true,
      locked: false,
      name: input.name ?? existing?.name ?? `${input.kind === 'solid' ? 'Solid' : 'Void'} ${count + 1}`,
      points: profile.map(([x, y]) => [x - minX, y - minY] as [number, number]),
      closed: true,
      style,
      meta: { massing: massing as unknown as JsonValue, solid: { elevation: input.start, height: input.end - input.start }, graphics: { hiddenLine: { ...style } } },
    };
    ctx.doc.elements[line.id] = line;
    return line.id;
  },
});

/** A form's drawn outline in world millimetres (it is stored in the concept group's frame). */
export function formBaseWorld(elements: ElementTable, formId: string): [number, number][] | null {
  const element = elements[formId];
  const meta = massingOf(element);
  if (!element || !meta?.base || !element.parentId || !elements[element.parentId]) return null;
  const origin = applyToPoint(worldMatrix(elements, elements[element.parentId]!), { x: 0, y: 0 });
  return meta.base.map(([x, y]) => [x + origin.x, y + origin.y]);
}

export const analysisCommands = [
  createAnalysisOrigin,
  createLocation,
  createNoiseEmitter,
  updateAnalysis,
  runAnalysis,
  moveNoiseEmitters,
  stopAnalysis,
  linkAnalysisView,
  toolAnalysisSun,
  toolAnalysisWind,
  toolAnalysisNoise,
  toolAnalysisLocation,
  toolNoiseEmitter,
  searchLocation,
  locateProject,
  refreshLocationDetails,
  fetchWindData,
  fetchSunshine,
  insertSiteContext,
  generateSiteContext,
  recenterMap,
  upsertMassingForm,
];

/**
 * Where to gather context: the middle of the drawn site, else the middle of the map as shown.
 * Not the pin: panning the map (or a default pin) can leave it far from what is on screen.
 */
export function siteContextCentre(element: Element, location: LocationMeta): { lat: number; lon: number } {
  const boundary = location.boundary ?? [];
  if (boundary.length >= 3) return { lat: boundary.reduce((s, p) => s + p.lat, 0) / boundary.length, lon: boundary.reduce((s, p) => s + p.lon, 0) / boundary.length };
  const width = 'width' in element ? element.width : 0;
  const height = 'height' in element ? element.height : 0;
  return localToGeo(locationFrame(element, location), width / 2, height / 2);
}
