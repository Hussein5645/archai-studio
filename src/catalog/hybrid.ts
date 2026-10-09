import { extractCaiPackage, type ExtractedCaiPackage } from './builder';
import { assetPath, packageEntries } from './cai';
import { libraryUrl } from '@/cloud/library';
import type { LocalCaiStore } from './local-store';
import type {
  AssetCatalog,
  CatalogAsset,
  CatalogFolder,
  CatalogModel,
  FetchedImage,
  SystemAssetType,
} from './types';

/** Catalog entries for a locally stored package (one per wall preset). */
function localAssets(extracted: ExtractedCaiPackage): CatalogAsset[] {
  const { metadata, mapping, top, views } = extracted;
  const models: { glb?: CatalogModel; fbx?: CatalogModel; glbLow?: CatalogModel } = {};
  if (mapping.models.glb) models.glb = { path: mapping.models.glb, format: 'glb' };
  if (mapping.models.fbx) models.fbx = { path: mapping.models.fbx, format: 'fbx' };
  if (mapping.models.glbLow) models.glbLow = { path: mapping.models.glbLow, format: 'glb' };
  const model = models.glb ?? models.fbx;
  const view = (item?: { url: string; path: string; mime: string }) => (item ? { url: item.url, path: item.path, mime: item.mime } : undefined);
  return packageEntries(metadata, (entry) => ({
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
      ...(views.top ? { top: view(views.top) } : {}),
      ...(views.front ? { front: view(views.front) } : {}),
      ...(views.side ? { side: view(views.side) } : {}),
      ...(views.section ? { section: view(views.section) } : {}),
      ...(views.preview ? { preview: view(views.preview) } : {}),
    },
    ...(views.preview ? { thumbnail: view(views.preview) } : {}),
    ...(mapping.styles ? { styleViews: mapping.styles } : {}),
    ...(model ? { model, models } : {}),
    package: { key: `local:${metadata.id}.cai`, url: '', version: 1 },
    size: metadata.size,
    ...(metadata.tags ? { tags: metadata.tags } : {}),
    isLocal: true,
    ...(extracted.recipe ? { parametric: extracted.recipe } : {}),
    ...(entry.presetId ? { presetId: entry.presetId, packageId: metadata.id } : {}),
  }));
}

const DEFAULT_FOLDERS = [
  'Architecture/Openings/Doors',
  'Architecture/Openings/Windows',
  'Architecture/Structure/Columns',
  'Architecture/Structure/Walls',
  'Architecture/Structure/Stairs',
  'Architecture/Circulation/Stairs',
  'Architecture/Circulation/Ramps',
  'Architecture/Circulation/Railings',
  'Architecture/Envelope/Curtain Walls',
  'Architecture/Envelope/Screens',
  'Architecture/Envelope/Facade Elements',
  'Furnish/Seating',
  'Furnish/Tables',
  'Furnish/Storage',
  'Furnish/Beds',
  'Furnish/Kitchen',
  'Furnish/Bathroom',
  'Furnish/Lighting',
  'Equip/Kitchen Equipment',
  'Equip/Bathroom Fixtures',
  'Equip/Electrical',
  'Equip/HVAC',
  'Equip/Plumbing',
  'Equip/Fire Safety',
  'Equip/Specialty Equipment',
  'Populate/People',
  'Populate/Vehicles',
  'Populate/Plants',
  'Populate/Animals',
  'Site/Landscape',
  'Site/Roads',
  'Site/Parking',
  'Site/Fences & Gates',
  'Site/Street Furniture',
  'Site/Context Buildings',
  'Draw/Symbols',
  'Draw/Hatches',
  'Draw/Patterns',
  'Draw/Line Types',
  'Draw/Annotations',
  'Draw/North Arrows',
  'Draw/Scale Bars',
  'Personal/Favorites',
  'Personal/My Assets',
  'Personal/Imported',
  'Personal/Generated',
];

