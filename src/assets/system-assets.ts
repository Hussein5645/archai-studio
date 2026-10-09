/**
 * Parameter definitions for the system tools' configuration dialog. The value contract itself
 * (which keys exist, their defaults and validation) lives in `@/catalog/system-schemas`; this
 * module only describes how each key is edited.
 */
import { DEFAULT_WALL_LAYERS, parseSystemParameters, SYSTEM_PARAMETER_SCHEMAS, type SystemAssetType, type SystemParameterValue } from '@/catalog';

export type { SystemParameterValue };

export interface SystemParameterDefinition {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'boolean' | 'layers' | 'profile';
  defaultValue: SystemParameterValue;
  unit?: 'length';
  options?: readonly { value: string; label: string }[];
  /** Hides the field when it does not apply to the current values (e.g. diameter for a rectangle). */
  visibleWhen?: (parameters: Record<string, SystemParameterValue>) => boolean;
  /** Fields that only matter to the future 3D workspace are labelled as such. */
  note?: string;
}

export interface SystemParameterSelection {
  type: SystemAssetType;
  parameters: Record<string, SystemParameterValue>;
  instanceEditable: readonly string[];
}

const choice = (values: string[]) => values.map((value) => ({ value, label: value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }));

export const SYSTEM_ASSET_CATEGORIES: Record<SystemAssetType, readonly string[]> = {
  wall: ['Architecture/Structure/Walls'],
  window: ['Architecture/Openings/Windows'],
  door: ['Architecture/Openings/Doors'],
  column: ['Architecture/Structure/Columns'],
  stair: ['Architecture/Circulation/Stairs', 'Architecture/Structure/Stairs'],
  railing: ['Architecture/Circulation/Railings'],
  'curtain-wall': ['Architecture/Envelope/Curtain Walls'],
  'facade-element': ['Architecture/Envelope/Facade Elements'],
  floor: ['Architecture/Spaces/Floors'],
  ceiling: ['Architecture/Spaces/Ceilings'],
};

