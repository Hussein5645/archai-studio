/**
 * ArchAI Render settings of one document: lighting, camera and the entourage placed in the
 * studio. Kept per document in platform storage (`render:<doc id>`), not in the document: they
 * describe how to render it, the way D5 or Twinmotion keep their own scene files.
 */
import { z } from 'zod';
import { RenderLightsSchema } from '@shared/renderLights';

export const EntourageItemSchema = z.object({
  id: z.string().min(1).max(40),
  asset: z.string().min(1).max(80),
  /** Metres, scene axes (x, up, board y). */
  position: z.tuple([z.number(), z.number(), z.number()]),
  /** Radians about the vertical axis. */
  rotation: z.number().default(0),
  scale: z.number().positive().max(100).default(1),
});
export type EntourageItem = z.infer<typeof EntourageItemSchema>;

export const GROUNDS = { grass: '#5d7a3e', concrete: '#a9a8a3', asphalt: '#3d3f42', sand: '#cdb894', white: '#f2f2ef', none: '' } as const;
export type Ground = keyof typeof GROUNDS;

export const RenderSettingsSchema = z.object({
  lights: RenderLightsSchema,
  sky: z.enum(['sun', 'hdri']).default('sun'),
  hdri: z.string().max(80).default('kloofendal_48d_partly_cloudy_puresky'),
  /** Degrees. */
  hdriRotation: z.number().default(0),
  skyIntensity: z.number().min(0).max(5).default(1),
  /** Sun from a date and time at the site, or set by hand. */
  sunMode: z.enum(['time', 'manual']).default('time'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-06-21'),
  /** Hours, local time. */
  time: z.number().min(0).max(24).default(15),
  latitude: z.number().min(-90).max(90).default(51.5074),
  longitude: z.number().min(-180).max(180).default(-0.1278),
  utcOffset: z.number().min(-14).max(14).default(0),
  /** Degrees clockwise from the board's up to true north. */
  northAngle: z.number().default(0),
  /** Manual sun, degrees: compass bearing and height above the horizon. */
  azimuth: z.number().default(220),
  altitude: z.number().min(-10).max(90).default(35),
  sunIntensity: z.number().min(0).max(10).default(3),
  sunEnabled: z.boolean().default(true),
  ground: z.enum(Object.keys(GROUNDS) as [Ground, ...Ground[]]).default('grass'),
  toneMapping: z.enum(['agx', 'aces', 'neutral']).default('agx'),
  exposure: z.number().min(-4).max(4).default(0),
  exposureMode: z.enum(['auto', 'manual']).default('auto'),
  ambientOcclusion: z.number().min(0).max(2).default(1),
  bloom: z.number().min(0).max(2).default(0.1),
  /** Vertex-lit preview assets already contain illumination. */
  bakedPreview: z.boolean().default(false),
  /** Degrees, vertical. */
  fov: z.number().min(10).max(120).default(55),
  depthOfField: z.boolean().default(false),
  /** Metres. */
  focusDistance: z.number().positive().default(10),
  fStop: z.number().min(0.7).max(32).default(5.6),
  bounces: z.number().int().min(1).max(16).default(6),
  entourage: z.array(EntourageItemSchema).max(2000).default([]),
});
export type RenderSettings = z.infer<typeof RenderSettingsSchema>;

export const defaultSettings = (): RenderSettings => RenderSettingsSchema.parse({});

export const settingsKey = (docId: string) => `render:${docId}`;

export function parseSettings(text: string | null): RenderSettings {
  if (!text) return defaultSettings();
  try {
    const parsed = RenderSettingsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : defaultSettings();
  } catch {
    return defaultSettings();
  }
}
