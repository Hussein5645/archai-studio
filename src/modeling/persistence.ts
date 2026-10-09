/**
 * Local autosave for the modeling workspace: one IndexedDB record per asset holding the store
 * data (metadata, layers, bodies, materials, cameras, planes, layout) and one binary record per imported GLB, so a
 * reopened window comes back exactly as it was left.
 */
import type { Body, PbrMaterial, Sketch, SketchPlane } from './kernel/types';
import type { Bindings, Parameter } from './parameters';
import type { Layer, Lod, ModelingCamera, ModelingState, PaneView, PlaneId, ViewStyle } from './store';

const DB_NAME = 'archai-modeling';
const ASSETS = 'assets';
const FILES = 'files';

export interface SavedAsset {
  id: string;
  savedAt: string;
  /** Project that owns this model. Missing means it was created in free-modeling mode. */
  project?: { id: string; name: string };
  metadata: ModelingState['metadata'];
  layers: Layer[];
  /** Modeled bodies as recipes; their meshes are regenerated on open. */
  bodies?: Body[];
  sketches?: Sketch[];
  /** Named parameters and the formulas binding them to recipe numbers (see ./parameters.ts). */
  parameters?: Parameter[];
  bindings?: Bindings;
  materials?: Record<string, PbrMaterial>;
  cameras: ModelingCamera[];
  planes: Record<PlaneId, number>;
  planeVisible?: Record<PlaneId, boolean>;
  workPlane?: SketchPlane;
  workPlaneVisible?: boolean;
  workPlaneLocked?: boolean;
  layout: ModelingState['layout'];
  panes: [PaneView, PaneView, PaneView, PaneView];
  styles: [ViewStyle, ViewStyle, ViewStyle, ViewStyle];
  lods?: [Lod, Lod, Lod, Lod];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ASSETS);
      request.result.createObjectStore(FILES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(name: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(name, mode);
        const request = fn(tx.objectStore(name));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export function snapshotOf(id: string, state: ModelingState, project?: SavedAsset['project']): SavedAsset {
  return {
    id,
    savedAt: new Date().toISOString(),
    ...(project ? { project } : {}),
    metadata: state.metadata,
    layers: state.layers,
    bodies: state.bodies,
    sketches: state.sketches,
    parameters: state.parameters,
    bindings: state.bindings,
    materials: state.materials,
    cameras: state.cameras,
    planes: state.planes,
    planeVisible: state.planeVisible,
    workPlane: state.workPlane,
    workPlaneVisible: state.workPlaneVisible,
    workPlaneLocked: state.workPlaneLocked,
    layout: state.layout,
    panes: state.panes,
    styles: state.styles,
    lods: state.lods,
  };
}

export const modelingStorage = {
  load: (id: string) => withStore<SavedAsset | undefined>(ASSETS, 'readonly', (store) => store.get(id)),
  save: (asset: SavedAsset) => withStore(ASSETS, 'readwrite', (store) => store.put(asset, asset.id)),
  delete: async (id: string) => {
    await withStore<undefined>(ASSETS, 'readwrite', (store) => store.delete(id));
    try {
      if (typeof indexedDB !== 'undefined') {
        const db = await openDb();
        const tx = db.transaction(FILES, 'readwrite');
        const store = tx.objectStore(FILES);
        const req = store.getAllKeys();
        req.onsuccess = () => {
          const keys = req.result as string[];
          for (const key of keys) {
            if (typeof key === 'string' && (key === id || key.startsWith(`${id}/`))) {
              store.delete(key);
            }
          }
        };
      }
    } catch {
      // Best effort file cleanup
    }
  },
  list: () => withStore<SavedAsset[]>(ASSETS, 'readonly', (store) => store.getAll()),
  loadFile: (assetId: string, layerId: string) => withStore<ArrayBuffer | undefined>(FILES, 'readonly', (store) => store.get(`${assetId}/${layerId}`)),
  saveFile: (assetId: string, layerId: string, bytes: ArrayBuffer) => withStore(FILES, 'readwrite', (store) => store.put(bytes, `${assetId}/${layerId}`)),
  deleteFile: (assetId: string, layerId: string) => withStore(FILES, 'readwrite', (store) => store.delete(`${assetId}/${layerId}`)),
};
