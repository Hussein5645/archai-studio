/**
 * Manifest-driven catalog. A manifest is a flat list of assets whose `path` encodes the folder
 * hierarchy (`Furnish/Seating/sofa-2-seat`); image and model files live next to each asset.
 * The same format works for a local dev folder and for an R2 bucket behind a public URL.
 */
import { z } from 'zod';
import type { AssetCatalog, CatalogAsset, CatalogFolder, FetchedImage } from './types';

export const ManifestAssetSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  image: z.string().min(1).default('2d.png'),
  model: z.string().min(1).nullable().default('3d.glb'),
  /** Real-world footprint in millimetres. */
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
  tags: z.array(z.string()).optional(),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  /** Folders to show even when they hold no assets yet. */
  folders: z.array(z.string()).default([]),
  assets: z.array(ManifestAssetSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

function joinUrl(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ''), ...parts.map((p) => p.replace(/^\/+|\/+$/g, ''))].join('/');
}

function titleCase(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Builds the folder tree from a manifest; folder order follows first appearance. */
export function buildCatalogTree(manifest: Manifest, baseUrl: string): CatalogFolder {
  const root: CatalogFolder = { path: '', name: 'Library', folders: [], assets: [] };
  const ensureFolder = (path: string): CatalogFolder => {
    let current = root;
    let accumulated = '';
    for (const segment of path.split('/').filter(Boolean)) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      let next = current.folders.find((f) => f.path === accumulated);
      if (!next) {
        next = { path: accumulated, name: titleCase(segment), folders: [], assets: [] };
        current.folders.push(next);
      }
      current = next;
    }
    return current;
  };
  for (const folder of manifest.folders) ensureFolder(folder);
  for (const entry of manifest.assets) {
    const segments = entry.path.split('/').filter(Boolean);
    const folder = ensureFolder(segments.slice(0, -1).join('/'));
    const asset: CatalogAsset = {
      id: entry.path,
      path: entry.path,
      name: entry.name ?? titleCase(segments[segments.length - 1] ?? entry.path),
      kind: 'asset',
      image: { url: joinUrl(baseUrl, entry.path, entry.image) },
      size: entry.size,
      ...(entry.model
        ? {
            model: {
              path: entry.model,
              format: entry.model.toLowerCase().endsWith('.fbx') ? ('fbx' as const) : ('glb' as const),
              url: joinUrl(baseUrl, entry.path, entry.model),
            },
          }
        : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    };
    folder.assets.push(asset);
  }
  return root;
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // fall through
    }
  }
  return { width: 0, height: 0 };
}

export class ManifestCatalog implements AssetCatalog {
  source: string;
  private tree: Promise<CatalogFolder> | null = null;

  constructor(private readonly baseUrl: string, source?: string) {
    this.source = source ?? baseUrl;
  }

  load(): Promise<CatalogFolder> {
    if (!this.tree) {
      this.tree = (async () => {
        const response = await fetch(joinUrl(this.baseUrl, 'manifest.json'), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Catalog manifest failed to load (${response.status})`);
        const manifest = ManifestSchema.parse(await response.json());
        this.source = manifest.source;
        return buildCatalogTree(manifest, this.baseUrl);
      })().catch((error: unknown) => {
        this.tree = null;
        throw error;
      });
    }
    return this.tree;
  }

  async fetchImage(asset: CatalogAsset): Promise<FetchedImage> {
    const response = await fetch(asset.image.url, { cache: 'reload' }); // an <img> may have cached it without CORS headers (R2 sends them only to requests with an Origin)
    if (!response.ok) throw new Error(`Could not fetch ${asset.name} (${response.status})`);
    const blob = await response.blob();
    const { width, height } = await imageDimensions(blob);
    return { mime: blob.type || 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  }
}
