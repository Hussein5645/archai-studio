import type { Platform } from '@/platform/types';
import type { CameraState } from '@/view3d/SceneView';
import type { PreparedOutput } from './vrPreparation';

export interface SavedPreparation {
  signature: string;
  docId: string;
  output: PreparedOutput;
  camera?: CameraState;
  vertices?: number;
  triangles?: number;
  lightScale?: number;
}
type Storage = Platform['storage'];
type Manifest = SavedPreparation & { version: 1; revision: string; chunks: number; bytes: number };
const keyOf = (docId: string, output: PreparedOutput) => `vr-prepared:${docId}:${output}`;
const CHUNK = 768 * 1024;

/** Commit the pointer last: a failed/cancelled write never replaces the last complete bake. */
export async function savePreparation(
  storage: Storage,
  metadata: SavedPreparation,
  bytes: ArrayBuffer,
): Promise<void> {
  const key = keyOf(metadata.docId, metadata.output);
  const previous = await storage.get(key);
  const revision = crypto.randomUUID();
  const data = new Uint8Array(bytes);
  const chunks = Math.ceil(data.length / CHUNK);
  const written: string[] = [];
  try {
    for (let i = 0; i < chunks; i++) {
      const part = data.subarray(i * CHUNK, (i + 1) * CHUNK);
      let binary = '';
      for (let offset = 0; offset < part.length; offset += 8192)
        binary += String.fromCharCode(...part.subarray(offset, offset + 8192));
      const chunkKey = `${key}:${revision}:${i}`;
      written.push(chunkKey);
      await storage.set(chunkKey, btoa(binary));
    }
    await storage.set(
      key,
      JSON.stringify({ ...metadata, version: 1, revision, chunks, bytes: data.length }),
    );
  } catch (error) {
    await Promise.allSettled(written.map((key) => storage.delete(key)));
    throw error;
  }
  if (previous) {
    try {
      const old = JSON.parse(previous) as Manifest;
      if (old.version === 1 && old.revision !== revision)
        await Promise.allSettled(
          Array.from({ length: old.chunks }, (_, i) =>
            storage.delete(`${key}:${old.revision}:${i}`),
          ),
        );
    } catch {
      /* A completed replacement also repairs an unreadable old manifest. */
    }
  }
}

export async function loadPreparation(
  storage: Storage,
  docId: string,
  output: PreparedOutput,
): Promise<{ metadata: SavedPreparation; bytes: ArrayBuffer } | null> {
  const key = keyOf(docId, output);
  const text = await storage.get(key);
  if (!text) return null;
  const saved = JSON.parse(text) as Manifest;
  if (
    saved.version !== 1 ||
    saved.docId !== docId ||
    saved.output !== output ||
    !Number.isSafeInteger(saved.bytes) ||
    saved.bytes <= 0 ||
    saved.bytes > 100 * 1024 * 1024 ||
    saved.chunks !== Math.ceil(saved.bytes / CHUNK) ||
    typeof saved.revision !== 'string'
  )
    throw new Error('The saved preparation is invalid. Bake this project again.');
  const bytes = new Uint8Array(saved.bytes);
  for (let i = 0; i < saved.chunks; i++) {
    const part = await storage.get(`${key}:${saved.revision}:${i}`);
    if (part === null)
      throw new Error('The saved preparation is incomplete. Bake this project again.');
    const binary = atob(part);
    if (binary.length !== Math.min(CHUNK, saved.bytes - i * CHUNK))
      throw new Error('The saved preparation is damaged. Bake this project again.');
    for (let j = 0; j < binary.length; j++) bytes[i * CHUNK + j] = binary.charCodeAt(j);
  }
  return { metadata: saved, bytes: bytes.buffer };
}
