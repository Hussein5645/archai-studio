import { z } from 'zod';

export const UnrealUpdateInput = z.object({ bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 512 * 1024 * 1024, 'Scene package exceeds 512 MB') });
export const ExperienceOptionsSchema = z.object({
  delivery: z.enum(['unreal', 'webxr', 'baked-unreal']), sourceRenderer: z.enum(['default', 'unreal', 'baked']),
  lighting: z.enum(['realtime', 'baked']), style: z.string().max(80), bakeStatus: z.enum(['none', 'current', 'outdated']),
  bakedOutput: z.string().max(2048).optional(), elements: z.array(z.string().max(128)).max(200_000).nullable().optional(),
});
export type ExperienceOptions = z.infer<typeof ExperienceOptionsSchema>;
export const UnrealExportInput = UnrealUpdateInput.extend({ options: ExperienceOptionsSchema.optional() });
export const UnrealImageOptionsSchema = z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(7680), quality: z.enum(['standard', 'high']).default('high') });
export type UnrealImageOptions = z.infer<typeof UnrealImageOptionsSchema>;
export const UnrealCommandInput = z.object({ action: z.enum(['frame', 'image']), options: UnrealImageOptionsSchema.optional() });
export const UnrealViewportInput = z.object({ x: z.number().int().min(0).max(32768), y: z.number().int().min(0).max(32768),
  width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384), visible: z.boolean(), placementTool: z.string().max(80).default(''),
  navigationLocked: z.boolean().default(false), panTool: z.boolean().default(false),
  exclusions: z.array(z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() })).max(64).default([]) });
export type UnrealViewport = z.input<typeof UnrealViewportInput>;
export const UnrealPlacementSchema = z.object({ sequence: z.number().int().positive(), tool: z.string().max(80), action: z.enum(['place', 'finish', 'cancel']), point: z.object({ x: z.number().finite(), y: z.number().finite(), elevation: z.number().finite(), heading: z.number().finite() }).nullable() });
export const UnrealCameraSchema = z.object({ position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), fov: z.number().min(10).max(120).optional() });
export const UnrealStatusSchema = z.object({
  available: z.boolean(),
  state: z.enum(['unavailable', 'idle', 'starting', 'loading', 'ready', 'error', 'closed']),
  projectId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  meshActors: z.number().int().nonnegative().default(0),
  error: z.string().nullable(),
  embedded: z.boolean().default(false),
  customLights: z.number().int().nonnegative().optional(),
  bakeAvailable: z.boolean().default(false),
  viewCamera: UnrealCameraSchema.optional(),
  placements: z.array(UnrealPlacementSchema).max(64).optional(),
  selectedObject: z.string().optional(), selectionSequence: z.number().int().nonnegative().optional(),
  lookRevision: z.number().int().nonnegative().optional(),
  exposure: z.number().min(-4).max(4).optional(),
  stage: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  liveBridge: z.boolean().optional(),
  meshesBuilt: z.number().int().nonnegative().optional(),
  sceneImports: z.number().int().nonnegative().optional(),
  bake: z.object({ state: z.enum(['running', 'ready', 'error']), stage: z.string(), output: z.string().optional(), error: z.string().optional() }).optional(),
});
export type UnrealStatus = z.infer<typeof UnrealStatusSchema>;

export const UnrealBakeStartInput = UnrealUpdateInput;
export const UnrealBakeStatusInput = z.object({ id: z.uuid() });
export type UnrealBakeJob = { id: string; state: 'running' | 'ready' | 'error'; stage: string; output?: string; error?: string };
