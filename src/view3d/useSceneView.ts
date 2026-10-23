import { documentInContext, viewContext } from '@/document/viewVisibility';
import { saveViewPreview } from './viewPreview';
import { scenePlacement } from './placement';
import { noiseEmitterOf } from '@/analysis/model';
import { isPoint } from '@/document/point';
/**
 * Mounts a SceneView in a container and wires it to the app: document and selection flow in,
 * clicks and gizmo drags flow out as the board's own commands (previewed while dragging,
 * committed once on release, so a 3D drag is one undo step like a 2D drag).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { useApp } from '@/app/context';
import type { ArchaiDocument } from '@/document';
import type { AppState } from '@/store';
import { applyToPoint, worldMatrix } from '@/geometry';
import { selectableTarget } from '@/selection';
import { editableGroup, selectionScope } from '@/selection/groupScope';
import { levelOfPlanRegion, planRegionOf } from '@/layers/viewRig';
import { modelStore } from './assets';
import { viewAnalysis } from '@/analysis/model';
import { mountedViews, SceneView, type CameraState, type SectionCut, type ViewStyle } from './SceneView';
import { materialUi } from '@/materials/uiStore';
import { paintTarget } from '@/materials/paint';
import { cameraNavigationLocked } from '@/document/viewCamera';
import { paint } from '@/progress';

export interface ResolvedSectionCut extends SectionCut {
  length: number;
  lineId?: string;
}

export function sectionOf(doc: ArchaiDocument, portalId: string | null): ResolvedSectionCut | null {
  const portal = portalId ? doc.elements[portalId] : undefined;
  const meta = portal?.meta;
  const view = meta?.['view3d'];
  const lineId = view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>)['sectionLineId'] : null;
  const line = typeof lineId === 'string' ? doc.elements[lineId] : undefined;
  if (line?.kind === 'line' && line.points.length >= 2) {
    const matrix = worldMatrix(doc.elements, line);
    const a = applyToPoint(matrix, { x: line.points[0]![0], y: line.points[0]![1] });
    const last = line.points.at(-1)!;
    const b = applyToPoint(matrix, { x: last[0], y: last[1] });
    const directionMeta = line.meta?.['sectionLine'];
    const direction = directionMeta && typeof directionMeta === 'object' && !Array.isArray(directionMeta) && (directionMeta as Record<string, unknown>)['direction'] === -1 ? -1 : 1;
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + (direction < 0 ? 180 : 0),
      length: Math.hypot(b.x - a.x, b.y - a.y),
      depth: viewSettingsOf(doc, portalId).depth,
      lineId: line.id,
    };
  }
  const regionId = view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>)['planRegionId'] : null;
  const region = typeof regionId === 'string' ? doc.elements[regionId] : undefined;
  if (region?.kind === 'rect') {
    // A level plan: the region's centre and turn, cut at the level's elevation + cut height.
    const matrix = worldMatrix(doc.elements, region);
    const centre = applyToPoint(matrix, { x: region.width / 2, y: region.height / 2 });
    const settings = planRegionOf(region);
    return {
      x: centre.x,
      y: centre.y,
      angle: (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI,
      length: region.width,
      depth: viewSettingsOf(doc, portalId).depth,
      plan: { elevation: levelOfPlanRegion(doc.elements, region)?.elevation ?? 0, cutHeight: settings.cutHeight, width: region.width, height: region.height },
      lineId: region.id,
    };
  }
  const cut = view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>)['cut'] : null;
  if (!cut || typeof cut !== 'object' || Array.isArray(cut)) return null;
  const value = cut as Record<string, unknown>;
  return typeof value['x'] === 'number' && typeof value['y'] === 'number' && typeof value['angle'] === 'number' ? { x: value['x'], y: value['y'], angle: value['angle'], length: typeof value['length'] === 'number' ? value['length'] : 4000 } : null;
}

/** Display settings stored on a view portal (`meta.view3d.style` / `lod` / `depth`). */
export interface PortalViewSettings {
  style: ViewStyle | null;
  lod: 'high' | 'low' | null;
  depth: number;
}

export function viewSettingsOf(doc: ArchaiDocument, portalId: string | null): PortalViewSettings {
  const view = portalId ? doc.elements[portalId]?.meta?.['view3d'] : null;
  const value = view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>) : {};
  const style = value['style'];
  const lod = value['lod'];
  const depth = value['depth'];
  return {
    style: style === 'realistic' || style === 'wireframe' || style === 'shaded' || style === 'consistent' || style === 'hidden-line' ? style : null,
    lod: lod === 'high' || lod === 'low' ? lod : null,
    depth: typeof depth === 'number' && depth > 0 ? depth : 0,
  };
}

export { paintTarget } from '@/materials/paint';

/** Quiet period after the last document change before a board thumbnail rebuilds its scene. */
const THUMBNAIL_SETTLE_MS = 150;

