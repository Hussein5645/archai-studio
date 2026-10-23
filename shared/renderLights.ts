import { z } from 'zod';
export const RenderLightSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().min(1).max(80), kind: z.enum(['point', 'spot', 'area']),
  enabled: z.boolean().default(true), color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#fff0d0'),
  intensity: z.number().min(0).max(1_000_000).default(3000),
  position: z.tuple([z.number().min(-10000).max(10000), z.number().min(-10000).max(10000), z.number().min(-10000).max(10000)]),
  yaw: z.number().min(-360).max(360).default(0), tilt: z.number().min(-90).max(90).default(-90),
  radius: z.number().min(0.1).max(1000).default(10), size: z.number().min(0.01).max(100).default(1),
  height: z.number().min(0.01).max(100).optional(),
  innerCone: z.number().min(0).max(85).optional(), outerCone: z.number().min(1).max(89).optional(),
});
export type RenderLight = z.infer<typeof RenderLightSchema>;
export const RenderLightsSchema = z.array(RenderLightSchema).max(64).default([]);
