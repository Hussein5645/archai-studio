/**
 * Document schema v1.
 *
 * Conventions (deliberate, costly to change later — see docs/architecture.md):
 * - every length and coordinate is in millimetres, y grows downwards;
 * - rotation is in degrees, clockwise, about the element's local origin (its top-left);
 * - elements form a flat table; `parentId` gives the tree, `index` (a fractional index) gives
 *   the back-to-front order among siblings;
 * - the zod schemas are the single source of truth: the TypeScript types are inferred from them.
 */
import { z } from 'zod';
import { MaterialLibrarySchema } from './material';

export const SCHEMA_VERSION = 1 as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const IdSchema = z.string().min(1).max(64);
export const ColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
  message: 'Expected a hex colour such as #1f2937',
});
const Finite = z.number().finite();
const NonNegative = Finite.min(0);
const Unit = z.number().min(0).max(1);
const Meta = z.record(z.string(), JsonValueSchema);

export const StyleSchema = z.strictObject({
  fill: z.preprocess((val) => (val === 'transparent' ? null : val), ColorSchema.nullable()),
  stroke: z.preprocess((val) => (val === 'transparent' ? null : val), ColorSchema.nullable()),
  strokeWidth: NonNegative,
  opacity: Unit,
});
export type Style = z.infer<typeof StyleSchema>;

const ElementBase = z.strictObject({
  id: IdSchema,
  /** `null` = board root (or, inside a definition template, the template root). */
  parentId: IdSchema.nullable(),
  /** Fractional index; siblings sorted ascending render back → front. */
  index: z.string().min(1),
  x: Finite,
  y: Finite,
  rotation: Finite,
  name: z.string().max(200).optional(),
  visible: z.boolean(),
  locked: z.boolean(),
  /** Architectural meaning lives here, e.g. `{ arch: { type: 'wall', thickness: 200 } }`. */
  meta: Meta.optional(),
});

export const RectElementSchema = ElementBase.extend({
  kind: z.literal('rect'),
  width: NonNegative,
  height: NonNegative,
  radius: NonNegative,
  style: StyleSchema,
});
const CurvePoint = z.tuple([Finite, Finite]);
export const CurvePathSchema = z.object({
  start: CurvePoint,
  segments: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('line'), to: CurvePoint }),
    z.object({ kind: z.literal('quadratic'), control: CurvePoint, to: CurvePoint }),
    z.object({ kind: z.literal('bezier'), control1: CurvePoint, control2: CurvePoint, to: CurvePoint }),
    z.object({ kind: z.literal('arc'), center: CurvePoint, radius: z.number().positive(), startAngle: Finite, endAngle: Finite, clockwise: z.boolean().default(false) }),
  ])).min(1),
});
export const LineElementSchema = ElementBase.extend({
  kind: z.literal('line'),
  /** Polyline vertices in local coordinates; two points make a plain line. */
  points: z.array(z.tuple([Finite, Finite])).min(2),
  /** Editable analytic source; points remain a transient tessellation for legacy geometry. */
  path: CurvePathSchema.optional(),
  closed: z.boolean(),
  style: StyleSchema,
});
export const TextElementSchema = ElementBase.extend({
  kind: z.literal('text'),
  width: NonNegative,
  height: NonNegative,
  text: z.string(),
  fontSize: z.number().positive(),
  align: z.enum(['left', 'center', 'right']),
  color: ColorSchema,
});
export const ImageElementSchema = ElementBase.extend({
  kind: z.literal('image'),
  width: NonNegative,
  height: NonNegative,
  blobId: IdSchema,
  opacity: Unit,
});
export const GroupElementSchema = ElementBase.extend({
  kind: z.literal('group'),
});
export const InstanceElementSchema = ElementBase.extend({
  kind: z.literal('instance'),
  definitionId: IdSchema,
  /** The definition's template is scaled from its natural size to this size. */
  width: NonNegative,
  height: NonNegative,
});

export const ElementSchema = z.discriminatedUnion('kind', [
  RectElementSchema,
  LineElementSchema,
  TextElementSchema,
  ImageElementSchema,
  GroupElementSchema,
  InstanceElementSchema,
]);

export type RectElement = z.infer<typeof RectElementSchema>;
export type LineElement = z.infer<typeof LineElementSchema>;
export type CurvePath = NonNullable<LineElement['path']>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type ImageElement = z.infer<typeof ImageElementSchema>;
export type GroupElement = z.infer<typeof GroupElementSchema>;
export type InstanceElement = z.infer<typeof InstanceElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type ElementKind = Element['kind'];
export type SizedElement = RectElement | TextElement | ImageElement | InstanceElement;

