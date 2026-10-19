/**
 * Mesh elements: geometry with no ArchAI equivalent (a Revit roof, stair, furniture...) kept as
 * a binary glTF blob on a plain rect: `meta.mesh = { blobId, category, height }`. The rect is the
 * plan box (moving or rotating it moves the mesh, its elevation lifts it); the mesh's vertices are
 * millimetres relative to the rect's top-left corner and base, as (x, up, y).
 */
import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ArchaiDocument, Element } from '@/document';
import { base64ToBytes } from '@/persistence/base64';
import { previewTriangleTargets, reduceLargeScene, sceneTriangles } from './largeScene';

export interface MeshMeta {
  blobId: string;
  category: string;
  height: number;
  /** Imported models: the source units and up axis they were baked with (see ./modelImport.ts). */
  unit?: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  up?: 'y' | 'z';
}

export function meshOf(element: Element | undefined | null): MeshMeta | null {
  const value = element?.meta?.['mesh'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const blobId = value['blobId'];
  if (typeof blobId !== 'string') return null;
  const unit = value['unit'];
  const up = value['up'];
  return {
    blobId,
    category: typeof value['category'] === 'string' ? value['category'] : '',
    height: typeof value['height'] === 'number' ? value['height'] : 0,
    ...(unit === 'mm' || unit === 'cm' || unit === 'm' || unit === 'in' || unit === 'ft' ? { unit } : {}),
    ...(up === 'y' || up === 'z' ? { up } : {}),
  };
}

class MeshStore {
  /** Decoded meshes by blob id. */
  readonly models = new Map<string, THREE.Object3D>();
  /** Generated board previews; full geometry stays in models and in the saved blob. */
  readonly lowModels = new Map<string, THREE.Object3D>();
  previewVersion = 0;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly previewTargets = new Map<string, number>();
  private previewQueue: Promise<void> = Promise.resolve();
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private async decode(data: string): Promise<THREE.Object3D> {
    if (this.active >= 1) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const bytes = base64ToBytes(data);
      return (
        await this.loader.parseAsync(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          '',
        )
      ).scene;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Decodes the meshes of the document not seen before; resolves true when any arrived. */
  async prepare(doc: ArchaiDocument): Promise<boolean> {
    let changed = false;
    const jobs: Promise<void>[] = [];
    for (const element of Object.values(doc.elements)) {
      const mesh = meshOf(element);
      if (!mesh || this.models.has(mesh.blobId) || this.failed.has(mesh.blobId)) continue;
      const pending = this.pending.get(mesh.blobId);
      if (pending) {
        jobs.push(
          pending.then(() => {
            changed = true;
          }),
        );
        continue;
      }
      const blob = doc.blobs[mesh.blobId];
      if (!blob) continue;
      const job = this.decode(blob.data)
        .then((model) => {
          this.models.set(mesh.blobId, model);
          changed = true;
        })
        .catch(() => {
          this.failed.add(mesh.blobId);
        })
        .finally(() => this.pending.delete(mesh.blobId));
      this.pending.set(mesh.blobId, job);
      jobs.push(job);
    }
    await Promise.all(jobs);
    const copies = new Map<string, number>();
    for (const element of Object.values(doc.elements)) {
      const mesh = meshOf(element);
      if (mesh && element.visible !== false && this.models.has(mesh.blobId)) copies.set(mesh.blobId, (copies.get(mesh.blobId) ?? 0) + 1);
    }
    const targets = previewTriangleTargets([...copies].map(([id, count]) => ({ id, copies: count, triangles: sceneTriangles(this.models.get(id)!) })));
    // A single worker job at a time avoids launching dozens of simplifiers when a
    // large linked model is first decoded. Concurrent views share this queue.
    const previews = this.previewQueue.catch(() => undefined).then(async () => {
      for (const [id, target] of targets) {
        if ((this.previewTargets.get(id) ?? Infinity) <= target) continue;
        const model = this.models.get(id)!;
        try {
          const preview = await reduceLargeScene(model, target, 10, undefined, false, true);
          // Existing views may still hold the old preview's geometry until rebuilt.
          this.lowModels.set(id, preview);
          this.previewVersion++;
          this.previewTargets.set(id, target);
          changed = true;
        } catch {
          // Keep the detailed model usable if a preview cannot be generated.
        }
      }
    });
    this.previewQueue = previews;
    await previews;
    return changed;
  }
}

export const meshStore = new MeshStore();
