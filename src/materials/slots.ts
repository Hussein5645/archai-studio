/**
 * What an element exposes to materials: named **slots** (parts that take one material each) and
 * named **surfaces** (faces that can be painted, optionally in zones), and how a face resolves
 * to a material id:
 *
 *   surface paint (last matching zone wins) → `meta.materials[slot]` → type (`parameters.materials`
 *   or the wall layer's `material`) → the slot's built-in default.
 */
import { archOf, archTypeOf } from '@/assets/arch-meta';
import { parseSystemParameters } from '@/catalog';
import { SurfacePaintSchema, type ArchaiDocument, type Element, type JsonValue, type Material, type SurfacePaint } from '@/document';
import { builtinDefault, isDefaultMaterialId } from './builtin';
import type { GraphicsOverrides } from '@/graphics';

export interface SlotInfo {
  key: string;
  label: string;
  /** The built-in default material of the slot. */
  fallback: string;
}

export type SurfaceKey = 'sideA' | 'sideB' | 'top' | 'bottom' | 'ends' | 'reveals' | 'sides';

export const SURFACE_LABELS: Record<SurfaceKey, string> = {
  sideA: 'Side A (outside)',
  sideB: 'Side B (inside)',
  top: 'Top',
  bottom: 'Bottom',
  ends: 'Ends',
  reveals: 'Opening reveals',
  sides: 'Sides',
};

/** Surfaces whose paint can be limited to zones (vertical faces with a u/v frame). */
export const ZONED_SURFACES: readonly SurfaceKey[] = ['sideA', 'sideB'];

const COLUMN_DEFAULTS = { concrete: 'default:concrete', steel: 'default:steel', timber: 'default:timber' } as const;

function curtainDefault(material: string): string {
  return material === 'glass' ? 'default:curtain-glass' : material === 'timber' ? 'default:timber' : material === 'metal' ? 'default:steel' : 'default:facade';
}

/** Slots of an element. `assetSlots` lists the material names inside an asset's model, when loaded. */
export function slotsOf(element: Element, assetSlots: readonly string[] = []): SlotInfo[] {
  const type = archTypeOf(element);
  const parameters = archOf(element)?.['parameters'];
  switch (type) {
    case 'wall':
      return parseSystemParameters('wall', parameters).layers.map((layer, index) => ({ key: `layer:${index}`, label: layer.name, fallback: layer.role === 'core' ? 'default:wall-core' : 'default:wall-finish' }));
    case 'door':
      return [{ key: 'leaf', label: 'Leaf', fallback: 'default:door-leaf' }, { key: 'frame', label: 'Frame', fallback: 'default:door-frame' }];
    case 'window':
      return [{ key: 'frame', label: 'Frame', fallback: 'default:window-frame' }, { key: 'glass', label: 'Glass', fallback: 'default:glass' }];
    case 'column':
      return [{ key: 'body', label: 'Column', fallback: COLUMN_DEFAULTS[parseSystemParameters('column', parameters).material] }];
    case 'stair':
      return [
        { key: 'tread', label: 'Treads', fallback: 'default:stair-tread' },
        { key: 'riser', label: 'Risers', fallback: 'default:stair-riser' },
        { key: 'landing', label: 'Landings', fallback: 'default:stair-landing' },
        { key: 'stringer', label: 'Stringers', fallback: 'default:stair-stringer' },
        { key: 'rail', label: 'Railings', fallback: 'default:rail' },
      ];
    case 'railing':
      return [{ key: 'rail', label: 'Rail and posts', fallback: 'default:rail' }, { key: 'panel', label: 'Panels', fallback: 'default:rail-panel' }];
    case 'curtain-wall':
      return [{ key: 'panel', label: 'Panels', fallback: curtainDefault(parseSystemParameters('curtain-wall', parameters).panelMaterial) }];
    case 'facade-element':
      return [{ key: 'body', label: 'Panel', fallback: 'default:facade' }];
    case 'floor':
      return [{ key: 'body', label: 'Slab', fallback: 'default:floor' }];
    case 'ceiling':
      return [{ key: 'body', label: 'Ceiling', fallback: 'default:ceiling' }];
    case 'room':
      return [{ key: 'floor', label: 'Floor finish', fallback: 'default:room-floor' }];
    case 'room-label':
    case 'room-divider':
      return [];
    default:
      break;
  }
  // Mesh elements (Revit imports): the materials inside their model.
  if (element.kind === 'rect' && element.meta?.['mesh']) return [{ key: 'body', label: 'Whole object', fallback: 'default:asset' }, ...assetSlots.map((name) => ({ key: `asset:${name}`, label: name, fallback: '' }))];
  if (element.kind === 'instance') return [{ key: 'body', label: 'Box', fallback: 'default:asset' }, ...assetSlots.map((name) => ({ key: `asset:${name}`, label: name, fallback: '' }))];
  if (element.kind === 'line') return [{ key: 'body', label: 'Solid', fallback: element.closed && element.style.fill ? 'default:generic' : 'default:line' }];
  if (element.kind === 'rect' || element.kind === 'image') return [{ key: 'body', label: 'Solid', fallback: 'default:generic' }];
  return [];
}

