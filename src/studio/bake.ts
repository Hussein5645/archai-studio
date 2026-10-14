import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { prepareBakeGeometry } from './bakeGeometry';
import type { BakeInput } from './bakeTrace';
import { throwIfCancelled, VR_QUALITY, type VrQuality } from './vrPreparation';

export interface BakedScene {
  root: THREE.Group;
  model: ArrayBuffer;
  vertices: number;
  triangles: number;
  lightScale: number;
  ownsTextures?: boolean;
}

export async function restoreBake(
  model: ArrayBuffer,
  metadata: Pick<BakedScene, 'vertices' | 'triangles' | 'lightScale'>,
): Promise<BakedScene> {
  const gltf = await new GLTFLoader().parseAsync(model, '');
  const root = gltf.scene;
  root.userData['bakeScale'] = metadata.lightScale;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material.userData['vrBackground']) material.toneMapped = false;
  });
  return { root, model, ...metadata, ownsTextures: true };
}

export function disposeBake(bake: BakedScene): void {
  bake.root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (bake.ownsTextures) {
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture) value.dispose();
        } else if (material.userData['vrBackground'])
          (material as THREE.MeshBasicMaterial).map?.dispose();
        material.dispose();
      }
    }
  });
}

export async function bakeScene(
  source: THREE.Object3D,
  lighting: Pick<BakeInput, 'environment' | 'sun' | 'sunIntensity' | 'skyIntensity'>,
  quality: VrQuality,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
  background?: THREE.Texture,
): Promise<BakedScene> {
  throwIfCancelled(signal);
  const preset = VR_QUALITY[quality];
  const root = prepareBakeGeometry(source, preset.edge, preset.triangles);
  const meshes = root.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>[];
  const vertices = meshes.reduce(
    (count, mesh) => count + mesh.geometry.getAttribute('position').count,
    0,
  );
  if (!vertices) throw new Error('The scene has no surfaces to bake');
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3);
  const triangles: number[] = [],
    albedos: number[] = [],
    emission: number[] = [];
  let offset = 0,
    triangleCount = 0;
  for (const mesh of meshes) {
    const p = mesh.geometry.getAttribute('position'),
      n = mesh.geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      positions.set([p.getX(i), p.getY(i), p.getZ(i)], offset + i * 3);
      normals.set([n.getX(i), n.getY(i), n.getZ(i)], offset + i * 3);
    }
    offset += p.count * 3;
    const index = mesh.geometry.index!;
    triangleCount += index.count / 3;
    const material = mesh.material;
    // Glass and cutout foliage cannot be treated as opaque blockers by the diffuse baker.
    if (
      material.transparent ||
      material.opacity < 1 ||
      material.transmission > 0 ||
      material.alphaTest > 0
    )
      continue;
    for (let i = 0; i < index.count; i += 3) {
      for (let j = 0; j < 3; j++) {
        const v = index.getX(i + j);
        triangles.push(p.getX(v), p.getY(v), p.getZ(v));
      }
      const c = material.color ?? new THREE.Color(1, 1, 1);
      albedos.push(Math.min(c.r, 0.95), Math.min(c.g, 0.95), Math.min(c.b, 0.95));
      const e = (material.emissive ?? new THREE.Color(0, 0, 0))
        .clone()
        .multiplyScalar(material.emissiveIntensity ?? 1);
      emission.push(e.r, e.g, e.b);
    }
  }
  let prepared: BakedScene | null = null;
  try {
    throwIfCancelled(signal);
    const input: BakeInput = {
      positions,
      normals,
      triangles: new Float32Array(triangles),
      albedos: new Float32Array(albedos),
      emission: new Float32Array(emission),
      ...lighting,
      samples: preset.samples,
      bounces: preset.bounces,
    };
    const colors = await new Promise<Float32Array>((resolve, reject) => {
      const worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
      const cleanup = () => {
        worker.terminate();
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new DOMException('Preparation cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = (
        event: MessageEvent<{ progress?: number; colors?: Float32Array; error?: string }>,
      ) => {
        if (event.data.error) {
          cleanup();
          reject(new Error(event.data.error));
        } else if (event.data.colors) {
          cleanup();
          resolve(event.data.colors);
        } else if (event.data.progress !== undefined) onProgress(event.data.progress * 0.9);
      };
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'Baking failed'));
      };
      const transfers = [
        positions.buffer,
        normals.buffer,
        input.triangles.buffer,
        input.albedos.buffer,
        input.emission.buffer,
      ];
      if (input.environment) transfers.push(input.environment.data.buffer);
      worker.postMessage(input, transfers);
      if (signal.aborted) cancel();
    });
    throwIfCancelled(signal);
    // glTF vertex colours must stay in [0,1]. Recover HDR illumination through
    // exposure in the viewer, before tone mapping, rather than invalid COLOR_0 data.
    let lightScale = 1;
    offset = 0;
    for (const mesh of meshes) {
      const original = mesh.material;
      const oldColors = mesh.geometry.getAttribute('color');
      const baked = new Float32Array(oldColors.count * 3);
      const base = original.color ?? new THREE.Color(1, 1, 1);
      const emissive = (original.emissive ?? new THREE.Color(0, 0, 0))
        .clone()
        .multiplyScalar(original.emissiveIntensity ?? 1);
      for (let i = 0; i < oldColors.count; i++) {
        baked[i * 3] = (colors[offset + i * 3] ?? 0) * oldColors.getX(i) * base.r + emissive.r;
        baked[i * 3 + 1] =
          (colors[offset + i * 3 + 1] ?? 0) * oldColors.getY(i) * base.g + emissive.g;
        baked[i * 3 + 2] =
          (colors[offset + i * 3 + 2] ?? 0) * oldColors.getZ(i) * base.b + emissive.b;
        lightScale = Math.max(lightScale, baked[i * 3]!, baked[i * 3 + 1]!, baked[i * 3 + 2]!);
      }
      offset += oldColors.count * 3;
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(baked, 3));
      const glass = original.transmission > 0;
      const material = new THREE.MeshBasicMaterial({
        map: original.map ?? null,
        alphaMap: original.alphaMap ?? null,
        color: 0xffffff,
        vertexColors: true,
        side: original.side === THREE.DoubleSide ? THREE.FrontSide : original.side,
        transparent: original.transparent || glass,
        opacity: glass ? 0.2 : original.opacity,
        alphaTest: original.alphaTest,
        depthWrite: !(original.transparent || glass),
      });
      material.name = original.name;
      material.userData = { archaiBaked: true };
      mesh.material = material as unknown as THREE.MeshPhysicalMaterial;
      mesh.geometry.deleteAttribute('normal');
    }
    for (const mesh of meshes) {
      const colors = mesh.geometry.getAttribute('color');
      for (let i = 0; i < colors.count; i++)
        colors.setXYZ(
          i,
          colors.getX(i) / lightScale,
          colors.getY(i) / lightScale,
          colors.getZ(i) / lightScale,
        );
    }
    root.userData['bakeScale'] = lightScale;
    if (background) {
      const bounds = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
      const geometry = new THREE.SphereGeometry(Math.max(200, bounds.radius * 8), 64, 32);
      geometry.scale(-1, 1, 1);
      geometry.rotateY(Math.PI);
      const material = new THREE.MeshBasicMaterial({ map: background, toneMapped: false });
      material.userData = { archaiBaked: true, vrBackground: true };
      const sky = new THREE.Mesh(geometry, material);
      sky.name = 'Prepared sky';
      sky.position.copy(bounds.center);
      sky.userData['vrBackground'] = true;
      root.add(sky);
    }
    onProgress(0.92);
    const model = await new GLTFExporter().parseAsync(root, {
      binary: true,
      onlyVisible: true,
      maxTextureSize: preset.textureSize,
    });
    throwIfCancelled(signal);
    if (!(model instanceof ArrayBuffer)) throw new Error('The baked scene could not be exported');
    if (model.byteLength > 95 * 1024 * 1024)
      throw new Error('The baked model exceeds 95 MB. Use Fast quality or reduce project detail.');
    prepared = { root, model, vertices, triangles: triangleCount, lightScale };
    onProgress(1);
    return prepared;
  } finally {
    if (!prepared) {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if ((object.material as THREE.Material).userData['archaiBaked']) {
            if ((object.material as THREE.Material).userData['vrBackground'])
              (object.material as THREE.MeshBasicMaterial).map?.dispose();
            (object.material as THREE.Material).dispose();
          }
        }
      });
    }
    if (!prepared && background) background.dispose();
  }
}