export const SYSTEM_PARAMETER_DEFINITIONS: Record<SystemAssetType, readonly SystemParameterDefinition[]> = {
  wall: [
    { key: 'pathType', label: 'Wall path type', kind: 'select', defaultValue: 'straight', options: choice(['straight', 'arc', 'bezier']) },
    { key: 'arcBulge', label: 'Arc bulge', kind: 'number', defaultValue: 0.25, visibleWhen: (p) => p['pathType'] === 'arc' },
    { key: 'bezierHandles', label: 'Bézier handles', kind: 'profile', defaultValue: [[0.33, 0.2], [0.67, 0.2]], visibleWhen: (p) => p['pathType'] === 'bezier' },
    { key: 'locationLine', label: 'Location line', kind: 'select', defaultValue: 'centre', options: choice(['centre', 'inside', 'outside']) },
    { key: 'layers', label: 'Layers (outside → inside)', kind: 'layers', defaultValue: DEFAULT_WALL_LAYERS },
    { key: 'height', label: 'Height · 3D', kind: 'number', defaultValue: 3000, unit: 'length' },
    { key: 'elevation', label: 'Elevation', kind: 'number', defaultValue: 0, unit: 'length', note: '3D' },
  ],
  column: [
    { key: 'shape', label: 'Shape', kind: 'select', defaultValue: 'rectangle', options: choice(['rectangle', 'circle', 'custom']) },
    { key: 'width', label: 'Width', kind: 'number', defaultValue: 500, unit: 'length', visibleWhen: (p) => p['shape'] !== 'circle' },
    { key: 'depth', label: 'Depth', kind: 'number', defaultValue: 500, unit: 'length', visibleWhen: (p) => p['shape'] !== 'circle' },
    { key: 'diameter', label: 'Diameter', kind: 'number', defaultValue: 500, unit: 'length', visibleWhen: (p) => p['shape'] === 'circle' },
    { key: 'height', label: 'Height · 3D', kind: 'number', defaultValue: 3000, unit: 'length' },
    { key: 'elevation', label: 'Elevation', kind: 'number', defaultValue: 0, unit: 'length', note: '3D' },
    { key: 'material', label: 'Material', kind: 'select', defaultValue: 'concrete', options: choice(['concrete', 'steel', 'timber']) },
    { key: 'profile', label: 'Custom top profile', kind: 'profile', defaultValue: [[0, 0], [1, 0], [1, 1], [0, 1]], visibleWhen: (p) => p['shape'] === 'custom' },
  ],
  door: [
    { key: 'operation', label: 'Operation', kind: 'select', defaultValue: 'swing', options: choice(['swing', 'double-swing', 'sliding', 'folding', 'revolving']) },
    { key: 'width', label: 'Width', kind: 'number', defaultValue: 900, unit: 'length' },
    { key: 'handing', label: 'Handing', kind: 'select', defaultValue: 'left', options: choice(['left', 'right']), visibleWhen: (p) => p['operation'] === 'swing' || p['operation'] === 'sliding' },
    { key: 'openingSide', label: 'Opens towards', kind: 'select', defaultValue: 'inside', options: choice(['inside', 'outside']), visibleWhen: (p) => p['operation'] !== 'revolving' },
    { key: 'threshold', label: 'Threshold', kind: 'number', defaultValue: 0, unit: 'length' },
    { key: 'height', label: 'Height · 3D', kind: 'number', defaultValue: 2100, unit: 'length' },
  ],
  window: [
    { key: 'mechanism', label: 'Mechanism', kind: 'select', defaultValue: 'fixed', options: choice(['fixed', 'casement', 'sliding', 'awning', 'tilt-turn']) },
    { key: 'width', label: 'Width', kind: 'number', defaultValue: 1200, unit: 'length' },
    { key: 'height', label: 'Height · 3D', kind: 'number', defaultValue: 1200, unit: 'length' },
    { key: 'sill', label: 'Sill', kind: 'number', defaultValue: 900, unit: 'length', note: '3D' },
    { key: 'openingDirection', label: 'Opening direction', kind: 'select', defaultValue: 'none', options: choice(['inward', 'outward', 'none']), visibleWhen: (p) => p['mechanism'] !== 'fixed' && p['mechanism'] !== 'sliding' },
  ],
  stair: [
    { key: 'width', label: 'Width', kind: 'number', defaultValue: 1000, unit: 'length' },
    { key: 'totalRise', label: 'Total rise', kind: 'number', defaultValue: 3000, unit: 'length' },
    { key: 'riserHeight', label: 'Riser height', kind: 'number', defaultValue: 175, unit: 'length' },
    { key: 'treadDepth', label: 'Tread length', kind: 'number', defaultValue: 280, unit: 'length' },
    { key: 'landingDepth', label: 'Landing depth', kind: 'number', defaultValue: 1000, unit: 'length' },
    { key: 'treadStyle', label: 'Tread style', kind: 'select', defaultValue: 'closed-riser', options: choice(['closed-riser', 'open']) },
    { key: 'nosing', label: 'Nosing', kind: 'number', defaultValue: 0, unit: 'length' },
    { key: 'elevation', label: 'Elevation', kind: 'number', defaultValue: 0, unit: 'length', note: '3D' },
    { key: 'treadProfile', label: 'Custom tread profile', kind: 'profile', defaultValue: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { key: 'riserProfile', label: 'Custom riser profile', kind: 'profile', defaultValue: [[0, 0], [1, 0], [1, 1], [0, 1]], visibleWhen: (p) => p['treadStyle'] === 'closed-riser' },
  ],
  railing: [
    { key: 'pattern', label: 'Pattern', kind: 'select', defaultValue: 'baluster', options: choice(['baluster', 'glass-panel', 'cable', 'solid']) },
    { key: 'thickness', label: 'Thickness', kind: 'number', defaultValue: 80, unit: 'length' },
    { key: 'height', label: 'Height · 3D', kind: 'number', defaultValue: 1100, unit: 'length' },
    { key: 'balusterSpacing', label: 'Baluster spacing', kind: 'number', defaultValue: 120, unit: 'length' },
    { key: 'elevation', label: 'Elevation', kind: 'number', defaultValue: 0, unit: 'length', note: '3D' },
  ],
  'curtain-wall': [
    { key: 'mullionSpacing', label: 'Mullion spacing', kind: 'number', defaultValue: 1200, unit: 'length' },
    { key: 'panelSpacing', label: 'Panel spacing', kind: 'number', defaultValue: 3000, unit: 'length' },
    { key: 'panelType', label: 'Panel type', kind: 'select', defaultValue: 'glazed', options: choice(['glazed', 'opaque', 'mixed']) },
    { key: 'panelMaterial', label: 'Panel material', kind: 'select', defaultValue: 'glass', options: choice(['glass', 'metal', 'stone', 'timber']) },
    { key: 'panelProfile', label: 'Custom panel shape', kind: 'profile', defaultValue: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  ],
  'facade-element': [
    { key: 'width', label: 'Width', kind: 'number', defaultValue: 1200, unit: 'length' },
    { key: 'height', label: 'Height', kind: 'number', defaultValue: 3000, unit: 'length' },
    { key: 'depth', label: 'Depth', kind: 'number', defaultValue: 200, unit: 'length' },
    { key: 'alignment', label: 'Alignment', kind: 'select', defaultValue: 'middle', options: choice(['inside', 'middle', 'outside']) },
    { key: 'profile', label: 'Custom profile', kind: 'profile', defaultValue: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  ],
  floor: [
    { key: 'thickness', label: 'Thickness', kind: 'number', defaultValue: 200, unit: 'length' },
    { key: 'elevation', label: 'Top elevation', kind: 'number', defaultValue: 0, unit: 'length' },
    { key: 'material', label: 'Material', kind: 'select', defaultValue: 'concrete', options: choice(['concrete', 'timber', 'tile', 'generic']) },
  ],
  ceiling: [
    { key: 'thickness', label: 'Thickness', kind: 'number', defaultValue: 100, unit: 'length' },
    { key: 'elevation', label: 'Bottom elevation', kind: 'number', defaultValue: 2700, unit: 'length' },
    { key: 'material', label: 'Material', kind: 'select', defaultValue: 'generic', options: choice(['concrete', 'timber', 'tile', 'generic']) },
  ],
};

/** Type parameters that always remain per-instance and cannot be folded back into a shared type. */
export function mandatoryInstanceParameterKeys(type: SystemAssetType): string[] {
  if (type === 'wall') return ['pathType', 'arcBulge', 'bezierHandles', 'elevation'];
  if (type === 'door') return ['threshold'];
  if (type === 'window') return ['sill'];
  if (['wall', 'column', 'stair', 'railing', 'floor', 'ceiling'].includes(type)) return ['elevation'];
  return [];
}

/** Canonical ownership, including required instance fields in older documents. */
export function instanceParameterKeys(type: SystemAssetType, value: unknown): string[] {
  const requested = new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  for (const key of mandatoryInstanceParameterKeys(type)) requested.add(key);
  return SYSTEM_PARAMETER_DEFINITIONS[type].filter((definition) => requested.has(definition.key)).map((definition) => definition.key);
}

/** System dimensions replace generic bounding-box editors and graph inputs. */
export function systemDimensionParameters(type: SystemAssetType, parameters: Record<string, SystemParameterValue>): { width?: string; height?: string } {
  const keys = new Set(SYSTEM_PARAMETER_DEFINITIONS[type].filter((definition) => !definition.visibleWhen || definition.visibleWhen(parameters)).map((definition) => definition.key));
  return {
    width: keys.has('diameter') ? 'diameter' : keys.has('width') ? 'width' : undefined,
    height: keys.has('diameter') ? 'diameter' : keys.has('depth') ? 'depth' : undefined,
  };
}

/** Parameters that every selected system instance exposes with a compatible editor contract. */
export function sharedInstanceParameterDefinitions(selections: readonly SystemParameterSelection[]): SystemParameterDefinition[] {
  const first = selections[0];
  if (!first || selections.length < 2) return [];
  const compatible = (left: SystemParameterDefinition, right: SystemParameterDefinition) =>
    left.kind === right.kind &&
    left.unit === right.unit &&
    JSON.stringify(left.options?.map((option) => option.value) ?? []) === JSON.stringify(right.options?.map((option) => option.value) ?? []);
  return SYSTEM_PARAMETER_DEFINITIONS[first.type].filter((definition) => {
    if (!instanceParameterKeys(first.type, first.instanceEditable).includes(definition.key) || (definition.visibleWhen && !definition.visibleWhen(first.parameters))) return false;
    return selections.slice(1).every((selection) => {
      if (!instanceParameterKeys(selection.type, selection.instanceEditable).includes(definition.key)) return false;
      const candidate = SYSTEM_PARAMETER_DEFINITIONS[selection.type].find((item) => item.key === definition.key);
      return Boolean(candidate && compatible(definition, candidate) && (!candidate.visibleWhen || candidate.visibleWhen(selection.parameters)));
    });
  });
}

export function defaultSystemParameters(type: SystemAssetType): Record<string, SystemParameterValue> {
  return parseSystemParameters(type, {}) as Record<string, SystemParameterValue>;
}

/** Defaults overlaid with (validated) values; invalid keys fall back to their defaults. */
export function resolveSystemParameters(type: SystemAssetType, value: unknown): Record<string, SystemParameterValue> {
  return parseSystemParameters(type, value) as Record<string, SystemParameterValue>;
}

export function isSystemAssetType(value: unknown): value is SystemAssetType {
  return typeof value === 'string' && value in SYSTEM_PARAMETER_SCHEMAS;
}

/**
 * Which local axes of a system element may be sized on the board (handles, temporary dimensions):
 * an axis driven by a type parameter only changes through the type, never by hand. Axes without a
 * dimension parameter stay free; non-system elements return null.
 */
export function boardSizeAxes(type: unknown, arch: { parameters?: unknown; instanceEditable?: unknown } | null | undefined): { width: boolean; height: boolean } | null {
  if (!isSystemAssetType(type)) return null;
  const editable = instanceParameterKeys(type, arch?.instanceEditable);
  const dimensions = systemDimensionParameters(type, resolveSystemParameters(type, arch?.parameters));
  return {
    width: !dimensions.width || editable.includes(dimensions.width),
    height: !dimensions.height || editable.includes(dimensions.height),
  };
}
