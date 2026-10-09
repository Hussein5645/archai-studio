/**
 * Built-in materials. Two kinds:
 * - **defaults** (`default:*`): what a slot shows until a material is assigned. They take the
 *   colour a document set in the Graphics dialog before materials existed, so older files look the
 *   same; editing one stores a copy under the same id in the document's library, which then wins.
 * - **presets**: the starter library. Using one copies it into the document under a new id, so
 *   files stay self-contained.
 */
import type { GraphicsOverrides } from '@/graphics';
import { graphicsResolver } from '@/graphics';
import { MaterialSchema, type Material, type MaterialInput } from '@/document';

const make = (input: MaterialInput): Material => MaterialSchema.parse(input);

interface DefaultSpec {
  name: string;
  category: Material['category'];
  /** Graphics type / parameter the colour used to come from. */
  graphic: [string, string];
  color: string;
  extra?: Partial<MaterialInput>;
}

const DEFAULT_SPECS: Record<string, DefaultSpec> = {
  'default:wall-core': { name: 'Wall core', category: 'masonry', graphic: ['wall', 'material.core'], color: '#8d8f96', extra: { roughness: 0.9 } },
  'default:wall-finish': { name: 'Wall finish', category: 'finish', graphic: ['wall', 'material.finish'], color: '#e6e7ea', extra: { roughness: 0.95 } },
  'default:door-leaf': { name: 'Door leaf', category: 'wood', graphic: ['door', 'material.leaf'], color: '#b98a5a', extra: { roughness: 0.55, rotation: 90, map: { pattern: { kind: 'planks', unitWidth: 2400, unitHeight: 900, joint: 0, jointColor: '#6b4d33', layout: 'random', variation: 0.12, accent: '#9c7148', relief: 0.05, seed: 21 } } } },
  'default:door-frame': { name: 'Door frame', category: 'metal', graphic: ['door', 'material.frame'], color: '#4b4d54', extra: { roughness: 0.45, metalness: 0.6 } },
  'default:window-frame': { name: 'Window frame', category: 'metal', graphic: ['window', 'material.frame'], color: '#4b4d54', extra: { roughness: 0.45, metalness: 0.6 } },
  'default:glass': { name: 'Glass', category: 'glass', graphic: ['window', 'material.glass'], color: '#9cc5e8', extra: { roughness: 0.05, opacity: 0.45, transmission: 0.85, ior: 1.5 } },
  'default:concrete': { name: 'Concrete', category: 'concrete', graphic: ['column', 'material.concrete'], color: '#b9bcc4', extra: { roughness: 0.88, map: { pattern: { kind: 'stone', unitWidth: 1200, unitHeight: 600, joint: 0, jointColor: '#8f8f8a', layout: 'random', variation: 0.3, accent: '#9a9a96', relief: 0.12, seed: 3 } } } },
  'default:steel': { name: 'Steel', category: 'metal', graphic: ['column', 'material.steel'], color: '#8b95a5', extra: { roughness: 0.35, metalness: 0.9 } },
  'default:timber': { name: 'Timber', category: 'wood', graphic: ['column', 'material.timber'], color: '#d2b48c', extra: { roughness: 0.7, rotation: 90, map: { pattern: { kind: 'planks', unitWidth: 3000, unitHeight: 200, joint: 0, jointColor: '#8a6a45', layout: 'random', variation: 0.2, accent: '#b8956a', relief: 0.08, seed: 17 } } } },
  'default:stair-tread': { name: 'Stair tread', category: 'finish', graphic: ['stair', 'material.tread'], color: '#d9dbe0', extra: { roughness: 0.85 } },
  'default:stair-riser': { name: 'Stair riser', category: 'finish', graphic: ['stair', 'material.riser'], color: '#c4c7ce', extra: { roughness: 0.85 } },
  'default:stair-landing': { name: 'Stair landing', category: 'finish', graphic: ['stair', 'material.landing'], color: '#cfd2d8', extra: { roughness: 0.85 } },
  'default:stair-stringer': { name: 'Stair stringer', category: 'metal', graphic: ['stair', 'material.stringer'], color: '#8d8f96', extra: { roughness: 0.85 } },
  'default:rail': { name: 'Rail and posts', category: 'metal', graphic: ['railing', 'material.rail'], color: '#5a5c63', extra: { roughness: 0.4, metalness: 0.8 } },
  'default:rail-panel': { name: 'Railing glass', category: 'glass', graphic: ['railing', 'material.panel'], color: '#9cc5e8', extra: { roughness: 0.05, opacity: 0.45, transmission: 0.85, ior: 1.5 } },
  'default:curtain-glass': { name: 'Curtain wall glass', category: 'glass', graphic: ['curtain-wall', 'material'], color: '#9cc5e8', extra: { roughness: 0.08, opacity: 0.6, transmission: 0.8, ior: 1.5 } },
  'default:facade': { name: 'Facade panel', category: 'other', graphic: ['facade-element', 'material'], color: '#c9ccd3', extra: { roughness: 0.85 } },
  'default:room-floor': { name: 'Room floor', category: 'finish', graphic: ['room', 'material.floor'], color: '#eef3fb', extra: { roughness: 1 } },
  'default:floor': { name: 'Floor slab', category: 'concrete', graphic: ['floor', 'material'], color: '#bfc3ca', extra: { roughness: 0.88, map: { pattern: { kind: 'stone', unitWidth: 1200, unitHeight: 600, joint: 0, jointColor: '#8f8f8a', layout: 'random', variation: 0.3, accent: '#9a9a96', relief: 0.12, seed: 3 } } } },
  'default:ceiling': { name: 'Ceiling', category: 'finish', graphic: ['ceiling', 'material'], color: '#dedfe3', extra: { roughness: 0.95 } },
  'default:generic': { name: 'Extrusion', category: 'other', graphic: ['rect', 'material'], color: '#c9ccd3', extra: { roughness: 0.85 } },
  'default:line': { name: 'Line solid', category: 'other', graphic: ['line', 'material'], color: '#c9ccd3', extra: { roughness: 0.85 } },
  'default:flat': { name: 'Flat surface', category: 'other', graphic: ['rect', 'material.flat'], color: '#9a9ca3', extra: { roughness: 1 } },
  'default:asset': { name: 'Asset box', category: 'other', graphic: ['asset', 'material.fallback'], color: '#c9ccd3', extra: { roughness: 0.85 } },
};

