/**
 * Materials (docs/materials.md): the document's library of physically based materials and the
 * way elements use them. A material is shared by every element that uses it; elements point at
 * materials through named **slots** (wall layers, door leaf...) and named **surfaces** (one face
 * of a wall, the top of a slab), optionally limited to a **zone** of that face.
 *
 * Assignments live in element meta and in system parameters (so types and presets carry them):
 * - `parameters.materials = { [slot]: materialId }`, wall layers `layers[i].material`: by type;
 * - `meta.materials = { [slot]: materialId }`: this element only;
 * - `meta.surfaces = { [surface]: SurfacePaint[] }`: painted faces, later entries on top.
 */
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: 'Expected a colour such as #1f2937' });
const Unit = z.number().min(0).max(1);

export const PATTERN_KINDS = ['brick', 'tiles', 'planks', 'stone', 'stripes'] as const;

/** A procedural texture: generated at load time (albedo, normal and roughness maps). */
export const PatternSchema = z.strictObject({
  kind: z.enum(PATTERN_KINDS),
  /** Brick / tile / plank / stone size along u and v (mm). */
  unitWidth: z.number().positive().max(20_000).default(215),
  unitHeight: z.number().positive().max(20_000).default(65),
  /** Mortar / grout / gap (mm). */
  joint: z.number().min(0).max(200).default(10),
  jointColor: Hex.default('#c9c3b8'),
  /** brick: stretcher | stack | herringbone | flemish; tiles: grid | offset | hexagon; planks: random | offset. */
  layout: z.enum(['stretcher', 'stack', 'herringbone', 'flemish', 'grid', 'offset', 'hexagon', 'random']).default('stretcher'),
  /** 0 = every unit the base colour, 1 = strong per-unit variation. */
  variation: Unit.default(0.25),
  /** Second colour for stripes, grain or speckles. */
  accent: Hex.default('#8a5a3c'),
  /** Joint depth for the normal map (0 = flat). */
  relief: Unit.default(0.6),
  seed: z.int().min(0).max(1_000_000).default(1),
});
export type MaterialPattern = z.infer<typeof PatternSchema>;

/** A texture map: an image blob of the document, or a procedural pattern. */
export const TextureRefSchema = z.union([z.strictObject({ blobId: z.string().min(1).max(64) }), z.strictObject({ pattern: PatternSchema })]);
export type TextureRef = z.infer<typeof TextureRefSchema>;

export const MATERIAL_CATEGORIES = ['masonry', 'concrete', 'wood', 'metal', 'glass', 'stone', 'tile', 'finish', 'fabric', 'other'] as const;
export const MATERIAL_HATCHES = ['none', 'diagonal', 'cross', 'dots'] as const;

export const MaterialSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  category: z.enum(MATERIAL_CATEGORIES).default('other'),
  /** Albedo colour; multiplies the albedo map when there is one. */
  color: Hex,
  /** Albedo map. A pattern also drives the normal and roughness maps unless those are given. */
  map: TextureRefSchema.optional(),
  roughness: Unit.default(0.8),
  roughnessMap: TextureRefSchema.optional(),
  metalness: Unit.default(0),
  metalnessMap: TextureRefSchema.optional(),
  normalMap: TextureRefSchema.optional(),
  normalStrength: z.number().min(0).max(4).default(1),
  aoMap: TextureRefSchema.optional(),
  aoStrength: Unit.default(1),
  /** Below 1 the material is blended (glass, mesh). */
  opacity: Unit.default(1),
  /** Physical glass: light passes through (0 = opaque look), refraction index. */
  transmission: Unit.default(0),
  ior: z.number().min(1).max(2.5).default(1.5),
  clearcoat: Unit.default(0),
  emissive: Hex.default('#000000'),
  emissiveIntensity: z.number().min(0).max(20).default(0),
  /** Real-world size of one texture tile (mm), rotation (degrees) and offset (mm). */
  tileWidth: z.number().positive().max(100_000).default(1000),
  tileHeight: z.number().positive().max(100_000).default(1000),
  rotation: z.number().finite().default(0),
  offsetX: z.number().finite().default(0),
  offsetY: z.number().finite().default(0),
  /** Cut surfaces of this material in sections and plans (null → the element type's own cut graphics). */
  cutHatch: z.enum(MATERIAL_HATCHES).nullable().default(null),
  cutColor: Hex.default('#d9d9d6'),
  cutHatchColor: Hex.default('#3a3a3f'),
  cutHatchSpacing: z.number().positive().max(5000).default(120),
  cutHatchAngle: z.number().finite().default(45),
  /** Where the material came from: `library:<id>` (ArchAI's material library), `mine:<id>` (My materials). */
  source: z.string().max(200).optional(),
});
export type Material = z.infer<typeof MaterialSchema>;
export type MaterialInput = z.input<typeof MaterialSchema>;

export const MaterialLibrarySchema = z.record(z.string().min(1).max(64), MaterialSchema);

/** A zone on a face, in face coordinates: `u` along the face from its start, `v` up from its bottom (mm). */
export const ZoneSchema = z.strictObject({
  u: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  v: z.tuple([z.number().finite(), z.number().finite()]).optional(),
});
export type SurfaceZone = z.infer<typeof ZoneSchema>;

export const SurfacePaintSchema = z.strictObject({ material: z.string().min(1).max(64), zone: ZoneSchema.optional() });
export type SurfacePaint = z.infer<typeof SurfacePaintSchema>;