function folderName(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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

export class HybridCaiCatalog implements AssetCatalog {
  source: string;
  private tree: Promise<CatalogFolder> | null = null;
  /** Local system packages, kept out of the folder tree; listed by `loadSystemTypes`. */
  private localSystem: Promise<CatalogAsset[]> | null = null;
  private readonly localImages = new Map<string, ExtractedCaiPackage['top']>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private remoteCatalog: AssetCatalog | null,
    private readonly localStore: LocalCaiStore,
    source?: string,
  ) {
    this.source = source ?? remoteCatalog?.source ?? 'archai:catalog';
    this.localStore.subscribe(() => {
      this.tree = null;
      this.localSystem = null;
      this.notifyListeners();
    });
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

  async loadSystemTypes(type: SystemAssetType): Promise<CatalogAsset[]> {
    let remote: CatalogAsset[] = [];
    if (this.remoteCatalog?.loadSystemTypes) {
      try {
        remote = await this.remoteCatalog.loadSystemTypes(type);
      } catch (error) {
        console.warn(`Remote system types unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Legacy: system packages living in the regular folder tree still count.
    try {
      const root = await this.load();
      const flatten = (folder: CatalogFolder): CatalogAsset[] => [...folder.assets, ...folder.folders.flatMap(flatten)];
      for (const asset of flatten(root)) {
        if (asset.kind === 'system' && asset.systemType === type && !remote.some((item) => item.id === asset.id)) remote.push(asset);
      }
    } catch {
      // the tree is optional here
    }
    if (!this.localSystem) this.localSystem = this.loadLocalSystem();
    const local = (await this.localSystem).filter((asset) => asset.systemType === type);
    const ids = new Set(local.map((asset) => asset.id));
    return [...remote.filter((asset) => !ids.has(asset.id)), ...local];
  }

  private async loadLocalSystem(): Promise<CatalogAsset[]> {
    const assets: CatalogAsset[] = [];
    for (const { bytes } of await this.localStore.loadAllPackages()) {
      try {
        const extracted = extractCaiPackage(bytes);
        if (extracted.metadata.kind !== 'system') continue;
        for (const asset of localAssets(extracted)) {
          this.localImages.set(asset.id, extracted.top);
          assets.push(asset);
        }
      } catch {
        // reported by loadCatalog's warnings
      }
    }
    return assets;
  }

  async fetchImage(asset: CatalogAsset): Promise<FetchedImage> {
    const localTop = this.localImages.get(asset.id);
    if (localTop) {
      const dimensions = await imageDimensions(localTop.bytes, localTop.mime);
      return { mime: localTop.mime, bytes: localTop.bytes, ...dimensions };
    }

    if (asset.isLocal) {
      const bytes = await this.localStore.getPackage(asset.packageId ?? asset.id);
      if (bytes) {
        const extracted = extractCaiPackage(bytes);
        this.localImages.set(asset.id, extracted.top);
        const dimensions = await imageDimensions(extracted.top.bytes, extracted.top.mime);
        return { mime: extracted.top.mime, bytes: extracted.top.bytes, ...dimensions };
      }
    }

    if (this.remoteCatalog) {
      return this.remoteCatalog.fetchImage(asset);
    }

    const response = await fetch(libraryUrl(asset.image.url), { cache: 'reload' }); // an <img> may have cached it without CORS headers (R2 sends them only to requests with an Origin)
    if (!response.ok) throw new Error(`Could not fetch ${asset.name} (${response.status})`);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dimensions = await imageDimensions(bytes, blob.type || asset.image.mime || 'image/png');
    return { mime: blob.type || asset.image.mime || 'image/png', bytes, ...dimensions };
  }

  async addLocalPackage(bytes: Uint8Array): Promise<CatalogAsset> {
    const extracted = extractCaiPackage(bytes);
    const { metadata } = extracted;
    await this.localStore.savePackage(metadata.id, bytes);
    this.localImages.set(metadata.id, extracted.top);
    this.tree = null;
    this.localSystem = null;
    this.notifyListeners();
    const [first] = localAssets(extracted);
    return first!;
  }

  localPackageBytes(id: string): Promise<Uint8Array | null> {
    return this.localStore.getPackage(id);
  }

  async deleteLocalPackage(id: string): Promise<void> {
    await this.localStore.deletePackage(id);
    this.localImages.delete(id);
    this.tree = null;
    this.localSystem = null;
    this.notifyListeners();
  }

  async exportPackageBytes(asset: CatalogAsset): Promise<Uint8Array | null> {
    const local = await this.localStore.getPackage(asset.packageId ?? asset.id);
    if (local) return local;

    if (asset.package?.url) {
      const response = await fetch(libraryUrl(asset.package.url));
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    }
    return null;
  }

  /** Swaps the cloud library (signing in or out): the tree reloads and listeners hear of it. */
  setRemote(remote: AssetCatalog | null): void {
    if (remote === this.remoteCatalog) return;
    this.remoteCatalog = remote;
    if (remote) this.source = remote.source;
    this.tree = null;
    this.localSystem = null;
    this.notifyListeners();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in HybridCaiCatalog listener', err);
      }
    }
  }

  private async loadCatalog(): Promise<CatalogFolder> {
    let root: CatalogFolder;
    const warnings: string[] = [];

    if (this.remoteCatalog) {
      try {
        const remoteRoot = await this.remoteCatalog.load();
        root = structuredClone(remoteRoot);
        if (remoteRoot.warnings) warnings.push(...remoteRoot.warnings);
      } catch (err) {
        warnings.push(`Remote catalog unavailable: ${err instanceof Error ? err.message : String(err)}`);
        root = { path: '', name: 'Library', folders: [], assets: [] };
        for (const folder of DEFAULT_FOLDERS) ensureFolder(root, folder);
      }
    } else {
      root = { path: '', name: 'Library', folders: [], assets: [] };
      for (const folder of DEFAULT_FOLDERS) ensureFolder(root, folder);
    }

    // Load local packages
    const localPackages = await this.localStore.loadAllPackages();
    for (const { id, bytes } of localPackages) {
      try {
        const extracted = extractCaiPackage(bytes);
        const { metadata, top } = extracted;
        this.localImages.set(metadata.id, top);
        // System types are configuration for the architecture tools, not library entries.
        if (metadata.kind === 'system') continue;
        const [asset] = localAssets(extracted) as [CatalogAsset];

        const folder = ensureFolder(root, asset.path.split('/').slice(0, -1).join('/'));
        // Replace existing asset if same ID exists, else append
        const existingIdx = folder.assets.findIndex((a) => a.id === asset.id);
        if (existingIdx >= 0) {
          folder.assets[existingIdx] = asset;
        } else {
          folder.assets.push(asset);
        }
      } catch (err) {
        warnings.push(`Local package ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (warnings.length > 0) {
      root.warnings = warnings;
    }

    return root;
  }
}
