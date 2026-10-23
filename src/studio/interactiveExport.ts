import { account } from '@/cloud/account';
import { openAccountDialog } from '@/ui/account-dialog';
import type { ArchaiDocument } from '@/document';
import type { ViewStyle } from '@/view3d/SceneView';
import { viewSettingsOf } from '@/view3d/useSceneView';
import { renderOf, viewBakeSignature, type ViewRenderer } from './viewRender';
import type { Platform } from '@/platform/types';
import type { AssetCatalog } from '@/catalog';
import type { CameraState } from '@/view3d/SceneView';
import type { Object3D } from 'three';
import { exportScope } from './exportScope';
import { renderLightsOf } from '@/document/renderLight';
import { createScenePackage } from './scenePackage';
import type { ExperienceOptions } from '@shared/unrealRuntime';

export type InteractiveOutput = {
  destination: 'folder' | 'link'; lighting: 'realtime' | 'baked'; renderer: ViewRenderer;
  style: ViewStyle; signature: string;
};
export function interactiveSource(doc: ArchaiDocument, portalId: string | null) {
  const render = renderOf(doc, portalId);
  const signature = viewBakeSignature(doc, render.settings);
  const current = Boolean(render.bake && render.bake.signature === signature);
  return { ...render, signature, current, webReady: current && Boolean(render.bake?.cacheId) && !render.bake?.webError,
    style: viewSettingsOf(doc, portalId).style ?? doc.workspace.viewStyle };
}
export function validateInteractiveSource(doc: ArchaiDocument, portalId: string | null, output: InteractiveOutput) {
  const source = interactiveSource(doc, portalId);
  if (source.signature !== output.signature || source.renderer !== output.renderer || source.style !== output.style)
    throw new Error('This view changed after export settings opened. Close and reopen the export settings.');
  if (output.lighting === 'baked' && (!source.current || output.destination === 'link' && !source.webReady))
    throw new Error('A current bake is required for this output. Rebake or choose real-time lighting.');
  return source;
}

export async function interactiveModel(platform: Platform, catalog: AssetCatalog, doc: ArchaiDocument, portalId: string | null,
  ids: string[] | null, output: InteractiveOutput) {
  const source = validateInteractiveSource(doc, portalId, output);
  const include = ids ? exportScope(doc, ids) : undefined;
  if (output.lighting === 'baked') {
    const { loadPreparation } = await import('./preparationCache');
    const saved = source.bake && await loadPreparation(platform.storage, source.bake.cacheId, 'baked');
    if (!saved) throw new Error('Saved browser bake data is unavailable. Choose real-time lighting or rebake.');
    const [{ GLTFLoader }, { GLTFExporter }, { exportAppearance }, THREE] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/exporters/GLTFExporter.js'), import('@/view3d/exportAppearance'), import('three'),
    ]);
    const root = (await new GLTFLoader().parseAsync(saved.bytes, '')).scene;
    const remove: Object3D[] = [];
    if (include) root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      let owner: Object3D | null = object;
      while (owner && !owner.userData['archai']?.id) owner = owner.parent;
      if (owner && !include(owner.userData['archai'].id)) remove.push(object);
    });
    const restore = exportAppearance(root, output.style, 'm');
    try {
      remove.forEach(object => object.removeFromParent());
      const model = await new GLTFExporter().parseAsync(root, { binary: true });
      if (!(model instanceof ArrayBuffer)) throw new Error('Could not prepare the baked model');
      return { model, source, lightScale: source.bake!.lightScale };
    } finally {
      restore(); remove.forEach(object => root.add(object));
      root.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); for (const m of Array.isArray(object.material) ? object.material : [object.material]) { for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose(); m.dispose(); } } });
    }
  }
  const { exportVrModel, exportSceneSnapshot } = await import('@/view3d/vrExport');
  const model = output.destination === 'link' || source.renderer === 'default'
    ? await exportVrModel(doc, catalog, { include, style: output.style })
    : await exportSceneSnapshot(doc, catalog, { include, style: output.style, stableMeshNames: true, maxTextureSize: 4096 });
  return { model, source, lightScale: 1 };
}

/** All folder outputs record the exact source renderer, style and lighting choice. */
export async function exportInteractiveFolder(platform: Platform, catalog: AssetCatalog, doc: ArchaiDocument, portalId: string | null,
  ids: string[] | null, output: InteractiveOutput, camera?: CameraState) {
  if (account().state().status !== 'signed-in' && (output.renderer !== 'default' || output.destination !== 'folder' || output.lighting !== 'realtime')) {
    openAccountDialog('sign-in', 'Sign in for Unreal and VR exports');
    throw new Error('Sign in for this export. Guests can export Default views as interactive desktop folders.');
  }
  if (!platform.unreal) throw new Error('Folder export requires the Archai desktop app.');
  const source = validateInteractiveSource(doc, portalId, output);
  const nativeBake = source.renderer !== 'default' && output.lighting === 'baked';
  let model: ArrayBuffer;
  if (nativeBake) {
    // The host copies the verified cooked bake, so no full geometry export is needed here.
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}');
    const length = Math.ceil(json.length / 4) * 4;
    const bytes = new Uint8Array(20 + length); bytes.fill(32, 20); bytes.set(json, 20);
    const header = new DataView(bytes.buffer); header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true); header.setUint32(12, length, true); header.setUint32(16, 0x4e4f534a, true);
    model = bytes.buffer;
  } else model = (await interactiveModel(platform, catalog, doc, portalId, ids, output)).model;
  const packaged = await createScenePackage(doc, { ...source.settings, lights: [...source.settings.lights, ...renderLightsOf(doc)] }, model, camera);
  const include = ids ? exportScope(doc, ids) : null;
  const options: ExperienceOptions = { delivery: nativeBake ? 'baked-unreal' : source.renderer === 'default' ? 'webxr' : 'unreal',
    sourceRenderer: source.renderer, lighting: output.lighting, style: output.style,
    bakeStatus: source.current ? 'current' : source.bake ? 'outdated' : 'none',
    ...(nativeBake ? { bakedOutput: source.bake!.output } : {}), elements: include ? Object.keys(doc.elements).filter(include) : null };
  return platform.unreal.exportScene(packaged.bytes, options);
}