export const DEFAULT_MATERIAL_IDS = Object.keys(DEFAULT_SPECS);

export function isDefaultMaterialId(id: string): boolean {
  return id in DEFAULT_SPECS;
}

const defaultsCache = new WeakMap<object, Map<string, Material>>();
const NO_GRAPHICS: GraphicsOverrides = {};

/** A default material as the document's Graphics colours make it (before any library override). */
export function builtinDefault(id: string, graphics: GraphicsOverrides | undefined): Material | null {
  const spec = DEFAULT_SPECS[id];
  if (!spec) return null;
  const key = graphics ?? NO_GRAPHICS;
  let cache = defaultsCache.get(key);
  if (!cache) defaultsCache.set(key, (cache = new Map()));
  const cached = cache.get(id);
  if (cached) return cached;
  const g = graphicsResolver(key);
  const raw = g.color(spec.graphic[0], '3d', '*', spec.graphic[1]) ?? spec.color;
  const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : spec.color;
  const opacity = id === 'default:glass' ? g.number('window', '3d', '*', 'material.glassOpacity') || 0.45 : undefined;
  const material = make({ id, name: spec.name, category: spec.category, color, ...spec.extra, ...(opacity !== undefined ? { opacity } : {}) });
  cache.set(id, material);
  return material;
}

const brick = (color: string, joint: string, layout: 'stretcher' | 'stack' | 'herringbone' | 'flemish' = 'stretcher') => ({ kind: 'brick' as const, unitWidth: 215, unitHeight: 65, joint: 10, jointColor: joint, layout, variation: 0.3, accent: color, relief: 0.7, seed: 7 });

