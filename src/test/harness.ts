/**
 * Deterministic test wiring: sequential ids, a fixed clock, monospace text metrics and
 * in-memory platform/catalog fakes.
 */
import { createLocalCaiStore, HybridCaiCatalog, type AssetCatalog, type CatalogAsset, type CatalogFolder, type FetchedImage } from '@/catalog';
import { builtinCommands, CommandExecutor, CommandRegistry } from '@/commands';
import { sequentialIds, type IdSource } from '@/document';
import { monospaceMeasurer } from '@/geometry';
import type { ImageFile, OpenedDocumentFile, Platform } from '@/platform/types';
import { createAppStore, type AppStore } from '@/store';

export interface FakePlatform extends Platform {
  storageMap: Map<string, string>;
  clipboardText: string | null;
  nextOpenDocument: OpenedDocumentFile | null;
  nextOpenImage: ImageFile | null;
  savedFiles: { path: string | null; text: string }[];
  savedBinaries: { name: string; mime: string; bytes: Uint8Array }[];
  title: string;
}

export function fakePlatform(): FakePlatform {
  const platform: FakePlatform = {
    kind: 'web',
    storageMap: new Map(),
    clipboardText: null,
    nextOpenDocument: null,
    nextOpenImage: null,
    savedFiles: [],
    savedBinaries: [],
    title: '',
    files: {
      openDocument: async () => platform.nextOpenDocument,
      saveDocumentAs: async (text) => {
        platform.savedFiles.push({ path: '/fake/saved.AIR', text });
        return { path: '/fake/saved.AIR' };
      },
      saveDocumentTo: async (path, text) => {
        platform.savedFiles.push({ path, text });
        return { path };
      },
      openImage: async () => platform.nextOpenImage,
      saveBinary: async (bytes, name, mime) => {
        platform.savedBinaries.push({ name, mime, bytes });
        return { path: `/fake/${name}` };
      },
    },
    storage: {
      get: async (key) => platform.storageMap.get(key) ?? null,
      set: async (key, value) => {
        platform.storageMap.set(key, value);
      },
      delete: async (key) => {
        platform.storageMap.delete(key);
      },
      keys: async (prefix) => [...platform.storageMap.keys()].filter((k) => k.startsWith(prefix)),
    },
    clipboard: {
      readText: async () => platform.clipboardText,
      writeText: async (text) => {
        platform.clipboardText = text;
      },
    },
    menu: null,
    window: {
      setTitle: (title) => {
        platform.title = title;
      },
      openModeling: () => {},
      openRender: null,
    },
    studio: null,
  };
  return platform;
}

/** A 1×1 transparent PNG. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function fakeCatalog(root?: CatalogFolder): AssetCatalog {
  const sofa: CatalogAsset = {
    id: 'Furnish/Seating/sofa',
    path: 'Furnish/Seating/sofa',
    name: 'Sofa',
    kind: 'asset',
    image: { url: 'catalog/Furnish/Seating/sofa/2d.png' },
    model: { path: '3d.glb', format: 'glb', url: 'catalog/Furnish/Seating/sofa/3d.glb' },
    size: { width: 2000, height: 900 },
  };
  const tree: CatalogFolder = root ?? {
    path: '',
    name: 'Library',
    folders: [
      {
        path: 'Furnish',
        name: 'Furnish',
        folders: [{ path: 'Furnish/Seating', name: 'Seating', folders: [], assets: [sofa] }],
        assets: [],
      },
    ],
    assets: [],
  };
  return {
    source: 'fake-catalog',
    load: async () => tree,
    fetchImage: async (): Promise<FetchedImage> => ({
      mime: 'image/png',
      bytes: Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0)),
      width: 1,
      height: 1,
    }),
  };
}

export interface TestApp {
  store: AppStore;
  executor: CommandExecutor;
  registry: CommandRegistry;
  platform: FakePlatform;
  catalog: AssetCatalog;
  ids: IdSource;
  clock: { now: string };
}

export function createTestApp(): TestApp {
  const ids = sequentialIds();
  const clock = { now: '2026-01-01T00:00:00.000Z' };
  const store = createAppStore({ ids, now: () => clock.now });
  const registry = new CommandRegistry().register(...builtinCommands);
  const platform = fakePlatform();
  const baseCatalog = fakeCatalog();
  const localStore = createLocalCaiStore(platform);
  const catalog = new HybridCaiCatalog(baseCatalog, localStore);
  const executor = new CommandExecutor(registry, store, {
    ids,
    now: () => clock.now,
    measurer: monospaceMeasurer,
    platform,
    catalog,
    devChecks: true,
  });
  return { store, executor, registry, platform, catalog, ids, clock };
}

/** Dispatches a mutation and throws on failure so tests read naturally. */
export function run<R = unknown>(app: TestApp, commandId: string, input?: unknown): R {
  const result = app.executor.dispatchSync(commandId, input);
  if (!result.ok) throw new Error(`${commandId} failed: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? '')}`);
  return result.value as R;
}

export async function runAsync<R = unknown>(app: TestApp, commandId: string, input?: unknown): Promise<R> {
  const result = await app.executor.dispatch(commandId, input);
  if (!result.ok) throw new Error(`${commandId} failed: ${result.error.code} ${result.error.message}`);
  return result.value as R;
}
