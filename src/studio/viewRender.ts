import { renderLightsOf } from '@/document/renderLight';
import { z } from 'zod';
import type { ArchaiDocument } from '@/document';
import { RenderSettingsSchema, defaultSettings, type RenderSettings } from './settings';
import { preparationSignature } from './vrPreparation';

export const ViewBakeSchema = z.object({
  signature: z.string(),
  createdAt: z.string(),
  output: z.string(),
  cacheId: z.string(),
  vertices: z.number(),
  triangles: z.number(),
  lightScale: z.number(),
  jobId: z.string().optional(),
  webError: z.string().optional(),
});
export type ViewBake = z.infer<typeof ViewBakeSchema>;
export type ViewRenderer = 'default' | 'unreal' | 'baked';
export function renderOf(doc: ArchaiDocument, id: string | null) {
  const value = (id ? doc.elements[id]?.meta?.['view3d'] : null) as Record<string, unknown> | null;
  const parsed = RenderSettingsSchema.safeParse(value?.['renderSettings']);
  const bake = ViewBakeSchema.safeParse(value?.['bake']);
  const renderer: ViewRenderer =
    value?.['renderer'] === 'unreal'
      ? 'unreal'
      : value?.['renderer'] === 'baked' && bake.success
        ? 'baked'
        : 'default';
  return {
    renderer,
    settings: parsed.success ? parsed.data : defaultSettings(),
    bake: bake.success ? bake.data : null,
  };
}
const normalized = new WeakMap<ArchaiDocument, ArchaiDocument>();
/** Presentation metadata and camera moves do not change a scene's lighting bake. */
export function viewBakeSignature(doc: ArchaiDocument, settings: RenderSettings) {
  let scene = normalized.get(doc);
  if (!scene) {
    const elements = Object.fromEntries(
      Object.entries(doc.elements)
        .filter(([, e]) => !e.meta?.['view3d'] && !e.meta?.['cameraMarker'] && !e.meta?.['viewRig'])
        .map(([id, e]) => {
          const meta = { ...e.meta };
          delete meta['visibilityByContext'];
          return [id, { ...e, meta }];
        }),
    );
    scene = {
      ...doc,
      elements,
      workspace: { ...doc.workspace, viewStyle: 'realistic', lod: 'high' },
    };
    normalized.set(doc, scene);
  }
  const lights = new Map([...settings.lights, ...renderLightsOf(doc)].map((light) => [light.id, light]));
  // Earlier bakes merged elements by material and cannot support individual element selection.
  return 'view-bake-v3:' + preparationSignature(scene, { ...settings, exposure: 0, exposureMode: 'manual', bloom: 0.1, ambientOcclusion: 1, lights: [...lights.values()] }, 'balanced');
}

export const lightToolEvent = 'archai:add-render-light';
