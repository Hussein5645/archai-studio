/**
 * The Live Bridge between the board (main window) and ArchAI Render (the studio window), over
 * `platform.studio` (an IPC relay on desktop, a BroadcastChannel between browser tabs):
 *
 *   studio → board  { type: 'hello' }   the studio started (repeated until a scene arrives)
 *   board → studio  { type: 'scene', docId, name, doc, camera?, viewName? }
 *                                        the document, again after every edit (debounced);
 *                                        `camera` only when the user sent a particular view
 *   studio → board  { type: 'bye' }     the studio closed
 *   studio → board  { type: 'paint', target, scope, material, assetSlots }
 *                                        a material painted in the studio (see PaintMessage);
 *                                        the board applies it like a 3D view's paint click
 *   studio → board  { type: 'material-update', id, patch }   quick material edits (one undo step)
 *   studio → board  { type: 'material-unique', target, materialId }   a copy for the picked part
 *
 * Kept free of three.js so the board's bundle does not grow.
 */
import type { ArchaiDocument } from '@/document';
import type { Platform } from '@/platform/types';
import type { AppServices } from '@/app/context';
import type { AppStore } from '@/store';
import type { CameraState, SurfaceTarget } from '@/view3d/SceneView';
import type { PaintScope } from '@/materials/uiStore';
import { paintTarget } from '@/materials/paint';
import { libraryMaterialToProject, loadMaterialLibrary } from '@/materials/library';

export interface SceneMessage {
  type: 'scene';
  docId: string;
  name: string;
  doc: ArchaiDocument;
  /** Millimetres, scene axes (x, up, board y), as the 3D views store it. */
  camera?: CameraState;
  viewName?: string;
  /** One-shot request from the D5 import workflow; publishing still follows preview. */
  prepare?: 'bake';
}

/** A paint click in the studio: a project material, or a library material to add first. */
export interface PaintMessage {
  type: 'paint';
  target: SurfaceTarget;
  scope: PaintScope;
  material: { id: string } | { library: string };
  /** Model material slots of the clicked element (for "Object"). */
  assetSlots: string[];
}

const DEBOUNCE_MS = 400;

let studioOpen = false;
let pending: { camera?: CameraState; viewName?: string; prepare?: 'bake' } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started: { platform: Platform; store: AppStore; services: Pick<AppServices, 'executor' | 'toasts'> | null } | null = null;

function sendScene(): void {
  if (!started?.platform.studio) return;
  const { doc } = started.store.getState();
  const message: SceneMessage = { type: 'scene', docId: doc.id, name: doc.meta.name || 'Untitled', doc, ...(pending ?? {}) };
  pending = null;
  started.platform.studio.send(message as unknown as { type: string } & Record<string, unknown>);
}

/** Board side, once at boot: answers the studio and streams document edits to it while it is open. */
export function startBoardLink(platform: Platform, store: AppStore, services: Pick<AppServices, 'executor' | 'toasts'> | null = null): void {
  if (!platform.studio || started) return;
  started = { platform, store, services };
  platform.studio.subscribe((message) => {
    if (message.type === 'hello') {
      studioOpen = true;
      sendScene();
    } else if (message.type === 'bye') {
      studioOpen = false;
    } else if (message.type === 'paint' && services) {
      void applyPaint(message as unknown as PaintMessage, store, services);
    } else if (message.type === 'material-update' && services) {
      const { id, patch } = message as unknown as { id: string; patch: Record<string, unknown> };
      void services.executor.dispatch('update-material', { id, patch }).then((result) => {
        if (!result.ok) services.toasts.push({ kind: 'error', message: result.error.message });
      });
    } else if (message.type === 'material-unique' && services) {
      void makeUnique(message as unknown as UniqueMessage, store, services);
    }
  });
  let lastDoc = store.getState().doc;
  store.subscribe((state) => {
    if (!studioOpen || state.doc === lastDoc) return;
    lastDoc = state.doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(sendScene, DEBOUNCE_MS);
  });
}

/** Applies a studio paint click on the board (one undo step there; the studio gets the new scene). */
async function applyPaint(message: PaintMessage, store: AppStore, services: Pick<AppServices, 'executor' | 'toasts'>): Promise<void> {
  const app = { ...services, store };
  try {
    let materialId: string;
    if ('library' in message.material) {
      const id = message.material.library;
      const entry = (await loadMaterialLibrary()).materials.find((m) => m.id === id);
      if (!entry) throw new Error('This material is no longer in the library');
      materialId = await libraryMaterialToProject((command, input) => services.executor.dispatch(command, input), store.getState().doc, entry);
    } else materialId = message.material.id;
    const [{ assetMaterialNames }, { meshStore, meshOf }, { modelStore }] = await Promise.all([
      import('@/view3d/geometry'), import('@/view3d/meshes'), import('@/view3d/assets'),
    ]);
    paintTarget(app, message.target, message.scope, materialId, { assetSlotsOf: (id) => {
      if (id === message.target.elementId) return message.assetSlots;
      const element = store.getState().doc.elements[id];
      const mesh = meshOf(element);
      return assetMaterialNames(mesh ? meshStore.models.get(mesh.blobId) : element?.kind === 'instance' ? modelStore.models.get(element.definitionId) : undefined).map((name) => `asset:${name}`);
    } });
  } catch (error) {
    services.toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

export interface UniqueMessage {
  type: 'material-unique';
  target: SurfaceTarget;
  materialId: string;
  /** Recorded as the copy's `source` (`unique:<nonce>`) so the studio can find the copy in the next scene. */
  nonce: string;
}

/** Gives the picked face (or part) its own copy of a material, so studio edits apply to it only. */
async function makeUnique(message: UniqueMessage, store: AppStore, services: Pick<AppServices, 'executor' | 'toasts'>): Promise<void> {
  const copy = await services.executor.dispatch('duplicate-material', { id: message.materialId });
  if (!copy.ok) {
    services.toasts.push({ kind: 'error', message: copy.error.message });
    return;
  }
  const id = copy.value as string;
  const name = store.getState().doc.materials[id]?.name.replace(/ copy$/, '') ?? 'Material';
  await services.executor.dispatch('update-material', { id, patch: { name: `${name} (own)`.slice(0, 80), source: `unique:${message.nonce}` } });
  paintTarget({ ...services, store }, message.target, message.target.surface ? 'face' : 'part', id, null);
}

/** Whether this host can run ArchAI Render. */
export function canRender(platform: Platform): boolean {
  return Boolean(platform.window.openRender && platform.studio);
}

/** Opens ArchAI Render on the document, looking through `camera` when given (a 3D view's camera). */
export function openRenderStudio(platform: Platform, camera?: CameraState, viewName?: string, bake = false): void {
  if (!platform.window.openRender) return;
  pending = { ...(camera ? { camera } : {}), ...(viewName ? { viewName } : {}), ...(bake ? { prepare: 'bake' } : {}) };
  platform.window.openRender();
  // Already open: it will not say hello again, so send the view now.
  if (studioOpen) sendScene();
}
