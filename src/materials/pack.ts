/**
 * Material packs: a `.cai` archive (ZIP, see docs/cai-format.md) of `kind: "materials"` holding
 * material records and the image textures they use:
 *
 *   metadata.json   { caiVersion: 1, kind: "materials", id, name, materials: Material[],
 *                     textures: { [blobId]: { path, mime, width, height } } }
 *   textures/<blobId>.<ext>
 *
 * Procedural patterns need no files. Importing keeps ids that are free and renames the rest.
 */
import { unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { MaterialSchema, type ArchaiDocument, type Material, type TextureRef } from '@/document';
import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';

const PackSchema = z.object({
  caiVersion: z.literal(1),
  kind: z.literal('materials'),
  id: z.string(),
  name: z.string(),
  materials: z.array(MaterialSchema),
  textures: z.record(z.string(), z.object({ path: z.string(), mime: z.string(), width: z.number(), height: z.number() })).default({}),
});

export interface PackBlob {
  id: string;
  mime: string;
  data: string;
  width: number;
  height: number;
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function textureRefsOf(material: Material): TextureRef[] {
  return [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap].filter((ref): ref is TextureRef => Boolean(ref));
}

export function writeMaterialPack(doc: Pick<ArchaiDocument, 'blobs'>, materials: readonly Material[], name: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const textures: Record<string, { path: string; mime: string; width: number; height: number }> = {};
  for (const material of materials) {
    for (const ref of textureRefsOf(material)) {
      if (!('blobId' in ref) || textures[ref.blobId]) continue;
      const blob = doc.blobs[ref.blobId];
      if (!blob) continue;
      const path = `textures/${blob.id}.${EXTENSIONS[blob.mime] ?? 'bin'}`;
      files[path] = base64ToBytes(blob.data);
      textures[blob.id] = { path, mime: blob.mime, width: blob.width, height: blob.height };
    }
  }
  const metadata = { caiVersion: 1, kind: 'materials', id: `materials-${Date.now().toString(36)}`, name, materials, textures };
  files['metadata.json'] = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
  return zipSync(files, { level: 6 });
}

export function readMaterialPack(bytes: Uint8Array): { name: string; materials: Material[]; blobs: PackBlob[] } {
  const entries = unzipSync(bytes);
  const byLowerName = new Map(Object.entries(entries).map(([path, data]) => [path.toLowerCase(), data]));
  const raw = byLowerName.get('metadata.json');
  if (!raw) throw new Error('Not a material pack: metadata.json is missing');
  const parsed = PackSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
  if (!parsed.success) throw new Error('Not a material pack (kind "materials")');
  const blobs: PackBlob[] = [];
  for (const [id, texture] of Object.entries(parsed.data.textures)) {
    const data = byLowerName.get(texture.path.toLowerCase());
    if (data) blobs.push({ id, mime: texture.mime, data: bytesToBase64(data), width: texture.width, height: texture.height });
  }
  return { name: parsed.data.name, materials: parsed.data.materials, blobs };
}
