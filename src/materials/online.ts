/**
 * Materials from the internet: Poly Haven's CC0 texture library (about 700 scanned PBR
 * materials, https://polyhaven.com/textures) fetched straight from its public API, which allows
 * cross-origin requests. A download becomes one project material with its colour, normal,
 * roughness, ambient occlusion and metal maps and its real-world tile size.
 */
import type { Material } from '@/document';
import { bytesToBase64 } from '@/persistence/base64';

const API = 'https://api.polyhaven.com';
const THUMBS = 'https://cdn.polyhaven.com/asset_img/thumbs';

export interface OnlineMaterial {
  id: string;
  name: string;
  /** Poly Haven categories, e.g. "brick", "wood", "floor". */
  categories: string[];
  tags: string[];
  thumb: string;
  /** Real-world size in millimetres, when the library gives one. */
  dimensions: [number, number] | null;
  downloads: number;
}

export type OnlineResolution = '1k' | '2k' | '4k';

interface ApiAsset {
  name: string;
  categories?: string[];
  tags?: string[];
  dimensions?: [number, number];
  download_count?: number;
}

let catalogue: Promise<OnlineMaterial[]> | null = null;

/** The whole library, most downloaded first (fetched once per session). */
export function onlineMaterials(): Promise<OnlineMaterial[]> {
  catalogue ??= fetch(`${API}/assets?t=textures`)
    .then((response) => {
      if (!response.ok) throw new Error(`Poly Haven: ${response.status}`);
      return response.json() as Promise<Record<string, ApiAsset>>;
    })
    .then((assets) =>
      Object.entries(assets)
        .map(([id, a]) => ({
          id,
          name: a.name,
          categories: a.categories ?? [],
          tags: a.tags ?? [],
          thumb: `${THUMBS}/${id}.png?width=192&height=192`,
          dimensions: Array.isArray(a.dimensions) && a.dimensions.length === 2 ? a.dimensions : null,
          downloads: a.download_count ?? 0,
        }))
        .sort((a, b) => b.downloads - a.downloads),
    )
    .catch((error: unknown) => {
      catalogue = null;
      throw error;
    });
  return catalogue;
}

/** Categories offered as filters, in this order (Poly Haven names). */
export const ONLINE_CATEGORIES = ['brick', 'wood', 'concrete', 'plaster', 'floor', 'tiles', 'rock', 'metal', 'fabric', 'roofing', 'terrain', 'man made'] as const;

export function searchOnline(all: OnlineMaterial[], query: string, category: string | null): OnlineMaterial[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((m) => {
    if (category && !m.categories.includes(category)) return false;
    const text = `${m.name} ${m.categories.join(' ')} ${m.tags.join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The ArchAI category a library material belongs to. */
export function archaiCategory(categories: readonly string[]): Material['category'] {
  const has = (...names: string[]) => names.some((n) => categories.includes(n));
  if (has('brick')) return 'masonry';
  if (has('concrete', 'asphalt')) return 'concrete';
  if (has('wood')) return 'wood';
  if (has('metal')) return 'metal';
  if (has('tiles')) return 'tile';
  if (has('rock', 'stone', 'cobblestone')) return 'stone';
  if (has('fabric', 'leather')) return 'fabric';
  if (has('plaster', 'paint', 'plastic')) return 'finish';
  return 'other';
}

interface ApiFile {
  url: string;
  size: number;
}
type ApiFiles = Record<string, Record<string, Record<string, ApiFile>>>;

/** Map name in the Poly Haven files list → ArchAI texture channel (OpenGL normals, as three.js uses). */
const CHANNELS: [string, 'map' | 'normalMap' | 'roughnessMap' | 'aoMap' | 'metalnessMap'][] = [
  ['Diffuse', 'map'],
  ['nor_gl', 'normalMap'],
  ['Rough', 'roughnessMap'],
  ['AO', 'aoMap'],
  ['Metal', 'metalnessMap'],
];

export interface DownloadedTexture {
  mime: string;
  data: string;
  width: number;
  height: number;
}

export interface DownloadedMaterial {
  material: Partial<Material> & { name: string };
  textures: Partial<Record<'map' | 'normalMap' | 'roughnessMap' | 'aoMap' | 'metalnessMap', DownloadedTexture>>;
  bytes: number;
}

async function imageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/** Downloads a library material's maps (JPEG) at `resolution`, ready for `create-material`. */
export async function downloadOnlineMaterial(item: OnlineMaterial, resolution: OnlineResolution, onProgress?: (fraction: number) => void): Promise<DownloadedMaterial> {
  const response = await fetch(`${API}/files/${encodeURIComponent(item.id)}`);
  if (!response.ok) throw new Error(`Poly Haven: ${response.status}`);
  const files = (await response.json()) as ApiFiles;
  const wanted = CHANNELS.flatMap(([key, channel]) => {
    const entry = Object.entries(files).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    const file = entry?.[resolution]?.['jpg'] ?? entry?.['1k']?.['jpg'];
    return file ? [{ channel, file }] : [];
  });
  if (!wanted.some((w) => w.channel === 'map')) throw new Error(`${item.name} has no colour map to download`);
  const total = wanted.reduce((sum, w) => sum + w.file.size, 0) || 1;
  let loaded = 0;
  const textures: DownloadedMaterial['textures'] = {};
  for (const { channel, file } of wanted) {
    const image = await fetch(file.url);
    if (!image.ok) throw new Error(`Download failed (${image.status})`);
    const bytes = new Uint8Array(await image.arrayBuffer());
    const size = await imageSize(bytes, 'image/jpeg');
    textures[channel] = { mime: 'image/jpeg', data: bytesToBase64(bytes), ...size };
    loaded += file.size;
    onProgress?.(loaded / total);
  }
  const [width, height] = item.dimensions ?? [1000, 1000];
  const metal = Boolean(textures.metalnessMap);
  return {
    material: {
      name: item.name.slice(0, 80),
      category: archaiCategory(item.categories),
      // Maps carry the colour and roughness: the factors stay neutral.
      color: '#ffffff',
      roughness: 1,
      metalness: metal ? 1 : 0,
      tileWidth: Math.max(10, Math.round(width)),
      tileHeight: Math.max(10, Math.round(height)),
    },
    textures,
    bytes: loaded,
  };
}
