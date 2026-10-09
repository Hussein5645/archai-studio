/**
 * Asynchronous resources for the 3D view: image textures for blobs and GLB/FBX models for
 * catalog assets. Models come out of the asset's `.CAI` package (remote URL or the local store),
 * so the same package that gave the board its top view gives the 3D view its geometry.
 */
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AssetCatalog } from '@/catalog';
import type { ArchaiDocument, AssetDefinition } from '@/document';
import { dataUrl } from '@/persistence/base64';
import { libraryUrl } from '@/cloud/library';

class TextureStore {
  readonly textures = new Map<string, THREE.Texture>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly loader = new THREE.TextureLoader();

  /**
   * Loads textures for image blobs not seen before; resolves true when any new texture arrived.
   * Other blobs (imported models are tens of megabytes) are skipped, and a failed image is not
   * retried: this runs on every document change.
   */
  async prepare(doc: ArchaiDocument): Promise<boolean> {
    let changed = false;
    const jobs: Promise<void>[] = [];
    for (const blob of Object.values(doc.blobs)) {
      if (!blob.mime.startsWith('image/') || this.textures.has(blob.id) || this.pending.has(blob.id) || this.failed.has(blob.id)) continue;
      const job = this.loader
        .loadAsync(dataUrl(blob.mime, blob.data))
        .then((texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          this.textures.set(blob.id, texture);
          changed = true;
        })
        .catch(() => {
          this.failed.add(blob.id);
        })
        .finally(() => this.pending.delete(blob.id));
      this.pending.set(blob.id, job);
      jobs.push(job);
    }
    await Promise.all(jobs);
    return changed;
  }
}

class ModelStore {
  readonly models = new Map<string, THREE.Object3D>();
  /** Low level of detail models (only for packages that ship one). */
  readonly lowModels = new Map<string, THREE.Object3D>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private catalog: AssetCatalog | null = null;

  configure(catalog: AssetCatalog): void {
    this.catalog = catalog;
  }

  async prepare(doc: ArchaiDocument): Promise<boolean> {
    let changed = false;
    const jobs: Promise<void>[] = [];
    for (const definition of Object.values(doc.definitions)) {
      if (definition.kind !== 'image' || !definition.catalog) continue;
      if (this.models.has(definition.id) || this.pending.has(definition.id) || this.failed.has(definition.id)) continue;
      const job = this.load(definition)
        .then((loaded) => {
          if (loaded?.high) {
            this.models.set(definition.id, loaded.high);
            if (loaded.low) this.lowModels.set(definition.id, loaded.low);
            changed = true;
          } else this.failed.add(definition.id);
        })
        .catch((error: unknown) => {
          console.warn(`3D model for ${definition.name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
          this.failed.add(definition.id);
        })
        .finally(() => this.pending.delete(definition.id));
      this.pending.set(definition.id, job);
      jobs.push(job);
    }
    await Promise.all(jobs);
    return changed;
  }

  private readonly packageCache = new Map<string, Promise<Record<string, Uint8Array> | null>>();

  /** One file from the definition's .CAI package (e.g. a styled view), or null. */
  async packageFile(definition: Extract<AssetDefinition, { kind: 'image' }>, path: string): Promise<Uint8Array | null> {
    const key = definition.catalog?.package?.key;
    if (!key) return null;
    let files = this.packageCache.get(key);
    if (!files) {
      files = this.packageBytes(definition).then((bytes) => (bytes ? unzipSync(bytes) : null));
      this.packageCache.set(key, files);
    }
    const table = await files;
    if (!table) return null;
    const wanted = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
    const match = Object.entries(table).find(([name]) => name.replaceAll('\\', '/').toLowerCase() === wanted);
    return match ? match[1] : null;
  }

  private async packageBytes(definition: Extract<AssetDefinition, { kind: 'image' }>): Promise<Uint8Array | null> {
    const pkg = definition.catalog?.package;
    if (!pkg) return null;
    if (pkg.key.startsWith('local:')) {
      const id = pkg.key.slice('local:'.length).replace(/\.cai$/i, '');
      return this.catalog?.localPackageBytes ? this.catalog.localPackageBytes(id) : null;
    }
    if (!pkg.url) return null;
    const response = await fetch(libraryUrl(pkg.url));
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  private async load(definition: Extract<AssetDefinition, { kind: 'image' }>): Promise<{ high: THREE.Object3D; low: THREE.Object3D | null } | null> {
    const catalog = definition.catalog;
    if (!catalog) return null;
    let bytes: ArrayBuffer | null = null;
    let lowBytes: ArrayBuffer | null = null;
    let format: 'glb' | 'fbx' | null = null;
    const packageBytes = await this.packageBytes(definition);
    if (packageBytes) {
      const files = unzipSync(packageBytes);
      const find = (wanted: string | undefined) => {
        if (!wanted) return null;
        const key = wanted.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
        const match = Object.entries(files).find(([name]) => name.replaceAll('\\', '/').toLowerCase() === key);
        return match ? match[1] : null;
      };
      const slice = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const glb = find(catalog.modelPaths?.glb);
      const fbx = glb ? null : find(catalog.modelPaths?.fbx);
      const low = find(catalog.modelPaths?.glbLow);
      if (glb) {
        bytes = slice(glb);
        format = 'glb';
      } else if (fbx) {
        bytes = slice(fbx);
        format = 'fbx';
      }
      if (low) lowBytes = slice(low);
    } else if (catalog.modelUrl) {
      const response = await fetch(libraryUrl(catalog.modelUrl));
      if (!response.ok) return null;
      bytes = await response.arrayBuffer();
      format = catalog.modelUrl.toLowerCase().endsWith('.fbx') ? 'fbx' : 'glb';
    }
    if (!bytes || !format) return null;
    const high = format === 'fbx' ? this.parseFbx(bytes) : await this.parseGlb(bytes);
    if (!high) return null;
    const low = lowBytes ? await this.parseGlb(lowBytes) : null;
    return { high, low };
  }

  private parseFbx(bytes: ArrayBuffer): THREE.Object3D | null {
    const object = new FBXLoader().parse(bytes, '');
    return object.children.length > 0 ? object : null;
  }

  private async parseGlb(bytes: ArrayBuffer): Promise<THREE.Object3D | null> {
    // Library packages are meshopt-compressed (scripts/render-library.mjs).
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '');
    const scene = gltf.scene;
    // A model with no geometry (a placeholder package) is not worth showing.
    let meshes = 0;
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) meshes++;
    });
    return meshes > 0 ? scene : null;
  }
}

export const textureStore = new TextureStore();
export const modelStore = new ModelStore();