const DefinitionBase = z.strictObject({
  id: IdSchema,
  name: z.string().max(200),
  category: z.string().max(200).optional(),
  tags: z.array(z.string().max(64)).optional(),
  /** Natural size; a template's elements live in [0, width] × [0, height]. */
  width: NonNegative,
  height: NonNegative,
  origin: z.enum(['builtin', 'user', 'catalog']),
  /** Stable id of the built-in tool/symbol this definition was created from. */
  builtinId: z.string().max(200).optional(),
  /** Provenance of a catalog asset; the document stays self-contained without it. */
  catalog: z
    .strictObject({
      source: z.string().max(500).optional(),
      path: z.string().max(500),
      imageUrl: z.string().max(2000).optional(),
      modelUrl: z.string().max(2000).optional(),
      package: z
        .strictObject({
          key: z.string().max(1000),
          url: z.string().max(2000),
          version: z.literal(1),
        })
        .optional(),
      topViewPath: z.string().max(1000).optional(),
      modelPaths: z
        .strictObject({
          glb: z.string().max(1000).optional(),
          fbx: z.string().max(1000).optional(),
          glbLow: z.string().max(1000).optional(),
        })
        .optional(),
      /** Views rendered in other display styles, by style name (archive paths inside the package). */
      styleViews: z
        .record(z.string().max(40), z.strictObject({ top: z.string().max(1000).optional(), front: z.string().max(1000).optional(), side: z.string().max(1000).optional() }))
        .optional(),
      systemType: z.enum(['wall', 'window', 'door', 'column', 'stair', 'railing', 'curtain-wall', 'facade-element', 'floor', 'ceiling']).optional(),
    })
    .optional(),
  meta: Meta.optional(),
});

export const DefinitionSchema = z.discriminatedUnion('kind', [
  DefinitionBase.extend({
    kind: z.literal('template'),
    /** A mini-document: same element types, `parentId: null` means the template root. */
    elements: z.record(IdSchema, ElementSchema),
  }),
  DefinitionBase.extend({
    kind: z.literal('image'),
    blobId: IdSchema,
  }),
]);
export type AssetDefinition = z.infer<typeof DefinitionSchema>;
export type TemplateDefinition = Extract<AssetDefinition, { kind: 'template' }>;
export type ImageDefinition = Extract<AssetDefinition, { kind: 'image' }>;

export const BlobSchema = z.strictObject({
  /** `blob_` + sha-256 of the bytes, so identical images are stored once. */
  id: IdSchema,
  mime: z.string().max(100),
  /** base64-encoded bytes */
  data: z.string(),
  width: NonNegative,
  height: NonNegative,
});
export type BlobRecord = z.infer<typeof BlobSchema>;

export const UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;
export const BOARD_VIEW_STYLES = ['realistic', 'hidden-line', 'shaded', 'wireframe', 'consistent'] as const;
export const LOD_LEVELS = ['high', 'low'] as const;
/** Presentation themes of diagram elements (see src/diagrams/model.ts). */
export const DIAGRAM_THEME_IDS = ['technical', 'soft', 'mono', 'bold'] as const;

export const WorkspaceSchema = z.strictObject({
  /** Display unit only; storage is always millimetres. */
  unit: z.enum(UNITS),
  precision: z.int().min(0).max(4),
  background: ColorSchema,
  grid: z.strictObject({ visible: z.boolean(), size: z.number().positive() }),
  snap: z.strictObject({ enabled: z.boolean() }),
  /** How board elements are drawn (2D and the 3D views). */
  viewStyle: z.enum(BOARD_VIEW_STYLES).default('hidden-line'),
  /**
   * 3D views only: high renders assets from their full model, low from the package's low-poly model
   * (or a box). The board and 2D views always draw assets from their model.
   */
  lod: z.enum(LOD_LEVELS).default('low'),
  /** Board level: the elevation (mm) new elements drawn on the board start at in 3D. */
  boardElevation: z.number().finite().min(-1_000_000).max(1_000_000).default(0),
  /**
   * Hidden-line element graphics overrides: `{ [type]: { [view]: { hidden-line: { [parameter]: value } } }`
   * (see src/graphics). Per document; new documents start from the built-in defaults.
   */
  graphics: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.record(z.string(), JsonValueSchema)))).default({}),
  /** Look of arrows, zones, tags, callouts and dimensions across the document. */
  diagramTheme: z.enum(DIAGRAM_THEME_IDS).default('technical'),
});
export type BoardViewStyle = (typeof BOARD_VIEW_STYLES)[number];
export type LodLevel = (typeof LOD_LEVELS)[number];
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Unit = (typeof UNITS)[number];

export const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdSchema,
  meta: z.strictObject({
    name: z.string().max(200),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  workspace: WorkspaceSchema,
  elements: z.record(IdSchema, ElementSchema),
  definitions: z.record(IdSchema, DefinitionSchema),
  blobs: z.record(IdSchema, BlobSchema),
  /** Material library (see ./material.ts); older documents have none. */
  materials: MaterialLibrarySchema.default({}),
});
export type ArchaiDocument = z.infer<typeof DocumentSchema>;
