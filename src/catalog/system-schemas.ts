/**
 * Per-tool schemas for `system.parameters` in a system `.CAI` package and for the parameters
 * stored on placed elements. They are the contract between the R2 `system/<tool>/` folder,
 * the catalog validator (`scripts/build-cai-catalog.mjs` mirrors them in plain JS) and the
 * configuration dialog. Pure zod: nothing here depends on the document or the UI.
 */
import { z } from 'zod';

export const SYSTEM_TYPES = ['wall', 'window', 'door', 'column', 'stair', 'railing', 'curtain-wall', 'facade-element', 'floor', 'ceiling'] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];

/** Tools that accept extra types from the R2 `system/<tool>/` folder. */
export const SYSTEM_TOOL_FOLDERS = ['wall', 'column', 'door', 'window', 'stair', 'railing'] as const;
export type SystemToolFolder = (typeof SYSTEM_TOOL_FOLDERS)[number];

/** Types drawn as a line: they carry a `section` swatch instead of orthographic views/models. */
export const LINE_SYSTEM_TYPES: readonly SystemType[] = ['wall', 'railing', 'curtain-wall'];

const Length = z.number().finite().nonnegative();
const PositiveLength = z.number().finite().positive();
const Profile = z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).default([[0, 0], [1, 0], [1, 1], [0, 1]]);
const CurveHandles = z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(64).refine((handles) => handles.length % 2 === 0, 'Use two handles per Bézier segment').default([[0.33, 0.2], [0.67, 0.2]]);

/** Materials of a system type's slots by slot key (see src/materials/slots.ts), carried by types and presets. */
const SlotMaterials = z.record(z.string().max(80), z.string().min(1).max(64)).default({});

export const WallLayerSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.enum(['finish', 'core']),
  thickness: PositiveLength,
  /** Material id of this layer (docs/materials.md); unset → the default finish / core material. */
  material: z.string().min(1).max(64).optional(),
});
export type WallLayer = z.infer<typeof WallLayerSchema>;

export const WallParametersSchema = z.object({
  pathType: z.enum(['straight', 'arc', 'bezier']).default('straight'),
  arcBulge: z.number().finite().default(0.25),
  bezierHandles: CurveHandles,
  /** Listed outside → inside. At least one core layer. */
  layers: z.array(WallLayerSchema).min(1).refine((layers) => layers.some((layer) => layer.role === 'core'), 'Walls need at least one core layer'),
  locationLine: z.enum(['centre', 'inside', 'outside']).default('centre'),
  /** 3D only: wall height from its base. */
  height: PositiveLength.default(3000),
  /** 3D only: base elevation above the ground plane. */
  elevation: Length.default(0),
  materials: SlotMaterials,
});

export const ColumnParametersSchema = z
  .object({
    shape: z.enum(['rectangle', 'circle', 'custom']).default('rectangle'),
    width: PositiveLength.default(500),
    depth: PositiveLength.default(500),
    diameter: PositiveLength.default(500),
    /** 3D only. */
    height: PositiveLength.default(3000),
    elevation: Length.default(0),
    material: z.enum(['concrete', 'steel', 'timber']).default('concrete'),
    profile: Profile,
    materials: SlotMaterials,
  });

export const DoorParametersSchema = z.object({
  operation: z.enum(['swing', 'double-swing', 'sliding', 'folding', 'revolving']).default('swing'),
  width: PositiveLength.default(900),
  handing: z.enum(['left', 'right']).default('left'),
  /** Which wall face the leaf swings towards. */
  openingSide: z.enum(['inside', 'outside']).default('inside'),
  threshold: Length.default(0),
  /** 3D only. */
  height: PositiveLength.default(2100),
  materials: SlotMaterials,
});

export const WindowParametersSchema = z.object({
  mechanism: z.enum(['fixed', 'casement', 'sliding', 'awning', 'tilt-turn']).default('fixed'),
  width: PositiveLength.default(1200),
  height: PositiveLength.default(1200),
  sill: Length.default(900),
  openingDirection: z.enum(['inward', 'outward', 'none']).default('none'),
  materials: SlotMaterials,
});

export const StairParametersSchema = z.object({
  width: PositiveLength.default(1000),
  riserHeight: PositiveLength.default(175),
  treadDepth: PositiveLength.default(280),
  totalRise: PositiveLength.default(3000),
  landingDepth: PositiveLength.default(1000),
  treadStyle: z.enum(['open', 'closed-riser']).default('closed-riser'),
  nosing: Length.default(0),
  /** 3D only: elevation of the first riser's base. */
  elevation: Length.default(0),
  treadProfile: Profile,
  riserProfile: Profile,
  materials: SlotMaterials,
});

export const RailingParametersSchema = z.object({
  thickness: PositiveLength.default(80),
  /** 3D only. */
  height: PositiveLength.default(1100),
  /** 0 disables the plan ticks. */
  balusterSpacing: Length.default(120),
  pattern: z.enum(['baluster', 'glass-panel', 'cable', 'solid']).default('baluster'),
  elevation: Length.default(0),
  materials: SlotMaterials,
});