export const MATERIAL_PRESETS: readonly MaterialInput[] = [
  { id: 'preset:brick-red', name: 'Red brick', category: 'masonry', color: '#a4513a', roughness: 0.9, map: { pattern: brick('#a4513a', '#cfc7ba') } },
  { id: 'preset:brick-white', name: 'White brick', category: 'masonry', color: '#e9e5dc', roughness: 0.9, map: { pattern: brick('#e9e5dc', '#b9b3a8') } },
  { id: 'preset:brick-stack', name: 'Stack bond brick', category: 'masonry', color: '#6f6a64', roughness: 0.85, map: { pattern: { ...brick('#6f6a64', '#3d3a37', 'stack'), unitWidth: 290, unitHeight: 50 } } },
  { id: 'preset:brick-herringbone', name: 'Herringbone brick', category: 'masonry', color: '#9a5a40', roughness: 0.9, map: { pattern: { ...brick('#9a5a40', '#d6cec2', 'herringbone'), unitWidth: 200, unitHeight: 100 } } },
  { id: 'preset:concrete', name: 'Concrete', category: 'concrete', color: '#a9a9a4', roughness: 0.9, map: { pattern: { kind: 'stone', unitWidth: 1200, unitHeight: 600, joint: 0, jointColor: '#8f8f8a', layout: 'random', variation: 0.35, accent: '#8f8f8a', relief: 0.15, seed: 3 } } },
  { id: 'preset:board-concrete', name: 'Board-formed concrete', category: 'concrete', color: '#a6a5a0', roughness: 0.9, map: { pattern: { kind: 'planks', unitWidth: 2400, unitHeight: 150, joint: 4, jointColor: '#8a8984', layout: 'offset', variation: 0.15, accent: '#9b9a95', relief: 0.4, seed: 11 } } },
  { id: 'preset:plaster', name: 'White plaster', category: 'finish', color: '#f1efea', roughness: 0.95 },
  { id: 'preset:paint-grey', name: 'Warm grey paint', category: 'finish', color: '#b8b2a8', roughness: 0.75 },
  { id: 'preset:oak', name: 'Oak planks', category: 'wood', color: '#c49a6c', roughness: 0.6, map: { pattern: { kind: 'planks', unitWidth: 1800, unitHeight: 180, joint: 2, jointColor: '#6b4d33', layout: 'random', variation: 0.35, accent: '#a57a4f', relief: 0.5, seed: 5 } } },
  { id: 'preset:walnut', name: 'Walnut', category: 'wood', color: '#5e3f2b', roughness: 0.55, map: { pattern: { kind: 'planks', unitWidth: 2000, unitHeight: 200, joint: 1, jointColor: '#2f1f15', layout: 'random', variation: 0.3, accent: '#4a3021', relief: 0.3, seed: 9 } } },
  { id: 'preset:timber-cladding', name: 'Timber cladding', category: 'wood', color: '#b58a5c', roughness: 0.7, rotation: 90, map: { pattern: { kind: 'stripes', unitWidth: 120, unitHeight: 1000, joint: 12, jointColor: '#3b2a1c', layout: 'grid', variation: 0.3, accent: '#9f7448', relief: 0.8, seed: 2 } } },
  { id: 'preset:tiles-white', name: 'White tiles 200', category: 'tile', color: '#f4f4f1', roughness: 0.25, map: { pattern: { kind: 'tiles', unitWidth: 200, unitHeight: 200, joint: 3, jointColor: '#d4d2cc', layout: 'grid', variation: 0.04, accent: '#ffffff', relief: 0.5, seed: 1 } } },
  { id: 'preset:tiles-metro', name: 'Metro tiles', category: 'tile', color: '#eef1f0', roughness: 0.2, map: { pattern: { kind: 'tiles', unitWidth: 150, unitHeight: 75, joint: 3, jointColor: '#a9aca8', layout: 'offset', variation: 0.06, accent: '#ffffff', relief: 0.6, seed: 4 } } },
  { id: 'preset:tiles-hex', name: 'Hexagon tiles', category: 'tile', color: '#2f3b45', roughness: 0.3, map: { pattern: { kind: 'tiles', unitWidth: 200, unitHeight: 200, joint: 4, jointColor: '#d9d6cf', layout: 'hexagon', variation: 0.1, accent: '#3c4a55', relief: 0.5, seed: 6 } } },
  { id: 'preset:terrazzo', name: 'Terrazzo', category: 'stone', color: '#e7e2d8', roughness: 0.35, map: { pattern: { kind: 'stone', unitWidth: 30, unitHeight: 30, joint: 0, jointColor: '#e7e2d8', layout: 'random', variation: 0.8, accent: '#7d756a', relief: 0.05, seed: 8 } } },
  { id: 'preset:flagstone', name: 'Flagstone', category: 'stone', color: '#8f887c', roughness: 0.85, map: { pattern: { kind: 'stone', unitWidth: 600, unitHeight: 600, joint: 15, jointColor: '#5c574f', layout: 'random', variation: 0.35, accent: '#a39b8d', relief: 0.8, seed: 12 } } },
  { id: 'preset:marble', name: 'White marble', category: 'stone', color: '#eeece8', roughness: 0.15, clearcoat: 0.4 },
  { id: 'preset:steel', name: 'Brushed steel', category: 'metal', color: '#b9bcc2', roughness: 0.4, metalness: 1 },
  { id: 'preset:black-steel', name: 'Black steel', category: 'metal', color: '#2a2b2e', roughness: 0.45, metalness: 0.8 },
  { id: 'preset:brass', name: 'Brass', category: 'metal', color: '#c9a648', roughness: 0.3, metalness: 1 },
  { id: 'preset:corten', name: 'Corten', category: 'metal', color: '#8a4b2a', roughness: 0.9, metalness: 0.3, map: { pattern: { kind: 'stone', unitWidth: 400, unitHeight: 400, joint: 0, jointColor: '#6e3a20', layout: 'random', variation: 0.45, accent: '#6e3a20', relief: 0.1, seed: 13 } } },
  { id: 'preset:glass-clear', name: 'Clear glass', category: 'glass', color: '#dbe9f0', roughness: 0.05, opacity: 0.25, transmission: 0.9, ior: 1.5 },
  { id: 'preset:glass-frosted', name: 'Frosted glass', category: 'glass', color: '#e8eef2', roughness: 0.6, opacity: 0.6, transmission: 0.6 },
  { id: 'preset:fabric', name: 'Grey fabric', category: 'fabric', color: '#7c7f86', roughness: 1 },
  { id: 'preset:led', name: 'LED light', category: 'other', color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 3, roughness: 0.5 },
];

export const PRESETS: readonly Material[] = MATERIAL_PRESETS.map(make);

export function presetById(id: string): Material | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}
