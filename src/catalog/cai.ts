/**
 * Cloudflare R2-backed ArchAI package catalog.
 *
 * A .CAI file is a ZIP archive whose root contains metadata.json and mapping.json. The catalog
 * index contains only object keys; package metadata remains the source of truth. Packages are
 * fetched with bounded concurrency, validated, and reduced to the top-view bitmap needed by the
 * 2D board. The mapped GLB/FBX stays inside the package for the future 3D renderer.
 */
import { strFromU8, unzipSync } from 'fflate';
import { libraryUrl } from '@/cloud/library';
import { recipeFromFiles } from './parametric';
import { z } from 'zod';
import { LINE_SYSTEM_TYPES, presetAssetId, presetParameters, SYSTEM_TOOL_FOLDERS, SYSTEM_TYPES, SystemPresetSchema, validateSystemPackageParameters } from './system-schemas';
import type {
  AssetCatalog,
  CatalogAsset,
  CatalogFolder,
  CatalogModel,
  FetchedImage,
  SystemAssetType,
} from './types';

const ArchivePathSchema = z
  .string()
  .min(1)
  .transform(normalizeArchivePath)
  .refine((value) => value.length > 0 && !value.split('/').includes('..'), 'Expected a safe relative package path');

const JsonParameter: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonParameter), z.record(z.string(), JsonParameter)]),
);

export const CaiMetadataSchema = z
  .object({
    caiVersion: z.literal(1),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    /** Optional for system types: their folder is implied by `system.type`. */
    category: z.string().min(1).max(500).optional(),
    kind: z.enum(['asset', 'system']).default('asset'),
    /** Legacy packages are read for migration; new system packages use the `system` block. */
    systemType: z.enum(SYSTEM_TYPES).optional(),
    system: z
      .object({
        type: z.enum(SYSTEM_TYPES),
        parameters: z.record(z.string(), JsonParameter).default({}),
        /** One selectable type per preset (any system type). */
        presets: z.array(SystemPresetSchema).optional(),
      })
      .optional(),
    /** Plan footprint (width × depth); line-based system types (walls, railings) may use 0 x 0. */
    size: z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() }).default({ width: 0, height: 0 }),
    /** Height of the model above the ground, in millimetres (assets modeled in ArchAI). */
    modelHeight: z.number().nonnegative().optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
    /** Levels of detail: whether a low-poly model was packaged alongside the full one. */
    lod: z.object({ low: z.boolean() }).optional(),
    /** The model contains bodies built in the modeling workspace (not only imported geometry). */
    modeled: z.boolean().optional(),
    /** Cameras authored with the model, relative to its origin (plan centre on the ground). */
    cameras: z
      .array(
        z.object({
          name: z.string().max(200),
          eye: z.tuple([z.number(), z.number(), z.number()]),
          aim: z.tuple([z.number(), z.number(), z.number()]),
          fov: z.number().positive(),
          /** The camera the thumbnail was rendered from. */
          preview: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    const type = value.system?.type ?? value.systemType;
    if (value.kind === 'system' && !type) {
      ctx.addIssue({ code: 'custom', path: ['system'], message: 'System assets require the system metadata block' });
    }
    if (value.kind === 'asset' && (value.system || value.systemType)) {
      ctx.addIssue({ code: 'custom', path: ['system'], message: 'Regular assets cannot set system metadata' });
    }
    if (value.kind === 'asset' && !value.category) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Regular assets require a category' });
    }
    const lineBased = type ? LINE_SYSTEM_TYPES.includes(type) : false;
    const presetOnlyPackage = Boolean(value.system?.presets?.length);
    if (!lineBased && !presetOnlyPackage && !(value.size.width > 0 && value.size.height > 0)) {
      ctx.addIssue({ code: 'custom', path: ['size'], message: 'size must contain a positive width and height' });
    }
    if (value.system) {
      // A wall package made of presets needs no top-level parameters.
      const presetOnly = Boolean(value.system.presets?.length) && Object.keys(value.system.parameters).length === 0;
      const parameters = presetOnly ? { ok: true as const } : validateSystemPackageParameters(value.system.type, value.system.parameters);
      if (!parameters.ok) ctx.addIssue({ code: 'custom', path: ['system', 'parameters'], message: parameters.message });
      const ids = new Set<string>();
      for (const preset of value.system.presets ?? []) {
        if (ids.has(preset.id)) ctx.addIssue({ code: 'custom', path: ['system', 'presets'], message: `Duplicate preset id "${preset.id}"` });
        ids.add(preset.id);
        const check = validateSystemPackageParameters(value.system.type, presetParameters(preset));
        if (!check.ok) ctx.addIssue({ code: 'custom', path: ['system', 'presets', preset.id], message: check.message });
      }
    }
  });