export const CurtainWallParametersSchema = z.object({
  mullionSpacing: PositiveLength.default(1200),
  panelSpacing: PositiveLength.default(3000),
  panelType: z.enum(['glazed', 'opaque', 'mixed']).default('glazed'),
  panelMaterial: z.enum(['glass', 'metal', 'stone', 'timber']).default('glass'),
  panelProfile: Profile,
  materials: SlotMaterials,
});

export const FacadeElementParametersSchema = z.object({
  width: PositiveLength.default(1200),
  height: PositiveLength.default(3000),
  depth: PositiveLength.default(200),
  alignment: z.enum(['inside', 'middle', 'outside']).default('middle'),
  profile: Profile,
  materials: SlotMaterials,
});

const SlabParametersSchema = z.object({
  thickness: PositiveLength,
  elevation: Length,
  material: z.enum(['concrete', 'timber', 'tile', 'generic']).default('concrete'),
  materials: SlotMaterials,
});

export const FloorParametersSchema = SlabParametersSchema.extend({
  thickness: PositiveLength.default(200),
  elevation: Length.default(0),
});

export const CeilingParametersSchema = SlabParametersSchema.extend({
  thickness: PositiveLength.default(100),
  elevation: Length.default(2700),
});

export const SYSTEM_PARAMETER_SCHEMAS = {
  wall: WallParametersSchema,
  column: ColumnParametersSchema,
  door: DoorParametersSchema,
  window: WindowParametersSchema,
  stair: StairParametersSchema,
  railing: RailingParametersSchema,
  'curtain-wall': CurtainWallParametersSchema,
  'facade-element': FacadeElementParametersSchema,
  floor: FloorParametersSchema,
  ceiling: CeilingParametersSchema,
} as const satisfies Record<SystemType, z.ZodTypeAny>;

export type WallParameters = z.infer<typeof WallParametersSchema>;

/**
 * A system package may carry named presets; each becomes one selectable type for its tool.
 * A preset is `{ id, name }` plus that tool's parameters (validated per type). Presets saved
 * from the dialog live in the local package `localPresetsId(type)`.
 */
export const SystemPresetSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
  })
  .passthrough();
export type SystemPreset = z.infer<typeof SystemPresetSchema> & Record<string, unknown>;
/** @deprecated wall presets are ordinary system presets now. */
export const WallPresetSchema = SystemPresetSchema;
export type WallPreset = SystemPreset;

export function localPresetsId(type: SystemType): string {
  return `local-${type}-presets`;
}
export const LOCAL_WALL_PRESETS_ID = localPresetsId('wall');

/** Parameters of a preset (everything but its id and name). */
export function presetParameters(preset: SystemPreset): Record<string, unknown> {
  const { id: _id, name: _name, instanceEditable: _instanceEditable, ...parameters } = preset;
  return parameters;
}

/** Preset id embedded in a catalog asset id: `<package id>#<preset id>`. */
export function presetAssetId(packageId: string, presetId: string): string {
  return `${packageId}#${presetId}`;
}
export type ColumnParameters = z.infer<typeof ColumnParametersSchema>;
export type DoorParameters = z.infer<typeof DoorParametersSchema>;
export type WindowParameters = z.infer<typeof WindowParametersSchema>;
export type StairParameters = z.infer<typeof StairParametersSchema>;
export type RailingParameters = z.infer<typeof RailingParametersSchema>;

export const DEFAULT_WALL_LAYERS: WallLayer[] = [{ name: 'Core', role: 'core', thickness: 200 }];

/**
 * Parses parameters for a type, filling defaults. Unknown keys are dropped; an invalid value
 * falls back to its default rather than failing, so a stale document never blocks editing.
 */
export function parseSystemParameters<T extends SystemType>(type: T, value: unknown): z.infer<(typeof SYSTEM_PARAMETER_SCHEMAS)[T]> {
  const schema = SYSTEM_PARAMETER_SCHEMAS[type];
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  if (type === 'wall' && !Array.isArray(raw['layers'])) {
    // Walls created before layers existed carried a single `thickness`.
    const thickness = typeof raw['thickness'] === 'number' && raw['thickness'] > 0 ? raw['thickness'] : 200;
    raw['layers'] = [{ name: 'Core', role: 'core', thickness }];
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data as z.infer<(typeof SYSTEM_PARAMETER_SCHEMAS)[T]>;
  const shape = (schema as z.ZodObject).shape as Record<string, z.ZodTypeAny>;
  const repaired: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const single = shape[key]!.safeParse(raw[key]);
    if (single.success) repaired[key] = single.data;
  }
  if (type === 'wall' && !repaired['layers']) repaired['layers'] = DEFAULT_WALL_LAYERS;
  return schema.parse(repaired) as z.infer<(typeof SYSTEM_PARAMETER_SCHEMAS)[T]>;
}

/** Strict validation for a package: every provided key must be valid for the tool. */
export function validateSystemPackageParameters(type: SystemType, value: unknown): { ok: true } | { ok: false; message: string } {
  const result = SYSTEM_PARAMETER_SCHEMAS[type].safeParse(value ?? {});
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  return { ok: false, message: issue ? `${issue.path.join('.') || 'parameters'}: ${issue.message}` : 'invalid parameters' };
}

export function wallThickness(layers: readonly WallLayer[]): number {
  return layers.reduce((sum, layer) => sum + layer.thickness, 0);
}
