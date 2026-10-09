/**
 * Material libraries outside the document, like the asset catalog:
 * - **Library**: ArchAI's default materials on R2 (`archai-assets/materials/`, built by
 *   scripts/material-library.mjs): scanned CC0 PBR materials as one-material packs (.cai) with a
 *   thumbnail each. Used by the Materials panel and ArchAI Render.
 * - **My materials**: the user's own materials, kept on this device (platform storage) as packs so
 *   they can be reused in every project: uploaded images or packs, or saved from a project.
 * Adding either to a project imports the pack (`import-material-pack`); the material remembers
 * where it came from (`source`), so adding it again picks the copy already in the project.
 */
import type { ArchaiDocument, Material } from '@/document';
import type { Platform } from '@/platform/types';
import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';
import { readMaterialPack, writeMaterialPack } from './pack';
import { swatchUrl } from './swatch';
import { account } from '@/cloud/account';
import { LIBRARY_SIGN_IN_MESSAGE, libraryRoot, libraryUrl } from '@/cloud/library';

/** The library folder for the signed-in user (libraries need an account, see cloud/library.ts). */
function materialLibraryUrl(): string {
  const root = libraryRoot();
  if (!root) throw new Error(LIBRARY_SIGN_IN_MESSAGE);
  return `${root}materials`;
}

export interface LibraryMaterial {
  id: string;
  name: string;
  category: Material['category'];
  /** Panel group (Brick, Concrete, Wood, Plaster, Stone, Tiles, Metal, Fabric, Roofing, Ground). */
  group: string;
  tags: string[];
  /** Real-world tile size, mm. */
  size: [number, number];
  /** Absolute URLs. */
  pack: string;
  thumb: string;
  bytes: number;
  source: string;
}

export interface MaterialLibrary {
  groups: string[];
  materials: LibraryMaterial[];
}

let library: Promise<MaterialLibrary> | null = null;
let libraryUser: string | null = null;

