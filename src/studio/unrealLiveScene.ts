import * as THREE from 'three';
import type { ArchaiDocument } from '@/document';
import type { AssetCatalog } from '@/catalog';
import type { CameraState, ViewStyle } from '@/view3d/SceneView';
import { buildSurfaces } from '@/view3d/vrExport';
import { exportAppearance } from '@/view3d/exportAppearance';
import { renderLightsOf } from '@/document/renderLight';
import { localToUtc, sunDirection, sunPosition } from '@/analysis/sun';
import type { LiveMaterial, LiveNode, UnrealLiveScene } from '@shared/unrealLive';
import type { RenderSettings } from './settings';
import type { Platform } from '@/platform/types';
import { LiveNodeSchema } from '@shared/unrealLive';

const retained = new Map<string, UnrealLiveSceneBuilder>();
export function retainedLiveBuilder(project: string, view: string, storage: Platform['storage']) {
  const key = project + ':' + view;
  let builder = retained.get(key);
  if (!builder) builder = new UnrealLiveSceneBuilder(storage, `unreal-prepared-v1:${key}`);
  retained.delete(key); retained.set(key, builder);
  // Retain one complete CPU scene; Unreal retains the active GPU scene independently.
  while (retained.size > 1) retained.delete(retained.keys().next().value!);
  return builder;
}

type Asset = UnrealLiveScene['assets'][number];
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Geometry-only identity: a light, camera or exposure edit never rebuilds surfaces. */
const objectIds=new WeakMap<object,number>();let nextObjectId=0;
const objectId=(value:object)=>{let id=objectIds.get(value);if(id===undefined){id=++nextObjectId;objectIds.set(value,id);}return id;};
const geometryElements=(doc:ArchaiDocument)=>Object.values(doc.elements).filter(e=>!e.meta?.['view3d']&&!e.meta?.['cameraMarker']&&!e.meta?.['viewRig']&&!e.meta?.['renderLight']);
export function liveGeometryKey(doc: ArchaiDocument, style: ViewStyle): string {
  // Documents are immutable. Identity checks keep camera/light sliders independent of blob size.
  return JSON.stringify([doc.id,style,geometryElements(doc).map(objectId),objectId(doc.definitions),objectId(doc.materials),objectId(doc.blobs)]);
}
const persistentGeometryKey=(doc:ArchaiDocument,style:ViewStyle)=>JSON.stringify([doc.id,style,geometryElements(doc),doc.definitions,doc.materials,doc.blobs]);

function* encodeLiveMeshSteps(geometry: THREE.BufferGeometry, start: number, count: number, uvOffset = new THREE.Vector2()): Generator<void,Uint8Array<ArrayBuffer>> {
  const source = geometry.getAttribute('normal') ? geometry : geometry.clone();
  if (source !== geometry) source.computeVertexNormals();
  try {
    const p = source.getAttribute('position'), n = source.getAttribute('normal');
    const uv = source.getAttribute('uv'), color = source.getAttribute('color');
    const used: number[] = [], remap = new Map<number, number>(), corners = new Uint32Array(count);
    const dense = count>65536 && p.count<=count*2 ? new Uint32Array(p.count).fill(0xffffffff) : null;
    for (let i = 0; i < count; i++) {
      const index = source.index?.getX(start + i) ?? start + i;
      let mapped=dense?dense[index]!:remap.get(index);
      if(mapped===undefined||mapped===0xffffffff){mapped=used.length;if(dense)dense[index]=mapped;else remap.set(index,mapped);used.push(index);}
      corners[i]=mapped;
      if((i&65535)===65535)yield;
    }
    const bytes = new Uint8Array(16 + used.length * 48 + count * 4);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 0x314d4341, true); header.setUint32(4, used.length, true); header.setUint32(8, count, true);
    const vertices = new Float32Array(bytes.buffer, 16, used.length * 12);
    for (let output = 0; output < used.length; output++) {
      const i = used[output]!;
      vertices.set([p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i),
        (uv?.getX(i) ?? 0) - uvOffset.x, (uv?.getY(i) ?? 0) - uvOffset.y, color?.getX(i) ?? 1, color?.getY(i) ?? 1,
        color?.getZ(i) ?? 1, color && color.itemSize > 3 ? color.getW(i) : 1], output * 12);
      if((output&65535)===65535)yield;
    }
    const indices = new Uint32Array(bytes.buffer, 16 + used.length * 48, count);
    indices.set(corners);
    return bytes;
  } finally { if (source !== geometry) source.dispose(); }
}
export function encodeLiveMesh(...args:Parameters<typeof encodeLiveMeshSteps>):Uint8Array<ArrayBuffer>{
  const steps=encodeLiveMeshSteps(...args);let step=steps.next();while(!step.done)step=steps.next();return step.value;
}
async function encodeLiveMeshAsync(...args:Parameters<typeof encodeLiveMeshSteps>):Promise<Uint8Array<ArrayBuffer>>{
  const steps=encodeLiveMeshSteps(...args);let step=steps.next();while(!step.done){await new Promise<void>(resolve=>setTimeout(resolve,0));step=steps.next();}return step.value;
}

