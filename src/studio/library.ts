/**
 * The ArchAI Render library on R2 (archai-assets/render, built by scripts/render-library.mjs):
 * sky HDRIs, CC0 from Poly Haven. Entourage comes from the board's asset catalog (.CAI packages,
 * see catalogEntourage); the older render-only models in library.json are kept as a fallback.
 */
import { unzipSync } from 'fflate';
import { account } from '@/cloud/account';
import { LIBRARY_SIGN_IN_MESSAGE, libraryRoot, libraryUrl } from '@/cloud/library';
import type { AssetCatalog, CatalogAsset, CatalogFolder } from '@/catalog/types';
export interface LibraryHdri {
  id: string;
  name: string;
  url: string;
  thumb: string;
  source: string;
}

export interface LibraryModel {
  id: string;
  name: string;
  category: string;
  url: string;
  thumb: string;
  /** Metres (0 when unknown). */
  height: number;
  source: string;
  /** Package models: the GLB bytes (from the .CAI) and the real width (mm) to scale them to. */
  load?: () => Promise<ArrayBuffer>;
  widthMm?: number;
}

export interface RenderLibrary {
  version: 1;
  credit: string;
  hdris: LibraryHdri[];
  entourage: LibraryModel[];
}

let library: Promise<RenderLibrary> | null = null;
let libraryUser: string | null = null;

/** The library with absolute URLs (fetched once per signed-in user; libraries need an account). */
export function loadLibrary(): Promise<RenderLibrary> {
  const state = account().state();
  const user = state.status === 'signed-in' ? state.user.id : null;
  if (user !== libraryUser) library = null;
  libraryUser = user;
  const root = libraryRoot();
  if (!root) return Promise.reject(new Error(LIBRARY_SIGN_IN_MESSAGE));
  const LIBRARY_URL = `${root}render`;
  library ??= fetch(`${LIBRARY_URL}/library.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Render library: ${response.status}`);
      return response.json() as Promise<RenderLibrary>;
    })
    .then((data) => ({
      ...data,
      hdris: data.hdris.map((h) => ({ ...h, url: `${LIBRARY_URL}/${h.url}`, thumb: `${LIBRARY_URL}/${h.thumb}` })),
      entourage: data.entourage.map((m) => ({ ...m, url: `${LIBRARY_URL}/${m.url}`, thumb: `${LIBRARY_URL}/${m.thumb}` })),
    }))
    .catch((error: unknown) => {
      library = null;
      throw error;
    });
  return library;
}

/**
 * Entourage from the board's asset catalog: every regular asset whose .CAI package has a glTF
 * model (the library's trees, plants, furniture and street furniture, the user's own packages),
 * so the studio places the same models the board uses. Grouped by their library folder.
 */
export async function catalogEntourage(catalog: AssetCatalog): Promise<LibraryModel[]> {
  const root = await catalog.load();
  const models: LibraryModel[] = [];
  const visit = (folder: CatalogFolder) => {
    for (const asset of folder.assets) {
      const glb = asset.models?.glb?.path;
      if (asset.kind !== 'asset' || !glb || !asset.package || asset.size.width <= 0) continue;
      const category = asset.path.split('/').slice(0, -1).at(-1) ?? 'Assets';
      models.push({
        id: asset.id,
        name: asset.name,
        category: folderLabel(category),
        url: asset.package.url,
        thumb: asset.thumbnail?.url ?? asset.image.url,
        height: 0,
        source: asset.package.url,
        widthMm: asset.size.width,
        load: () => packageModel(catalog, asset.package!, asset.packageId ?? asset.id, glb),
      });
    }
    for (const child of folder.folders) visit(child);
  };
  visit(root);
  return models;
}

const folderLabel = (segment: string) => segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function packageModel(catalog: AssetCatalog, pkg: NonNullable<CatalogAsset['package']>, id: string, path: string): Promise<ArrayBuffer> {
  let bytes: Uint8Array | null = null;
  if (pkg.key.startsWith('local:')) bytes = catalog.localPackageBytes ? await catalog.localPackageBytes(id) : null;
  else if (pkg.url) {
    const response = await fetch(libraryUrl(pkg.url));
    if (!response.ok) throw new Error(`Model download failed (${response.status})`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (!bytes) throw new Error('The model package is not available');
  const files = unzipSync(bytes);
  const wanted = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const match = Object.entries(files).find(([name]) => name.replaceAll('\\', '/').toLowerCase() === wanted)?.[1];
  if (!match) throw new Error('The package has no model');
  return match.buffer.slice(match.byteOffset, match.byteOffset + match.byteLength) as ArrayBuffer;
}
