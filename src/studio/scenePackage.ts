import { strToU8, zip } from 'fflate';
import type { ArchaiDocument } from '@/document';
import type { CameraState } from '@/view3d/SceneView';
import { vrTourJson } from '@/view3d/vrTour';
import { RenderSettingsSchema, type RenderSettings } from './settings';
import { localToUtc, sunDirection, sunPosition } from '@/analysis/sun';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Packages one frozen source/visualization pair. No credentials or library URLs are exported. */
export async function createScenePackage(doc: ArchaiDocument, settings: RenderSettings, model: ArrayBuffer, camera?: CameraState) {
  const solar = settings.sunMode === 'time'
    ? sunPosition(localToUtc(settings.date, `${String(Math.floor(settings.time)).padStart(2, '0')}:${String(Math.round((settings.time % 1) * 60) % 60).padStart(2, '0')}`, settings.utcOffset), settings.latitude, settings.longitude)
    : { azimuth: settings.azimuth * Math.PI / 180, altitude: settings.altitude * Math.PI / 180 };
  const render = { format: 'archai-render-document', version: 1, projectId: doc.id,
    settings: RenderSettingsSchema.parse(settings), camera: camera ?? null,
    sunDirection: sunDirection(solar, settings.northAngle) };
  const modelBytes = new Uint8Array(model);
  const renderBytes = strToU8(canonicalJson(render));
  const sourceBytes = strToU8(canonicalJson({ id: doc.id, elements: doc.elements, definitions: doc.definitions,
    materials: doc.materials, blobs: doc.blobs }));
  const [sourceRevision, renderRevision, modelHash] = await Promise.all([
    sha256(sourceBytes), sha256(renderBytes), sha256(modelBytes),
  ]);
  const manifest = {
    format: 'archai-scene', version: 1, projectId: doc.id, name: doc.meta.name,
    sourceRevision, renderRevision,
    coordinates: { gltf: { unit: 'metre', handedness: 'right', up: '+Y', boardY: '+Z' },
      unreal: { unit: 'centimetre', positionFromGltf: ['100*x', '100*z', '100*y'], reverseWinding: true } },
    model: { path: 'scene.glb', sha256: modelHash, bytes: model.byteLength, identity: 'extras.archai.id' },
    renderDocument: { path: 'render.json', sha256: renderRevision, bytes: renderBytes.byteLength },
    objects: Object.values(doc.elements).map((element) => ({ id: element.id, parentId: element.parentId,
      name: element.name ?? '', kind: element.kind, visible: element.visible })),
    materials: doc.materials,
    experience: vrTourJson(doc),
    capabilities: { unrealRuntime: false, cloudStreaming: false, portableModel: true },
    warnings: ['This is an interchange package, not cooked Unreal content.',
      'Unreal lighting, HDRI resources and legacy entourage require preparation before deployment.'],
  };
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'render.json': renderBytes, 'scene.glb': modelBytes };
  const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    // fflate's browser async API uses blob workers, which our CSP deliberately blocks.
    // A bundled module worker keeps compression off the UI thread without relaxing CSP.
    if (typeof Worker === 'undefined') {
      zip(files, { level: 1 }, (error, result) => error ? reject(error) : resolve(result));
      return;
    }
    const worker = new Worker(new URL('./scenePackage.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Scene packaging timed out')); }, 120_000);
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array<ArrayBuffer>; error?: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.bytes) resolve(event.data.bytes);
      else reject(new Error(event.data.error || 'Scene packaging failed'));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error('Could not start the scene packaging worker'));
    };
    worker.postMessage(files);
  });
  return { bytes, manifest, sunDirection: render.sunDirection };
}
