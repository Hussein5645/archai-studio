/**
 * The Revit exchange file (docs/revit-import.md): what the ArchAI add-in's *Send to ArchAI*
 * writes from an open Revit model, as a `.AIR` file whose root has `archaiRevit: 1` instead of a
 * document's `schemaVersion`. ArchAI rebuilds it into native elements through its own commands
 * (see ./importRevit.ts).
 *
 * Units and axes are ArchAI's: millimetres, plan x to the right, plan y down (Revit Y is
 * reversed), elevations up from Revit's internal origin. Paths along walls (`start`, `end`) are
 * measured from the wall's first point along its whole polyline.
 */
import { z } from 'zod';

const Num = z.number().finite();
const Point = z.tuple([Num, Num]);
const Polygon = z.array(Point).min(3);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Id = z.string().min(1).max(64);
/** The element's level; the add-in writes null when Revit has none. */
const LevelRef = Id.nullish().transform((value) => value ?? undefined);

export const RevitMaterialSchema = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  color: Hex.default('#c9ccd3'),
  opacity: z.number().min(0).max(1).default(1),
  roughness: z.number().min(0).max(1).default(0.8),
  metalness: z.number().min(0).max(1).default(0),
});

export const RevitLevelSchema = z.object({ id: Id, name: z.string().min(1).max(120), elevation: Num });

export const RevitWallSchema = z.object({
  id: Id,
  name: z.string().max(120).default('Wall'),
  level: LevelRef,
  /** Centre line, outside on the left (the side ArchAI draws layer 0 on). */
  points: z.array(Point).min(2),
  /** Absolute base elevation and height (mm). */
  base: Num,
  height: z.number().positive(),
  layers: z.array(z.object({ name: z.string().min(1).max(60), role: z.enum(['core', 'finish']), thickness: z.number().positive(), material: Id.nullish().transform((value) => value ?? undefined) })).min(1),
  curtain: z.boolean().default(false),
});

export const RevitOpeningSchema = z.object({
  id: Id,
  kind: z.enum(['door', 'window']),
  name: z.string().max(120).default(''),
  wall: Id,
  /** Along the wall's polyline from its first point (mm). */
  start: Num,
  end: Num,
  height: z.number().positive(),
  /** Absolute elevation of the opening's bottom. */
  bottom: Num,
  handing: z.enum(['left', 'right']).default('left'),
  side: z.enum(['inside', 'outside']).default('inside'),
});

export const RevitSlabSchema = z.object({
  id: Id,
  kind: z.enum(['floor', 'ceiling']),
  name: z.string().max(120).default(''),
  level: LevelRef,
  outline: Polygon,
  holes: z.array(Polygon).default([]),
  /** Absolute bottom elevation and thickness (mm). */
  bottom: Num,
  thickness: z.number().positive(),
  material: Id.nullish().transform((value) => value ?? undefined),
});

export const RevitColumnSchema = z.object({
  id: Id,
  name: z.string().max(120).default('Column'),
  level: LevelRef,
  /** Plan centre. */
  x: Num,
  y: Num,
  width: z.number().positive(),
  depth: z.number().positive(),
  round: z.boolean().default(false),
  /** Degrees, clockwise on the board. */
  rotation: Num.default(0),
  base: Num,
  height: z.number().positive(),
  material: Id.nullish().transform((value) => value ?? undefined),
});

export const RevitRailingSchema = z.object({ id: Id, name: z.string().max(120).default('Railing'), level: LevelRef, points: z.array(Point).min(2), base: Num, height: z.number().positive() });

export const RevitRoomSchema = z.object({ id: Id, name: z.string().max(120).default('Room'), number: z.string().max(40).default(''), level: LevelRef, outline: Polygon });

export const RevitMeshSchema = z.object({
  id: Id,
  name: z.string().max(120).default(''),
  category: z.string().max(80).default(''),
  level: LevelRef,
  /** Plan corner (min x, min y) and base elevation the mesh's coordinates are relative to. */
  origin: z.tuple([Num, Num, Num]),
  /** Plan extent (x, y) and height. */
  size: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
  /** Binary glTF, base64; vertices in mm as (x, elevation, y) relative to `origin`. */
  glb: z.string().min(1),
});

export const RevitExchangeSchema = z.object({
  archaiRevit: z.literal(1),
  /** The app that wrote it (the plugins other than Revit say which). */
  app: z.string().max(60).default(''),
  name: z.string().max(200).default('Revit model'),
  source: z.string().max(1000).default(''),
  revitVersion: z.string().max(40).default(''),
  materials: z.array(RevitMaterialSchema).default([]),
  levels: z.array(RevitLevelSchema).default([]),
  walls: z.array(RevitWallSchema).default([]),
  openings: z.array(RevitOpeningSchema).default([]),
  slabs: z.array(RevitSlabSchema).default([]),
  columns: z.array(RevitColumnSchema).default([]),
  railings: z.array(RevitRailingSchema).default([]),
  rooms: z.array(RevitRoomSchema).default([]),
  meshes: z.array(RevitMeshSchema).default([]),
});
export type RevitExchange = z.infer<typeof RevitExchangeSchema>;

/** Whether parsed JSON is a Revit exchange file (before validating it). */
export function isRevitExchange(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>)['archaiRevit'] !== undefined);
}