/** Whether materials apply to the element: 3D elements, not board-only helpers. */
export function takesMaterials(element: Element): boolean {
  const meta = element.meta ?? {};
  if (meta['view3d'] || meta['paper'] || meta['sectionLine'] || meta['planRegion'] || meta['cameraMarker'] || meta['annotation'] || meta['annotationLayer'] || meta['point'] || meta['level'] || meta['analysis'] || meta['noiseEmitter'] || meta['location']) return false;
  if (archTypeOf(element)) return slotsOf(element).length > 0;
  if (element.kind === 'instance' || meta['mesh']) return true;
  const solid = meta['solid'];
  const height = solid && typeof solid === 'object' && !Array.isArray(solid) ? solid['height'] : undefined;
  if (typeof height === 'number' && height > 0) return element.kind === 'rect' || element.kind === 'line' || element.kind === 'image';
  return element.kind === 'line' && element.closed && Boolean(element.style.fill);
}

/** Paintable surfaces of an element. */
export function surfacesOf(element: Element): SurfaceKey[] {
  const type = archTypeOf(element);
  if (type === 'wall') return ['sideA', 'sideB', 'top', 'bottom', 'ends', 'reveals'];
  if (type === 'floor' || type === 'ceiling' || type === 'room' || type === 'column' || type === 'facade-element') return ['top', 'bottom', 'sides'];
  if (type || element.meta?.['mesh']) return [];
  if (element.kind === 'rect' || element.kind === 'line' || element.kind === 'image') return ['top', 'bottom', 'sides'];
  return [];
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** This element's own slot overrides (`meta.materials`). */
export function instanceMaterialsOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(record(element.meta?.['materials']))) if (typeof id === 'string') out[slot] = id;
  return out;
}

/** The slot materials the element's type parameters carry (wall layers included as `layer:i`). */
export function typeMaterialsOf(element: Element): Record<string, string> {
  const type = archTypeOf(element);
  const parameters = record(archOf(element)?.['parameters'] as JsonValue | undefined);
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(record(parameters['materials']))) if (typeof id === 'string') out[slot] = id;
  if (type === 'wall') {
    parseSystemParameters('wall', parameters).layers.forEach((layer, index) => {
      if (layer.material) out[`layer:${index}`] = layer.material;
    });
  }
  return out;
}

/** Painted surfaces (`meta.surfaces`), invalid entries dropped. */
export function surfacePaintOf(element: Element): Partial<Record<SurfaceKey, SurfacePaint[]>> {
  const out: Partial<Record<SurfaceKey, SurfacePaint[]>> = {};
  for (const [surface, value] of Object.entries(record(element.meta?.['surfaces']))) {
    if (!Array.isArray(value)) continue;
    const paints = value.flatMap((entry) => {
      const parsed = SurfacePaintSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    if (paints.length) out[surface as SurfaceKey] = paints;
  }
  return out;
}

/** Material id of a slot (no surface paint). */
export function slotMaterialId(element: Element, slot: string, fallback: string): string {
  return instanceMaterialsOf(element)[slot] ?? typeMaterialsOf(element)[slot] ?? fallback;
}

/** Whether a face piece spanning [u0, u1] × [v0, v1] (mm, face coordinates) lies in a zone. */
export function inZone(paint: SurfacePaint, u0: number, u1: number, v0: number, v1: number): boolean {
  const zone = paint.zone;
  if (!zone) return true;
  const mu = (u0 + u1) / 2;
  const mv = (v0 + v1) / 2;
  const within = (range: [number, number] | undefined, value: number) => !range || (value >= Math.min(...range) && value <= Math.max(...range));
  return within(zone.u, mu) && within(zone.v, mv);
}

/** Material id painted on a face piece, or null when none of the surface's paints covers it. */
export function paintedMaterialId(paints: readonly SurfacePaint[] | undefined, u0 = 0, u1 = 0, v0 = 0, v1 = 0): string | null {
  if (!paints) return null;
  for (let index = paints.length - 1; index >= 0; index--) if (inZone(paints[index]!, u0, u1, v0, v1)) return paints[index]!.material;
  return null;
}

/** The material record for an id: the document's library, else a built-in default; null if unknown. */
export function materialById(doc: Pick<ArchaiDocument, 'materials' | 'workspace'>, id: string): Material | null {
  const own = doc.materials?.[id];
  if (own) return own;
  return isDefaultMaterialId(id) ? builtinDefault(id, doc.workspace.graphics as GraphicsOverrides | undefined) : null;
}

/** Every material id an element refers to (for "used by" and delete checks). */
export function materialIdsUsedBy(element: Element): Set<string> {
  const ids = new Set<string>([...Object.values(instanceMaterialsOf(element)), ...Object.values(typeMaterialsOf(element))]);
  for (const paints of Object.values(surfacePaintOf(element))) for (const paint of paints ?? []) ids.add(paint.material);
  return ids;
}