/** Reuses binary assets and sends no GLB, archive or Interchange import for live viewing. */
export class UnrealLiveSceneBuilder {
  constructor(private readonly storage?: Platform['storage'], private readonly cacheName = '') {}
  private pendingHash = '';
  private allowRestore = true;
  private work:Promise<unknown>=Promise.resolve();
  private key = '';
  private nodes: LiveNode[] = [];
  private assets = new Map<string, Asset>();
  private uploaded = new Set<string>();
  private geometry = new WeakMap<THREE.BufferGeometry, Map<string, Promise<Asset>>>();
  private textures = new WeakMap<THREE.Texture, { version: number; asset: Promise<Asset> }>();

  resetUploads() { this.uploaded.clear(); }
  acknowledge(scene: UnrealLiveScene) {
    for (const asset of scene.assets) this.uploaded.add(asset.hash);
    if (this.storage && this.pendingHash && scene.nodes===this.nodes) {
      const serialized = JSON.stringify({ geometryHash: this.pendingHash, nodes: scene.nodes });
      this.pendingHash = '';
      void this.storage.set(this.cacheName, serialized).catch(() => undefined);
    }
  }
  invalidateCached() { this.key = ''; this.allowRestore = false; this.resetUploads(); }

  private async texture(texture: THREE.Texture | null | undefined): Promise<LiveMaterial['map']> {
    if (!texture?.image) return null;
    let cached = this.textures.get(texture);
    if (!cached || cached.version !== texture.version) {
      const asset = (async (): Promise<Asset> => {
        const image = texture.image as TexImageSource & { width: number; height: number; data?: ArrayLike<number> };
        const scale = Math.min(1, 4096 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d')!;
        if (texture.flipY) { context.translate(0, canvas.height); context.scale(1, -1); }
        if (image.data) {
          const raw = document.createElement('canvas'); raw.width = image.width; raw.height = image.height;
          const pixels = new ImageData(image.width, image.height), channels = image.data.length / (image.width * image.height);
          const multiplier = texture.type === THREE.FloatType ? 255 : 1;
          for (let i = 0; i < image.width * image.height; i++) for (let c = 0; c < 4; c++)
            pixels.data[i * 4 + c] = c < channels ? image.data[i * channels + c]! * multiplier : c === 3 ? 255 : 0;
          raw.getContext('2d')!.putImageData(pixels, 0, 0); context.drawImage(raw, 0, 0, canvas.width, canvas.height);
        } else context.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare a live texture')), 'image/png'));
        const bytes = new Uint8Array(await png.arrayBuffer());
        return { hash: await digest(bytes), kind: 'texture', bytes };
      })();
      cached = { version: texture.version, asset }; this.textures.set(texture, cached);
    }
    const asset = await cached.asset; this.assets.set(asset.hash, asset);
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    return { hash: asset.hash, matrix: texture.matrix.toArray() };
  }

  private async material(input: THREE.Material): Promise<LiveMaterial> {
    const m = input as THREE.MeshStandardMaterial;
    const [map, normalMap, roughnessMap, metalnessMap, emissiveMap, aoMap, alphaMap] = await Promise.all([
      this.texture(m.map), this.texture(m.normalMap), this.texture(m.roughnessMap), this.texture(m.metalnessMap), this.texture(m.emissiveMap), this.texture(m.aoMap), this.texture(m.alphaMap),
    ]);
    const color = m.color ?? new THREE.Color(1, 1, 1), emissive = m.emissive?.clone().multiplyScalar(m.emissiveIntensity ?? 1) ?? new THREE.Color(0, 0, 0);
    return { color: [color.r, color.g, color.b], emissive: [emissive.r, emissive.g, emissive.b],
      roughness: m.roughness ?? 1, metalness: m.metalness ?? 0, opacity: m.opacity,
      transparent: m.transparent || m.opacity < 1, vertexColors: m.vertexColors,
      alphaTest: m.alphaTest, normalScale: [m.normalScale?.x ?? 1, m.normalScale?.y ?? 1], aoIntensity: Math.max(0, Math.min(1, m.aoMapIntensity ?? 1)),
      unlit: input instanceof THREE.MeshBasicMaterial, map, normalMap, roughnessMap, metalnessMap, emissiveMap, aoMap, alphaMap };
  }

  build(doc: ArchaiDocument, catalog: AssetCatalog, style: ViewStyle, settings: RenderSettings,
    camera: CameraState | undefined, progress: (stage: string) => void): Promise<UnrealLiveScene> {
    const job=this.work.catch(()=>undefined).then(()=>this.buildNow(doc,catalog,style,settings,camera,progress));
    this.work=job;return job;
  }
  private async buildNow(doc: ArchaiDocument, catalog: AssetCatalog, style: ViewStyle, settings: RenderSettings,
    camera: CameraState | undefined, progress: (stage: string) => void): Promise<UnrealLiveScene> {
    const key = liveGeometryKey(doc, style);
    if (key !== this.key && this.storage) {
      progress('Checking saved Unreal scene…');
      const hash = await digest(new TextEncoder().encode(persistentGeometryKey(doc,style)));
      try {
        const saved = this.allowRestore ? JSON.parse(await this.storage.get(this.cacheName) ?? 'null') : null;
        if (saved?.geometryHash === hash && Array.isArray(saved.nodes) && saved.nodes.length <= 200000) {
          this.nodes = saved.nodes.map((node: unknown) => LiveNodeSchema.parse(node));
          this.assets.clear(); this.key = key;
          progress('Restoring saved Unreal geometry…');
        }
      } catch { /* Missing, outdated or invalid snapshots rebuild from the original model. */ }
      this.allowRestore=true;
      if (key !== this.key) this.pendingHash = hash;
    }
    if (key !== this.key) {
      this.key = '';
      progress('Preparing model geometry…');
      const root = await buildSurfaces(doc, catalog, (item) => {
        item.object.userData = { ...item.object.userData, liveElementId: item.id }; return item.object;
      });
      const restore = exportAppearance(root, style);
      const nodes: LiveNode[] = [];
      this.assets = new Map();
      try {
        root.updateMatrixWorld(true);
        const meshes: THREE.Mesh[] = [];
        root.traverseVisible((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
        const parts = new Map<string, number>();
        for (let index = 0; index < meshes.length; index++) {
          const mesh = meshes[index]!;
          let parent: THREE.Object3D | null = mesh;
          while (parent && !parent.userData['liveElementId']) parent = parent.parent;
          const elementId = parent?.userData['liveElementId'] as string | undefined;
          if (!elementId) continue;
          const geometry = mesh.geometry, materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const total = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
          const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
          const sections:typeof groups=[];
          for(const group of groups){
            const start=Math.max(group.start,geometry.drawRange.start),end=Math.min(group.start+group.count,total,geometry.drawRange.start+geometry.drawRange.count);
            const count=Math.floor((end-start)/3)*3;
            for(let offset=0;offset<count;offset+=196608)sections.push({...group,start:start+offset,count:Math.min(196608,count-offset)});
          }
          for (const group of sections) {
            const start = Math.max(group.start, geometry.drawRange.start), end = Math.min(group.start + group.count, total, geometry.drawRange.start + geometry.drawRange.count);
            const count = Math.floor((end - start) / 3) * 3;
            if (count <= 0) continue;
            let cache = this.geometry.get(geometry);
            if (!cache) { cache = new Map(); this.geometry.set(geometry, cache); }
            const attributeVersion = (name: string) => {
              const a = geometry.getAttribute(name);
              return a instanceof THREE.InterleavedBufferAttribute ? a.data.version : a?.version;
            };
            const version = `${start}:${count}:${attributeVersion('position')}:${attributeVersion('normal')}:${attributeVersion('uv')}:${attributeVersion('color')}:${geometry.index?.version}`;
            let asset = cache.get(version);
            const first = geometry.index?.getX(start) ?? start, uv = geometry.getAttribute('uv');
            const uvOffset = new THREE.Vector2(uv?.getX(first) ?? 0, uv?.getY(first) ?? 0);
            if (!asset) { asset = (async () => { const bytes = await encodeLiveMeshAsync(geometry, start, count, uvOffset); return { hash: await digest(bytes), kind: 'mesh' as const, bytes }; })(); cache.set(version, asset); }
            const encoded = await asset; this.assets.set(encoded.hash, encoded);
            const material = await this.material(materials[group.materialIndex ?? 0] ?? materials[0]!);
            // World-aligned texture offsets belong to the material, so identical geometry
            // at different locations can share one Unreal mesh without shifting its texture.
            const offsetMatrix = new THREE.Matrix3().set(1, 0, uvOffset.x, 0, 1, uvOffset.y, 0, 0, 1);
            for (const name of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'] as const) {
              const texture = material[name];
              if (texture) material[name] = { ...texture, matrix: new THREE.Matrix3().fromArray(texture.matrix).multiply(offsetMatrix).toArray() };
            }
            for (let instance = 0; instance < (mesh instanceof THREE.InstancedMesh ? mesh.count : 1); instance++) {
              const matrix = mesh.matrixWorld.clone();
              let instanceMaterial = material;
              if (mesh instanceof THREE.InstancedMesh) {
                const local = new THREE.Matrix4(); mesh.getMatrixAt(instance, local); matrix.multiply(local);
                if (mesh.instanceColor) {
                  const color = new THREE.Color(); mesh.getColorAt(instance, color);
                  instanceMaterial = { ...material, color: [material.color[0] * color.r, material.color[1] * color.g, material.color[2] * color.b] };
                }
              }
              const part = parts.get(elementId) ?? 0; parts.set(elementId, part + 1);
              nodes.push({ id: `${elementId}:${part}`, elementId, mesh: encoded.hash, matrix: matrix.toArray(), material: instanceMaterial });
            }
          }
          if (index % 30 === 0) {
            progress(`Preparing elements · ${index + 1} of ${meshes.length}`);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
        this.nodes = nodes; this.key = key;
      } finally {
        restore();
        const disposed = new Set<THREE.BufferGeometry>();
        root.traverse(object => {
          if (object instanceof THREE.Mesh && !object.userData['shared'] && !disposed.has(object.geometry)) {
            disposed.add(object.geometry); object.geometry.dispose();
          }
        });
      }
    }
    const solar = settings.sunMode === 'time' ? sunPosition(localToUtc(settings.date,
      `${String(Math.floor(settings.time)).padStart(2, '0')}:${String(Math.round((settings.time % 1) * 60) % 60).padStart(2, '0')}`, settings.utcOffset), settings.latitude, settings.longitude)
      : { azimuth: settings.azimuth * Math.PI / 180, altitude: settings.altitude * Math.PI / 180 };
    return { protocol: 1, projectId: doc.id, viewId: this.cacheName||doc.id, nodes: this.nodes,
      assets: [...this.assets.values()].filter((asset) => !this.uploaded.has(asset.hash)),
      settings: { ...settings, lights: [...settings.lights, ...renderLightsOf(doc)] }, camera: camera ?? null,
      sunDirection: sunDirection(solar, settings.northAngle) as [number, number, number] };
  }
}