/** ArchAI's material library (fetched once per signed-in user). */
export function loadMaterialLibrary(): Promise<MaterialLibrary> {
  const state = account().state();
  const user = state.status === 'signed-in' ? state.user.id : null;
  if (user !== libraryUser) library = null;
  libraryUser = user;
  let base: string;
  try {
    base = materialLibraryUrl();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  library ??= fetch(`${base}/library.json`, { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Material library: ${response.status}`);
      return response.json() as Promise<{ groups?: string[]; materials: LibraryMaterial[] }>;
    })
    .then((data) => ({
      groups: data.groups ?? [...new Set(data.materials.map((m) => m.group))],
      materials: data.materials.map((m) => ({ ...m, pack: `${base}/${m.pack}`, thumb: `${base}/${m.thumb}` })),
    }))
    .catch((error: unknown) => {
      library = null;
      throw error;
    });
  return library;
}

export function searchLibrary(materials: readonly LibraryMaterial[], query: string, group: string | null): LibraryMaterial[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return materials.filter((m) => (!group || m.group === group) && words.every((w) => `${m.name} ${m.group} ${m.category} ${m.tags.join(' ')}`.toLowerCase().includes(w)));
}

const packs = new Map<string, Promise<Uint8Array>>();

/** A library material's pack bytes (cached for the session). */
export function libraryPack(entry: Pick<LibraryMaterial, 'id' | 'pack'>): Promise<Uint8Array> {
  let pending = packs.get(entry.id);
  if (!pending) {
    pending = fetch(libraryUrl(entry.pack)).then(async (response) => {
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    });
    pending.catch(() => packs.delete(entry.id));
    packs.set(entry.id, pending);
  }
  return pending;
}

/** The project's copy of a library / My materials entry, if it was added before. */
export function projectCopy(doc: Pick<ArchaiDocument, 'materials'>, source: string): Material | null {
  return Object.values(doc.materials).find((material) => material.source === source) ?? null;
}

type Dispatch = (id: string, input?: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;

/** Imports a one-material pack into the project (or finds the copy already there); returns its id. */
export async function addPackToProject(dispatch: Dispatch, doc: Pick<ArchaiDocument, 'materials'>, source: string, bytes: () => Promise<Uint8Array>): Promise<string> {
  const existing = projectCopy(doc, source);
  if (existing) return existing.id;
  const data = await bytes();
  const result = await dispatch('import-material-pack', { data: bytesToBase64(data), source });
  if (!result.ok) throw new Error(result.error.message);
  const ids = result.value as string[];
  if (!ids[0]) throw new Error('The pack has no material');
  return ids[0];
}

export const libraryMaterialToProject = (dispatch: Dispatch, doc: Pick<ArchaiDocument, 'materials'>, entry: LibraryMaterial) => addPackToProject(dispatch, doc, `library:${entry.id}`, () => libraryPack(entry));

// ---- My materials ----------------------------------------------------------------------------

const MINE_PREFIX = 'archai:mymat:';
const MINE_INDEX = 'archai:mymat-index';

export interface MyMaterial {
  id: string;
  name: string;
  category: Material['category'];
  /** Swatch image (data URL). */
  thumb: string;
  addedAt: string;
}

const mineListeners = new Set<() => void>();
export function onMyMaterialsChange(listener: () => void): () => void {
  mineListeners.add(listener);
  return () => mineListeners.delete(listener);
}
const notifyMine = () => {
  for (const listener of mineListeners) listener();
};

export async function listMyMaterials(platform: Platform): Promise<MyMaterial[]> {
  try {
    const raw = await platform.storage.get(MINE_INDEX);
    const list = raw ? (JSON.parse(raw) as MyMaterial[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function myMaterialPack(platform: Platform, id: string): Promise<Uint8Array> {
  const raw = await platform.storage.get(`${MINE_PREFIX}${id}`);
  if (!raw) throw new Error('This material is no longer in My materials');
  return base64ToBytes(raw);
}

/** A swatch image once its textures have decoded. */
async function swatchOf(material: Material, doc: Pick<ArchaiDocument, 'blobs'>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = await new Promise<string | null>((resolve) => {
      const first = swatchUrl(material, doc, () => resolve(swatchUrl(material, doc)), 96);
      if (first) resolve(first);
      else setTimeout(() => resolve(null), 250);
    });
    if (url) return url;
  }
  return '';
}

/** Saves materials of a document (with their textures) to My materials, one entry each. */
export async function saveToMyMaterials(platform: Platform, doc: Pick<ArchaiDocument, 'blobs'>, materials: readonly Material[]): Promise<MyMaterial[]> {
  const list = await listMyMaterials(platform);
  const saved: MyMaterial[] = [];
  for (const material of materials) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const own = { ...material, source: `mine:${id}` };
    await platform.storage.set(`${MINE_PREFIX}${id}`, bytesToBase64(writeMaterialPack(doc, [own], material.name)));
    const entry: MyMaterial = { id, name: material.name, category: material.category, thumb: await swatchOf(material, doc), addedAt: new Date().toISOString() };
    list.unshift(entry);
    saved.push(entry);
  }
  await platform.storage.set(MINE_INDEX, JSON.stringify(list));
  notifyMine();
  return saved;
}

/** Adds every material of a pack file (.cai) to My materials. */
export async function importPackToMyMaterials(platform: Platform, bytes: Uint8Array): Promise<MyMaterial[]> {
  const pack = readMaterialPack(bytes);
  const blobs = Object.fromEntries(pack.blobs.map((blob) => [blob.id, blob]));
  return saveToMyMaterials(platform, { blobs }, pack.materials);
}

export async function deleteMyMaterial(platform: Platform, id: string): Promise<void> {
  const list = (await listMyMaterials(platform)).filter((entry) => entry.id !== id);
  await platform.storage.delete(`${MINE_PREFIX}${id}`);
  await platform.storage.set(MINE_INDEX, JSON.stringify(list));
  notifyMine();
}

/** The project material for a dragged library / My materials entry (`LIBRARY_DRAG_TYPE` JSON), added if needed. */
export async function droppedMaterial(data: string, dispatch: Dispatch, doc: Pick<ArchaiDocument, 'materials'>, platform: Platform): Promise<string> {
  const { kind, id } = JSON.parse(data) as { kind: 'library' | 'mine'; id: string };
  if (kind === 'mine') return myMaterialToProject(dispatch, doc, platform, { id });
  const entry = (await loadMaterialLibrary()).materials.find((m) => m.id === id);
  if (!entry) throw new Error('This material is no longer in the library');
  return libraryMaterialToProject(dispatch, doc, entry);
}

export const myMaterialToProject = (dispatch: Dispatch, doc: Pick<ArchaiDocument, 'materials'>, platform: Platform, entry: Pick<MyMaterial, 'id'>) => addPackToProject(dispatch, doc, `mine:${entry.id}`, () => myMaterialPack(platform, entry.id));
