import type { ArchaiDocument } from '@/document';
import type { AssetCatalog } from '@/catalog/types';
import { paint } from '@/progress';

export interface ProjectLoadingState {
  name: string;
  detail: string;
  fraction: number;
}

export interface ProjectLoadTask {
  update(detail: string, fraction: number): void;
  expectBoard(id: string): void;
  paint(): Promise<void>;
}

let state: ProjectLoadingState | null = null;
let attached = false;
let expected: string | null = null;
let ready: Promise<void> | null = null;
let resolveReady: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const projectLoading = {
  getSnapshot: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  attach() { attached = true; },
  boardReady(id: string) { if (expected === id) resolveReady?.(); },
};

/** Keep the overlay through resource preparation, editor commit and its first painted frame. */
export async function withProjectLoading<T>(name: string, work: (task: ProjectLoadTask) => Promise<T>): Promise<T> {
  if (state) throw new Error('A project is already opening. Please wait.');
  state = { name, detail: 'Reading project', fraction: 0.05 };
  emit();
  const task: ProjectLoadTask = {
    update(detail, fraction) {
      state = { name, detail, fraction: Math.max(state?.fraction ?? 0, Math.min(1, fraction)) };
      emit();
    },
    expectBoard(id) {
      expected = id;
      if (attached) ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    },
    paint,
  };
  try {
    await paint();
    const result = await work(task);
    if (ready && result !== false) await ready;
    if (result !== false) {
      task.update('Ready', 1);
      await paint();
      await paint();
    }
    return result;
  } finally {
    state = null;
    expected = null;
    ready = null;
    resolveReady = null;
    emit();
  }
}

/** Warm the resources used by the initial board before mounting thousands of SVG nodes. */
export async function prepareProjectBoard(doc: ArchaiDocument, task: ProjectLoadTask, catalog?: AssetCatalog): Promise<void> {
  task.update('Preparing drawing', 0.45);
  await task.paint();
  const { meshPlanStore } = await import('@/render/meshPlan');
  await meshPlanStore.prepare(doc, (done, total) => task.update('Preparing drawing', 0.45 + 0.35 * done / Math.max(1, total)));
  if (typeof window !== 'undefined' && catalog) {
    task.update('Preparing assets', 0.82);
    await task.paint();
    const { topViewStore } = await import('@/render/lodViews');
    await topViewStore.prepare(doc, catalog);
    if (Object.values(doc.elements).some((element) => element.visible && element.meta?.['view3d'])) {
      task.update('Preparing 3D views', 0.88);
      await task.paint();
      const [{ modelStore, textureStore }, { meshStore }] = await Promise.all([import('@/view3d/assets'), import('@/view3d/meshes')]);
      modelStore.configure(catalog);
      await Promise.all([modelStore.prepare(doc), textureStore.prepare(doc), meshStore.prepare(doc)]);
    }
  }
  task.update('Opening workspace', 0.94);
  await task.paint();
  task.expectBoard(doc.id);
}

export async function finishProjectBoard(doc: ArchaiDocument, task: ProjectLoadTask): Promise<void> {
  const { indexedHitCandidates } = await import('@/geometry/hitIndex');
  indexedHitCandidates(doc.elements, { x: 0, y: 0 }, 0);
  task.update('Opening workspace', 0.98);
  await task.paint();
}