export const VIEW_STYLES = ['realistic', 'color', 'shaded', 'wireframe', 'hidden-line'] as const;
export type ViewStyleName = (typeof VIEW_STYLES)[number];

const ViewSet = z.object({
  top: ArchivePathSchema.optional(),
  front: ArchivePathSchema.optional(),
  side: ArchivePathSchema.optional(),
});

export const CaiMappingSchema = z.object({
  version: z.literal(1),
  views: z.object({
    top: ArchivePathSchema.optional(),
    front: ArchivePathSchema.optional(),
    side: ArchivePathSchema.optional(),
    /** Cross-section swatch for line-based system types. */
    section: ArchivePathSchema.optional(),
    /** Thumbnail: a hidden-line perspective from the asset's preview camera. */
    preview: ArchivePathSchema.optional(),
  }),
  /** The same three views rendered in other display styles (low-LOD boards pick the one they need). */
  styles: z.partialRecord(z.enum(VIEW_STYLES), ViewSet).optional(),
  models: z
    .object({
      glb: ArchivePathSchema.optional(),
      fbx: ArchivePathSchema.optional(),
      /** Low level of detail model (a subset of the layers), for boards set to low LOD. */
      glbLow: ArchivePathSchema.optional(),
    })
    .default({}),
  /** Recipe of an asset modeled in ArchAI with parameters (see src/catalog/parametric.ts). */
  recipe: ArchivePathSchema.optional(),
});

/**
 * The views/models a package must map, by kind and system type:
 * - regular assets: `top` + a model;
 * - placed system types (door, window, column, stair, facade element): `top`, `front`, `side` + a model;
 * - line-based system types (wall, railing, curtain wall): `section`; model optional.
 */
export function checkPackageContents(metadata: CaiMetadata, mapping: CaiMapping): string | null {
  const type = metadata.system?.type ?? metadata.systemType;
  const hasModel = Boolean(mapping.models.glb || mapping.models.fbx);
  // Preset packages describe parameters only; the tool's built-in geometry draws them.
  if (metadata.kind === 'system' && metadata.system?.presets?.length) return null;
  if (metadata.kind === 'system' && type && LINE_SYSTEM_TYPES.includes(type)) {
    if (!mapping.views.section && !mapping.views.top) return `${type} packages require a views.section swatch`;
    return null;
  }
  if (!mapping.views.top) return 'mapping.views.top is required';
  if (!hasModel) return 'A .CAI package requires at least one GLB or FBX model';
  if (metadata.kind === 'system' && (!mapping.views.front || !mapping.views.side)) {
    return 'System packages require top, front, and side orthographic views';
  }
  return null;
}

export const CaiCatalogIndexSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1).optional(),
  folders: z.array(z.string().min(1)).default([]),
  /**
   * Package keys. A large library also inlines each package's `metadata` and `mapping` with
   * bucket keys of its top view and thumbnail, so the library lists without downloading packages
   * (a package is fetched when it is placed or its model is needed).
   */
  packages: z.array(
    z.object({
      key: ArchivePathSchema,
      metadata: z.unknown().optional(),
      mapping: z.unknown().optional(),
      top: ArchivePathSchema.optional(),
      preview: ArchivePathSchema.optional(),
    }),
  ),
  /** System types from the `system/<tool>/` folder; never shown in the Assets tab. */
  system: z.array(z.object({ tool: z.enum(SYSTEM_TOOL_FOLDERS), key: ArchivePathSchema })).default([]),
});

export type CaiMetadata = z.infer<typeof CaiMetadataSchema>;
export type CaiMapping = z.infer<typeof CaiMappingSchema>;
export type CaiCatalogIndex = z.infer<typeof CaiCatalogIndexSchema>;
type IndexedPackage = CaiCatalogIndex['packages'][number] & { top: string };

interface PackageView {
  bytes: Uint8Array;
  mime: string;
  path: string;
  url: string;
}

