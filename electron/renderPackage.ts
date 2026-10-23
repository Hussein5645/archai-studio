import { createHash } from 'node:crypto';
import { unzip } from 'fflate';
import { z } from 'zod';
import { RenderLightsSchema } from '../shared/renderLights.js';

const Vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const RenderSchema = z.object({ format: z.literal('archai-render-document'), version: z.literal(1), projectId: z.string().min(1).max(64),
  settings: z.object({ lights: RenderLightsSchema, sky: z.enum(['sun', 'hdri']), sunEnabled: z.boolean(), sunIntensity: z.number().min(0).max(10),
    skyIntensity: z.number().min(0).max(5), altitude: z.number().min(-10).max(90), azimuth: z.number().finite(),
    exposure: z.number().min(-4).max(4), exposureMode: z.enum(['auto', 'manual']).default('auto'), bloom: z.number().min(0).max(2).default(0.1), ambientOcclusion: z.number().min(0).max(2).default(1), bakedPreview: z.boolean().default(false), entourage: z.array(z.unknown()).max(2000) }),
  camera: z.object({ position: Vector, target: Vector, fov: z.number().min(10).max(120).optional() }).nullable(),
  sunDirection: Vector.optional(),
});
const Resource = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() });
const ManifestSchema = z.object({ format: z.literal('archai-scene'), version: z.literal(1), projectId: z.string().min(1).max(64),
  model: Resource.extend({ path: z.literal('scene.glb') }), renderDocument: Resource.extend({ path: z.literal('render.json') }),
});

export async function readRenderPackage(bytes: Uint8Array) {
  const allowed = new Set(['manifest.json', 'render.json', 'scene.glb']);
  let expanded = 0;
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    try {
      unzip(bytes, { filter: (entry) => {
        expanded += entry.originalSize;
        if (!allowed.has(entry.name) || expanded > 1024 * 1024 * 1024) throw new Error('Invalid scene archive contents or size');
        return true;
      } }, (error, result) => error ? reject(error) : resolve(result));
    } catch (error) { reject(error); }
  });
  const parse = (name: string) => {
    const entry = files[name];
    if (!entry || entry.byteLength > 4 * 1024 * 1024) throw new Error(`Missing or oversized ${name}`);
    return JSON.parse(new TextDecoder().decode(entry)) as unknown;
  };
  const manifest = ManifestSchema.parse(parse('manifest.json'));
  const render = RenderSchema.parse(parse('render.json'));
  if (render.projectId !== manifest.projectId) throw new Error('Scene project mismatch');
  for (const resource of [manifest.model, manifest.renderDocument]) {
    const data = files[resource.path];
    if (!data || data.byteLength !== resource.bytes || createHash('sha256').update(data).digest('hex') !== resource.sha256)
      throw new Error('Scene integrity check failed');
  }
  const model = files['scene.glb']!;
  const header = new DataView(model.buffer, model.byteOffset, model.byteLength);
  if (model.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== model.byteLength)
    throw new Error('Invalid binary glTF scene');
  if (render.settings.sky === 'hdri') throw new Error('The Unreal preview currently supports Sun & sky. HDRI transfer is not available yet.');
  if (render.settings.entourage.length) throw new Error('Move legacy Render placements onto the Board before opening the Unreal preview.');
  return { projectId: manifest.projectId, model, modelHash: manifest.model.sha256, settings: render.settings, camera: render.camera, sunDirection: render.sunDirection };
}
