import { z } from 'zod';
import type { CameraState } from '@/view3d/SceneView';

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const CameraSchema = z.object({ position: vector, target: vector, fov: z.number().min(10).max(120).optional() });
export const cameraKey = (projectId: string) => `render-camera:${projectId}`;
export function parseCamera(text: string | null): CameraState | null {
  if (!text) return null;
  try {
    const result = CameraSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch { return null; }
}
