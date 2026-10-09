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
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  /** Decodes the meshes of the document not seen before; resolves true when any arrived. */
  async prepare(doc: ArchaiDocument): Promise<boolean> {
    let changed = false;
    const jobs: Promise<void>[] = [];
    for (const element of Object.values(doc.elements)) {
      const mesh = meshOf(element);
      if (!mesh || this.models.has(mesh.blobId) || this.pending.has(mesh.blobId) || this.failed.has(mesh.blobId)) continue;
      const blob = doc.blobs[mesh.blobId];
      if (!blob) continue;
      const bytes = base64ToBytes(blob.data);
      const job = this.loader
        .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '')
        .then((gltf) => {
          this.models.set(mesh.blobId, gltf.scene);
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
    return changed;
  }
}

export const meshStore = new MeshStore();