interface ExtractedPackage {
  metadata: CaiMetadata;
  mapping: CaiMapping;
  files: Record<string, Uint8Array>;
  /** The image the 2D board uses: the top view, or the section swatch for line-based types. */
  top: PackageView;
  views: {
    top?: PackageView;
    front?: PackageView;
    side?: PackageView;
    section?: PackageView;
    preview?: PackageView;
  };
}

function normalizeArchivePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function joinObjectUrl(baseUrl: string, key: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(key.split('/').map(encodeURIComponent).join('/'), base).toString();
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

function fileFrom(files: Record<string, Uint8Array>, wanted: string, label: string): Uint8Array {
  const normalized = normalizeArchivePath(wanted).toLowerCase();
  const match = Object.entries(files).find(([path]) => normalizeArchivePath(path).toLowerCase() === normalized);
  if (!match) throw new Error(`${label} points to missing file "${wanted}"`);
  return match[1];
}

function jsonFrom(files: Record<string, Uint8Array>, name: string): unknown {
  const bytes = fileFrom(files, name, name);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

/**
 * Catalog entries a package yields: one, or one per wall preset. `build` receives the asset id,
 * display name and system parameters for each entry.
 */
export function packageEntries<T>(metadata: CaiMetadata, build: (entry: { id: string; name: string; parameters?: Record<string, unknown>; instanceEditable?: string[]; presetId?: string }) => T): T[] {
  const presets = metadata.system?.presets;
  if (metadata.system && presets && presets.length > 0) {
    return presets.map((preset) => build({ id: presetAssetId(metadata.id, preset.id), name: preset.name, parameters: presetParameters(preset), ...(Array.isArray(preset['instanceEditable']) ? { instanceEditable: preset['instanceEditable'] as string[] } : {}), presetId: preset.id }));
  }
  return [build({ id: metadata.id, name: metadata.name, ...(metadata.system ? { parameters: metadata.system.parameters } : {}) })];
}

/** Library path of a package: `<category>/<id slug>`; system types fall back to `system/<type>/<slug>`. */
export function assetPath(metadata: CaiMetadata): string {
  const slug = metadata.id.split('/').filter(Boolean).at(-1) ?? metadata.id;
  const type = metadata.system?.type ?? metadata.systemType;
  const category = metadata.category?.replace(/^\/+|\/+$/g, '') || (type ? `system/${type}` : 'Personal/Imported');
  return `${category}/${slug}`;
}

function folderName(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function ensureFolder(root: CatalogFolder, path: string): CatalogFolder {
  let current = root;
  let accumulated = '';
  for (const segment of path.split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    let next = current.folders.find((folder) => folder.path === accumulated);
    if (!next) {
      next = { path: accumulated, name: folderName(segment), folders: [], assets: [] };
      current.folders.push(next);
    }
    current = next;
  }
  return current;
}

async function imageDimensions(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 };
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  } catch {
    return { width: 0, height: 0 };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export class CaiCatalog implements AssetCatalog {
  source: string;
  private tree: Promise<CatalogFolder> | null = null;
  private readonly packages = new Map<string, Promise<ExtractedPackage>>();
  private readonly images = new Map<string, ExtractedPackage['top']>();
  private systemTypes: Promise<CatalogAsset[]> | null = null;

  constructor(private readonly baseUrl: string, source?: string) {
    this.source = source ?? baseUrl;
  }

  load(): Promise<CatalogFolder> {
    if (!this.tree) {
      this.tree = this.loadCatalog().catch((error: unknown) => {
        this.tree = null;
        throw error;
      });
    }
    return this.tree;
  }

  loadSystemTypes(type: SystemAssetType): Promise<CatalogAsset[]> {
    if (!this.systemTypes) {
      this.systemTypes = this.loadSystemIndex().catch((error: unknown) => {
        this.systemTypes = null;
        throw error;
      });
    }
    return this.systemTypes.then((assets) => assets.filter((asset) => asset.systemType === type));
  }

  private async loadSystemIndex(): Promise<CatalogAsset[]> {
    const index = await this.index();
    const assets = await mapLimit(index.system, 4, async ({ tool, key }) => {
      try {
        const entries = await this.assetsFromPackage(key);
        if (entries.some((asset) => asset.kind !== 'system' || asset.systemType !== tool)) {
          throw new Error(`system/${tool} entries must be "${tool}" system packages`);
        }
        return entries;
      } catch (error) {
        console.warn(`System type ${key} skipped: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    return assets.flat();
  }

  private indexPromise: Promise<CaiCatalogIndex> | null = null;

  private index(): Promise<CaiCatalogIndex> {
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const indexUrl = joinObjectUrl(this.baseUrl, 'catalog.json');
        const response = await fetch(indexUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`R2 catalog index failed to load (${response.status})`);
        const index = CaiCatalogIndexSchema.parse(await response.json());
        this.source = index.source ?? this.source;
        return index;
      })().catch((error: unknown) => {
        this.indexPromise = null;
        throw error;
      });
    }
    return this.indexPromise;
  }

  async fetchImage(asset: CatalogAsset): Promise<FetchedImage> {
    let top = this.images.get(asset.id);
    // Inline index entries point at their top view in the bucket; others read it from the package.
    if (!top && asset.package && !/^https?:/i.test(asset.image.url)) {
      top = (await this.extract(asset.package.url)).top;
      this.images.set(asset.id, top);
    }
    if (!top) {
      const response = await fetch(libraryUrl(asset.image.url), { cache: 'reload' }); // an <img> may have cached it without CORS headers (R2 sends them only to requests with an Origin)
      if (!response.ok) throw new Error(`Could not fetch ${asset.name} (${response.status})`);
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dimensions = await imageDimensions(bytes, blob.type || asset.image.mime || 'image/png');
      return { mime: blob.type || asset.image.mime || 'image/png', bytes, ...dimensions };
    }
    const dimensions = await imageDimensions(top.bytes, top.mime);
    return { mime: top.mime, bytes: top.bytes, ...dimensions };
  }

  private async loadCatalog(): Promise<CatalogFolder> {
    const index = await this.index();
    const root: CatalogFolder = { path: '', name: 'Library', folders: [], assets: [] };
    for (const folder of index.folders) ensureFolder(root, folder);

    const warnings: string[] = [];
    const assets = await mapLimit(index.packages, 4, async (entry) => {
      const { key } = entry;
      try {
        return entry.metadata && entry.mapping && entry.top ? this.assetsFromIndex(entry as IndexedPackage) : await this.assetsFromPackage(key);
      } catch (error) {
        warnings.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    for (const asset of assets.flat()) {
      const folderPath = asset.path.split('/').slice(0, -1).join('/');
      ensureFolder(root, folderPath).assets.push(asset);
    }
    if (warnings.length) root.warnings = warnings;
    return root;
  }

  /** Catalog entries from an index entry that inlines the package's metadata and views. */
  private assetsFromIndex(entry: IndexedPackage): CatalogAsset[] {
    if (!entry.key.toLowerCase().endsWith('.cai')) throw new Error('Catalog entries must use the .CAI extension');
    const metadata = CaiMetadataSchema.parse(entry.metadata);
    const mapping = CaiMappingSchema.parse(entry.mapping);
    const problem = checkPackageContents(metadata, mapping);
    if (problem) throw new Error(problem);
    if (metadata.kind !== 'asset') throw new Error('Only regular assets can be listed inline');
    const models: { glb?: CatalogModel; fbx?: CatalogModel; glbLow?: CatalogModel } = {};
    if (mapping.models.glb) models.glb = { path: mapping.models.glb, format: 'glb' };
    if (mapping.models.fbx) models.fbx = { path: mapping.models.fbx, format: 'fbx' };
    if (mapping.models.glbLow) models.glbLow = { path: mapping.models.glbLow, format: 'glb' };
    const model = models.glb ?? models.fbx;
    const top = { url: joinObjectUrl(this.baseUrl, entry.top), path: mapping.views.top!, mime: mimeFor(entry.top) };
    const preview = entry.preview ? { url: joinObjectUrl(this.baseUrl, entry.preview), path: mapping.views.preview ?? entry.preview, mime: mimeFor(entry.preview) } : undefined;
    return [
      {
        id: metadata.id,
        path: assetPath(metadata),
        name: metadata.name,
        kind: 'asset',
        image: top,
        views: { top, ...(preview ? { preview } : {}) },
        ...(preview ? { thumbnail: preview } : {}),
        ...(mapping.styles ? { styleViews: mapping.styles } : {}),
        ...(model ? { model, models } : {}),
        package: { key: entry.key, url: joinObjectUrl(this.baseUrl, entry.key), version: 1 },
        size: metadata.size,
        ...(metadata.tags ? { tags: metadata.tags } : {}),
      },
    ];
  }

  private async assetsFromPackage(key: string): Promise<CatalogAsset[]> {
    if (!key.toLowerCase().endsWith('.cai')) throw new Error('Catalog entries must use the .CAI extension');
    const packageUrl = joinObjectUrl(this.baseUrl, key);
    const extracted = await this.extract(packageUrl);
    const { metadata, mapping, top } = extracted;
    const models: { glb?: CatalogModel; fbx?: CatalogModel; glbLow?: CatalogModel } = {};
    if (mapping.models.glb) models.glb = { path: mapping.models.glb, format: 'glb' };
    if (mapping.models.fbx) models.fbx = { path: mapping.models.fbx, format: 'fbx' };
    if (mapping.models.glbLow) models.glbLow = { path: mapping.models.glbLow, format: 'glb' };
    const model = models.glb ?? models.fbx;
    const view = (item?: PackageView) => (item ? { url: item.url, path: item.path, mime: item.mime } : undefined);
    const recipe = recipeFromFiles(extracted.files, mapping);
    return packageEntries(metadata, (entry) => {
      this.images.set(entry.id, top);
      return {
        id: entry.id,
        path: assetPath(metadata),
        name: entry.name,
        kind: metadata.kind,
        ...(metadata.system || metadata.systemType
          ? {
              systemType: (metadata.system?.type ?? metadata.systemType) as SystemAssetType,
              ...(entry.parameters ? { systemParameters: entry.parameters as CatalogAsset['systemParameters'] } : {}),
              ...(entry.instanceEditable ? { instanceEditable: entry.instanceEditable } : {}),
            }
          : {}),
        image: { url: top.url, path: top.path, mime: top.mime },
        views: {
          ...(extracted.views.top ? { top: view(extracted.views.top) } : {}),
          ...(extracted.views.front ? { front: view(extracted.views.front) } : {}),
          ...(extracted.views.side ? { side: view(extracted.views.side) } : {}),
          ...(extracted.views.section ? { section: view(extracted.views.section) } : {}),
          ...(extracted.views.preview ? { preview: view(extracted.views.preview) } : {}),
        },
        ...(extracted.views.preview ? { thumbnail: view(extracted.views.preview) } : {}),
        ...(mapping.styles ? { styleViews: mapping.styles } : {}),
        ...(model ? { model, models } : {}),
        package: { key, url: packageUrl, version: 1 },
        ...(recipe ? { parametric: recipe } : {}),
        size: metadata.size,
        ...(metadata.tags ? { tags: metadata.tags } : {}),
        ...(entry.presetId ? { presetId: entry.presetId, packageId: metadata.id } : {}),
      };
    });
  }

  private extract(packageUrl: string): Promise<ExtractedPackage> {
    let pending = this.packages.get(packageUrl);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(libraryUrl(packageUrl));
        if (!response.ok) throw new Error(`Package failed to load (${response.status})`);
        const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
        const metadata = CaiMetadataSchema.parse(jsonFrom(files, 'metadata.json'));
        const mapping = CaiMappingSchema.parse(jsonFrom(files, 'mapping.json'));
        const problem = checkPackageContents(metadata, mapping);
        if (problem) throw new Error(problem);
        const mappedView = (path: string) => {
          const bytes = fileFrom(files, path, `mapping.views.${path}`);
          const mime = mimeFor(path);
          return { bytes, mime, path, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) };
        };
        const topView = mapping.views.top ? mappedView(mapping.views.top) : undefined;
        const front = mapping.views.front ? mappedView(mapping.views.front) : undefined;
        const side = mapping.views.side ? mappedView(mapping.views.side) : undefined;
        const section = mapping.views.section ? mappedView(mapping.views.section) : undefined;
        const preview = mapping.views.preview ? mappedView(mapping.views.preview) : undefined;
        const top = topView ?? section!;
        if (mapping.models.glb) fileFrom(files, mapping.models.glb, 'mapping.models.glb');
        if (mapping.models.fbx) fileFrom(files, mapping.models.fbx, 'mapping.models.fbx');
        return {
          metadata,
          mapping,
          files,
          top,
          views: { ...(topView ? { top: topView } : {}), ...(front ? { front } : {}), ...(side ? { side } : {}), ...(section ? { section } : {}), ...(preview ? { preview } : {}) },
        };
      })().catch((error: unknown) => {
        this.packages.delete(packageUrl);
        throw error;
      });
      this.packages.set(packageUrl, pending);
    }
    return pending;
  }
}
