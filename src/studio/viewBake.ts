import { renderLightsOf } from '@/document/renderLight';
import type { Mesh, Group } from 'three';
import type { ArchaiDocument } from '@/document';
import type { AssetCatalog } from '@/catalog/types';
import type { Platform } from '@/platform/types';
import type { CameraState } from '@/view3d/SceneView';
import type { RenderSettings } from './settings';
import { createScenePackage } from './scenePackage';
import { savePreparation } from './preparationCache';
import { viewBakeSignature, type ViewBake } from './viewRender';

export const pendingBakeKey = (docId: string, viewId: string) => `view-bake-job:${docId}:${viewId}`;
export type PendingViewBake = Omit<ViewBake, 'output' | 'createdAt'> & { jobId: string };

/** A browser derivative and a genuine Unreal Lightmass build are separate artifacts. */
export async function startViewBake(
  platform: Platform,
  catalog: AssetCatalog,
  doc: ArchaiDocument,
  portalId: string,
  settings: RenderSettings,
  camera: CameraState | undefined,
  progress: (stage: string) => void,
): Promise<PendingViewBake> {
  settings = { ...settings, lights: [...settings.lights, ...renderLightsOf(doc)] };
  if (!platform.unreal?.bakeStart) throw new Error('The local Unreal build worker is unavailable.');
  const [{ exportSceneSnapshot }, { GLTFLoader }, { bakeScene, disposeBake }] = await Promise.all([
    import('@/view3d/vrExport'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('./bake'),
  ]);
  progress('Preparing the scene');
  const model = await exportSceneSnapshot(doc, catalog, {
    maxTextureSize: 2048,
    stableMeshNames: true,
  });
  const packaged = await createScenePackage(doc, settings, model, camera);
  const signature = viewBakeSignature(doc, settings);
  progress('Starting Unreal Lightmass on this computer');
  const job = await platform.unreal.bakeStart(packaged.bytes);
  let pending: PendingViewBake = { signature, cacheId: '', vertices: 0, triangles: 0, lightScale: 1, jobId: job.id,
    webError: 'Browser preparation has not completed. The Unreal bake is running independently.' };
  const persist = () => platform.storage.set(pendingBakeKey(doc.id, portalId), JSON.stringify(pending));
  await persist();
  let scene: Group | null = null;
  try {
    if (model.byteLength > 256 * 1024 * 1024) throw new Error('This model is too large for an in-memory browser lighting bake. The native Unreal bake continues; use a real-time WebXR link or export a smaller area for baked WebXR.');
    scene = (await new GLTFLoader().parseAsync(model, '')).scene;
    const cacheId = doc.id + ':' + portalId + ':' + crypto.randomUUID();
    const bake = await bakeScene(scene, { environment: null, sun: packaged.sunDirection,
      sunIntensity: settings.sunEnabled ? settings.sunIntensity : 0, skyIntensity: settings.skyIntensity, lights: settings.lights },
      'balanced', new AbortController().signal,
      fraction => progress('Preparing the WebXR version · ' + Math.round(fraction * 100) + '%'));
    try {
      await savePreparation(platform.storage, { docId: cacheId, output: 'baked', signature,
        vertices: bake.vertices, triangles: bake.triangles, lightScale: bake.lightScale }, bake.model);
      pending = { signature, cacheId, vertices: bake.vertices, triangles: bake.triangles, lightScale: bake.lightScale, jobId: job.id };
    } finally { disposeBake(bake); }
  } catch (reason) {
    pending = { ...pending, webError: reason instanceof Error ? reason.message : String(reason) };
    progress('Unreal bake running · browser preparation unavailable');
  } finally {
    scene?.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    });
  }
  await persist();
  return pending;
}