function sameCamera(a: CameraState, b: CameraState): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 0.5;
  return a.position.every((v, i) => close(v, b.position[i]!)) && a.target.every((v, i) => close(v, b.target[i]!)) && (a.fov === undefined || b.fov === undefined || close(a.fov, b.fov));
}

export type SceneLoading = { detail: string; error?: boolean; updating?: boolean } | null;

export function useSceneView(containerRef: RefObject<HTMLElement | null>, portalId: string | null, onOpen?: () => void, onLoading?: (state: SceneLoading) => void, enabled = true) {
  const { store, executor, catalog, toasts, platform } = useApp();
  const viewRef = useRef<SceneView | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    let stopped = false;
    let cleanup = () => {};
    onLoading?.({ detail: 'Preparing 3D view' });
    void (async () => {
    await paint();
    if (stopped) return;
    modelStore.configure(catalog);
    let base: ArchaiDocument | null = null;
    let initialising = true;

    const portal = portalId ? store.getState().doc.elements[portalId] : undefined;
    const view3dMeta = portal?.meta?.['view3d'] as { camera?: CameraState | null; cameraMode?: boolean; cameraId?: string } | undefined;
    const initial = view3dMeta?.camera ?? undefined;
    const isCameraMode = Boolean(view3dMeta?.cameraMode || view3dMeta?.cameraId);
    const section = sectionOf(store.getState().doc, portalId);
    const placement = scenePlacement({ store, executor, toasts });
    const placementKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === 'Enter') placement.finish();
      if (event.key === 'Escape') placement.cancel();
    };
    container.addEventListener('keydown', placementKey);
    const view = new SceneView(
      container,
      {
        onPlaceElement: onOpen ? undefined : placement.place,
        onSelect: (id, additive) => {
          const state = store.getState();
          if (!id) {
            if (!additive) void executor.dispatch('select', { ids: [] });
            return;
          }
          const element = state.doc.elements[id];
          if (!element) return;
          const target = noiseEmitterOf(element) || isPoint(element) ? element : selectableTarget(state.doc.elements, element, false, selectionScope(state.ui));
          void executor.dispatch('select', { ids: [target.id], mode: additive ? 'toggle' : 'replace' });
        },
        onTransform: ({ ids, dx, dy, dz, degrees, pivot }, commit) => {
          if (!base) base = store.getState().doc;
          const rotate = Math.abs(degrees) > 1e-6;
          // Emitters and reference points move in height too.
          // A vertical drag changes elevation (the gizmo only offers it when no level controls it).
          const emitterMove = !rotate && (Math.abs(dz) > 1e-6 || ids.every((id) => noiseEmitterOf(base!.elements[id]) || isPoint(base!.elements[id])));
          const command = rotate ? 'rotate-selection' : emitterMove ? 'move-points' : 'move-selection';
          const input = rotate ? { ids, degrees, pivot } : emitterMove ? { ids, dx, dy, dz } : { ids, dx, dy };
          if (!commit) {
            try {
              store.setState({ preview: executor.preview(command, input, base) });
            } catch {
              // an invalid preview leaves the document as it was
            }
            return;
          }
          const clearPreview = () => {
            if (store.getState().preview) store.setState({ preview: null });
          };
          const moved = rotate ? rotate : Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6;
          base = null;
          if (!moved) {
            clearPreview();
            return;
          }
          // A successful commit clears the preview in the same update, so the base never flashes.
          void executor.dispatch(command, input).then((result) => {
            if (result.ok) return;
            clearPreview();
            if (result.error.code !== 'unavailable') toasts.push({ kind: 'error', message: result.error.message });
          });
        },
        onCameraChange: (camera) => {
          if (portalId) void executor.dispatch('set-view3d-camera', { id: portalId, camera });
        },
        onUpdate: (state) => { if (!stopped) onLoading?.(state ? { ...state, updating: true } : null); },
        onOpen,
        onEnterGroup: (id) => {
          const state = store.getState();
          if (!id) { if (state.ui.groupEditId) void executor.dispatch('exit-group'); return; }
          const element = state.doc.elements[id];
          if (!element) return;
          const target = selectableTarget(state.doc.elements, element, false, selectionScope(state.ui));
          if (editableGroup(target)) void executor.dispatch('enter-group', { id: target.id });
        },
        onPlaceStop: (stop) => {
          void executor.dispatch('create-vr-stop', stop).then((result) => {
            if (!result.ok) toasts.push({ kind: 'error', message: result.error.message });
          });
        },
        onPlaceMiss: () => toasts.push({ kind: 'info', message: 'Click a floor to place the VR stop' }),
        onPaint: (target, scope) => paintTarget({ executor, toasts, store }, target, scope, materialUi.get().active, viewRef.current),
        onEyedrop: (target) => {
          if (!target.materialId) {
            toasts.push({ kind: 'info', message: "This part shows its model's own material: paint it to give it one you can adjust" });
            return;
          }
          // The picked material goes in hand and its quick panel opens on it.
          materialUi.set({ active: target.materialId, adjusting: { materialId: target.materialId, target } });
        },
      },
      initial ?? undefined,
      section,
      isCameraMode,
    );
    viewRef.current = view;
    if (portalId) mountedViews.set(portalId, view);
    // Each portal remembers its own style and level of detail; the document's are the fallback.
    const applySettings = (doc: ArchaiDocument) => {
      view.setNavigationLocked(cameraNavigationLocked(doc, portalId));
      const settings = viewSettingsOf(doc, portalId);
      view.setViewStyle(settings.style ?? (section ? 'hidden-line' : doc.workspace.viewStyle));
      view.setLod(settings.lod);
      view.setAnalysis(viewAnalysis(doc, portalId));
    };
    applySettings(store.getState().doc);
    const placing = () => !onOpen && !['select', 'hand'].includes(store.getState().ui.tool);
    view.setPlacementMode(placing());
    view.setSelection(store.getState().ui.selection);
    view.setGroupScope(store.getState().ui.groupEditId);
    // Rebuilding the scene costs O(document), and a drag streams a new document every
    // pointermove, so documents are never applied per store update. The full-screen view (no
    // onOpen) catches up once per frame; board thumbnails wait until edits settle and skip
    // rebuilding altogether while scrolled out of sight.
    const thumbnail = onOpen !== undefined;
    let pending: ArchaiDocument | null = null;
    let visible = true;
    let frame = 0;
    let timer = 0;
    const applyPending = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = 0;
      timer = 0;
      const doc = pending;
      if (!doc || !visible) return;
      pending = null;
      view.setSection(sectionOf(doc, portalId));
      applySettings(doc);
      view.setDocument(doc);
      // A camera marker moved on the board: aim the live view at the new eye/aim point.
      const next = portalId ? (doc.elements[portalId]?.meta?.['view3d'] as { camera?: CameraState | null } | undefined)?.camera : null;
      if (next && !sameCamera(next, view.getCamera())) view.setCamera(next);
    };
    const schedule = () => {
      if (!pending || !visible || initialising) return;
      if (thumbnail) {
        clearTimeout(timer);
        timer = window.setTimeout(applyPending, THUMBNAIL_SETTLE_MS);
      } else if (!frame) {
        frame = requestAnimationFrame(applyPending);
      }
    };
    const observer =
      thumbnail && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            visible = entries.at(-1)?.isIntersecting ?? true;
            schedule();
          })
        : null;
    observer?.observe(container);
    // The full-screen view follows gesture previews (its own gizmo drags included); thumbnails
    // only show committed documents.
    const shown = (state: AppState) => documentInContext(thumbnail ? state.doc : state.preview ?? state.doc, viewContext(portalId));
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.ui.tool !== previous.ui.tool) view.setPlacementMode(placing());
      if (shown(state) !== shown(previous)) {
        pending = shown(state);
        schedule();
      }
      if (state.ui.selection !== previous.ui.selection) view.setSelection(state.ui.selection);
      if (state.ui.groupEditId !== previous.ui.groupEditId) view.setGroupScope(state.ui.groupEditId);
    });
    cleanup = () => {
      unsubscribe();
      container.removeEventListener('keydown', placementKey);
      if (!initialising && portalId) {
        try { void saveViewPreview(platform, store.getState().doc.id, portalId, view.renderImage(960, 600).toDataURL('image/jpeg', 0.8)).catch(() => undefined); } catch { /* Keep the last completed preview. */ }
      }
      observer?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      // Do not lose the last orbit/pan when the full-screen view closes before the
      // debounced camera callback fires; the board thumbnail must resume exactly here.
      if (!initialising && portalId && store.getState().doc.elements[portalId] && !cameraNavigationLocked(store.getState().doc, portalId)) executor.dispatchSync('set-view3d-camera', { id: portalId, camera: view.getCamera() });
      if (portalId && mountedViews.get(portalId) === view) mountedViews.delete(portalId);
      view.dispose();
      viewRef.current = null;
    };
    await view.initialise(documentInContext(store.getState().doc, viewContext(portalId)), (detail) => { if (!stopped) onLoading?.({ detail }); });
    if (stopped) return;
    initialising = false;
    if (pending) applyPending();
    view.setSelection(store.getState().ui.selection);
    view.setGroupScope(store.getState().ui.groupEditId);
    const material = materialUi.get();
    view.setPainting(material.painting && !section);
    view.setPicking(material.picking && !section);
    view.setPaintScope(material.scope);
    onLoading?.(null);
    })().catch((error: unknown) => {
      cleanup();
      if (!stopped) onLoading?.({ detail: error instanceof Error ? error.message : 'Could not open 3D view', error: true });
    });
    return () => { stopped = true; cleanup(); };
  }, [catalog, containerRef, executor, onOpen, onLoading, portalId, store, toasts, platform, enabled]);

  return viewRef;
}
