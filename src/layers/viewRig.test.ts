import { describe, expect, it } from 'vitest';
import type { ArchaiDocument, Element, LineElement } from '@/document';
import { applyToPoint, worldMatrix } from '@/geometry';
import { parseDocument, serializeDocument } from '@/persistence/serialize';
import { selectableTarget } from '@/selection';
import { createTestApp, run } from '@/test/harness';
import { sectionOf } from '@/view3d/useSceneView';
import { layerParentOf } from './hierarchy';
import { rigHandleAt, viewRigKind, wrapLegacyViewRigs } from './viewRig';

type App = ReturnType<typeof createTestApp>;

const elements = (app: App) => app.store.getState().doc.elements;

/** A marker's end points in world space. */
function markerEnds(app: App, id: string): [number, number][] {
  const marker = elements(app)[id] as LineElement;
  const m = worldMatrix(elements(app), marker);
  return [marker.points[0]!, marker.points.at(-1)!].map(([x, y]) => {
    const p = applyToPoint(m, { x, y });
    return [Math.round(p.x), Math.round(p.y)];
  });
}

function camera(app: App, viewId: string) {
  const view = elements(app)[viewId]!.meta!['view3d'] as { cameraId: string; camera: { position: number[]; target: number[] } };
  return { markerId: view.cameraId, position: view.camera.position.map(Math.round), target: view.camera.target.map(Math.round) };
}

function worldOrigin(app: App, id: string) {
  const p = applyToPoint(worldMatrix(elements(app), elements(app)[id]!), { x: 0, y: 0 });
  return [Math.round(p.x), Math.round(p.y)];
}

describe('camera and section rigs', () => {
  it('creates an origin holding the view and the marker', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [1000, 2000], b: [5000, 2000] });
    const { markerId } = camera(app, viewId);
    const rig = elements(app)[elements(app)[viewId]!.parentId!]!;
    expect(viewRigKind(rig)).toBe('camera');
    expect(rig.name).toBe('Camera 1');
    expect(elements(app)[markerId]!.parentId).toBe(rig.id);
    expect(worldOrigin(app, rig.id)).toEqual([1000, 2000]);
    expect(markerEnds(app, markerId)).toEqual([[1000, 2000], [5000, 2000]]);
    // Layers list the marker under the rig, and picking a view selects the view itself.
    expect(layerParentOf(elements(app), markerId)).toBe(rig.id);
    expect(selectableTarget(elements(app), elements(app)[viewId]!).id).toBe(viewId);
  });

  it('moving the view leaves the camera; moving the origin moves both and re-aims the view', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [1000, 2000], b: [5000, 2000] });
    const { markerId } = camera(app, viewId);
    const rigId = elements(app)[viewId]!.parentId!;

    const viewBefore = worldOrigin(app, viewId);
    run(app, 'move-selection', { ids: [viewId], dx: 3000, dy: 0 });
    expect(worldOrigin(app, viewId)).toEqual([viewBefore[0]! + 3000, viewBefore[1]!]);
    expect(markerEnds(app, markerId)).toEqual([[1000, 2000], [5000, 2000]]);
    expect(camera(app, viewId).position).toEqual([1000, 1600, 2000]);

    run(app, 'move-selection', { ids: [rigId], dx: 500, dy: 700 });
    expect(markerEnds(app, markerId)).toEqual([[1500, 2700], [5500, 2700]]);
    expect(camera(app, viewId).position).toEqual([1500, 1600, 2700]);
    expect(camera(app, viewId).target).toEqual([5500, 1600, 2700]);
    expect(worldOrigin(app, viewId)).toEqual([viewBefore[0]! + 3500, viewBefore[1]! + 700]);
  });

  it('orbiting the view re-aims the marker in place, without drifting', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [1000, 2000], b: [5000, 2000] });
    const { markerId } = camera(app, viewId);
    run(app, 'move-selection', { ids: [elements(app)[viewId]!.parentId!], dx: 3000, dy: 3000 });
    // The 3D view reports its camera in world coordinates (as SceneView does after an orbit).
    const orbit = { position: [4000, 1600, 5000] as [number, number, number], target: [4000, 1600, 9000] as [number, number, number], fov: 60 };
    for (let i = 0; i < 3; i++) run(app, 'set-view3d-camera', { id: viewId, camera: orbit });
    expect(markerEnds(app, markerId)).toEqual([[4000, 5000], [4000, 9000]]);
    expect(camera(app, viewId).position).toEqual([4000, 1600, 5000]);
  });

  it('sections follow their origin too', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-section-view', { a: [0, 0], b: [4000, 0] });
    const lineId = (elements(app)[viewId]!.meta!['view3d'] as { sectionLineId: string }).sectionLineId;
    const rigId = elements(app)[viewId]!.parentId!;
    expect(viewRigKind(elements(app)[rigId]!)).toBe('section');
    expect(worldOrigin(app, rigId)).toEqual([2000, 0]);
    run(app, 'move-selection', { ids: [rigId], dx: 0, dy: 1000 });
    expect(markerEnds(app, lineId)).toEqual([[0, 1000], [4000, 1000]]);
  });

  it('duplicates as an independent camera and disappears with its last view', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [0, 0], b: [3000, 0] });
    const rigId = elements(app)[viewId]!.parentId!;
    const [copyRigId] = run<string[]>(app, 'duplicate-selection', { ids: [rigId] });
    const copyView = Object.values(elements(app)).find((element) => element.parentId === copyRigId && element.meta?.['view3d'])!;
    const copyMarker = camera(app, copyView.id).markerId;
    expect(elements(app)[copyMarker]!.parentId).toBe(copyRigId);
    expect(copyMarker).not.toBe(camera(app, viewId).markerId);

    run(app, 'delete-selection', { ids: [viewId] });
    expect(elements(app)[rigId]).toBeUndefined();
    expect(elements(app)[copyRigId!]).toBeDefined();
  });

  it('grabs the origin through its screen-size handle', () => {
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [1000, 1000], b: [4000, 1000] });
    const rigId = elements(app)[viewId]!.parentId!;
    const viewport = { x: 0, y: 0, zoom: 0.1 };
    expect(rigHandleAt(elements(app), viewport, { x: 103, y: 99 }, 8)?.id).toBe(rigId);
    expect(rigHandleAt(elements(app), viewport, { x: 130, y: 100 }, 8)).toBeNull();
  });

  it('gives a level a plan view: an origin in the level holding the view and its region', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 1000, y: 2000, width: 8000, height: 6000, elevation: 3000, name: 'Level 2', planView: true });
    const rig = Object.values(elements(app)).find((element) => viewRigKind(element) === 'plan')!;
    expect(rig.parentId).toBe(levelId);
    expect(rig.name).toBe('Level 2 plan');
    expect(worldOrigin(app, rig.id)).toEqual([5000, 5000]);
    const view = Object.values(elements(app)).find((element) => element.parentId === rig.id && element.meta?.['view3d'])!;
    const regionId = (view.meta!['view3d'] as { planRegionId: string }).planRegionId;
    expect(elements(app)[regionId]!.parentId).toBe(rig.id);
    // The view cuts the level 1200 above its elevation, over the level's extent.
    const cut = sectionOf(app.store.getState().doc, view.id)!;
    expect(cut.plan).toEqual({ elevation: 3000, cutHeight: 1200, width: 8000, height: 6000 });
    expect([cut.x, cut.y]).toEqual([5000, 5000]);
    // Clicking the origin handle picks the rig, not the level around it.
    expect(selectableTarget(elements(app), elements(app)[rig.id]!).id).toBe(rig.id);
    expect(layerParentOf(elements(app), rig.id)).toBe(levelId);

    // The plan follows the level's elevation and its own cut height.
    run(app, 'set-level-elevation', { id: levelId, elevation: 6000 });
    run(app, 'set-plan-cut-height', { id: view.id, cutHeight: 1500 });
    expect(sectionOf(app.store.getState().doc, view.id)!.plan).toMatchObject({ elevation: 6000, cutHeight: 1500 });

    // Moving the view leaves the region; moving the origin moves the region (what the plan shows).
    run(app, 'move-selection', { ids: [view.id], dx: 2000, dy: 0 });
    expect(sectionOf(app.store.getState().doc, view.id)!.x).toBe(5000);
    run(app, 'move-selection', { ids: [rig.id], dx: 500, dy: -400 });
    const moved = sectionOf(app.store.getState().doc, view.id)!;
    expect([moved.x, moved.y]).toEqual([5500, 4600]);
    expect(worldOrigin(app, levelId)).toEqual([1000, 2000]);

    // Deleting the view takes its region and origin with it; the level stays.
    run(app, 'delete-selection', { ids: [view.id] });
    expect(elements(app)[regionId]).toBeUndefined();
    expect(elements(app)[rig.id]).toBeUndefined();
    expect(elements(app)[levelId]).toBeDefined();
  });

  it('adds plan views to existing levels', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 0, name: 'Ground' });
    expect(Object.values(elements(app)).some((element) => viewRigKind(element))).toBe(false);
    run(app, 'create-level-view', { id: levelId });
    run(app, 'create-level-view', { id: levelId });
    const names = Object.values(elements(app)).filter((element) => viewRigKind(element) === 'plan').map((element) => element.name).sort();
    expect(names).toEqual(['Ground plan', 'Ground plan 2']);
  });

  it('wraps cameras and sections from older documents without moving anything', () => {
    // An old document: view and marker side by side at the board root.
    const app = createTestApp();
    const viewId = run<string>(app, 'create-camera-view', { a: [1000, 2000], b: [5000, 2000] });
    const doc = app.store.getState().doc;
    const rigId = doc.elements[viewId]!.parentId!;
    const flat: Record<string, Element> = {};
    for (const element of Object.values(doc.elements)) {
      if (element.id === rigId) continue;
      flat[element.id] = element.parentId === rigId ? { ...element, parentId: null, x: element.x + doc.elements[rigId]!.x, y: element.y + doc.elements[rigId]!.y } : element;
    }
    flat[viewId] = { ...flat[viewId]!, name: 'Camera 1' };
    const legacy: ArchaiDocument = { ...doc, elements: flat };

    const parsed = parseDocument(serializeDocument(legacy));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const wrapped = parsed.document.elements;
    const rig = Object.values(wrapped).find((element) => viewRigKind(element))!;
    expect(rig.name).toBe('Camera 1');
    expect(wrapped[viewId]!.parentId).toBe(rig.id);
    expect(wrapped[viewId]!.name).toBe('Camera 1 view');
    // Same world positions as before the conversion.
    for (const id of Object.keys(flat)) {
      const before = applyToPoint(worldMatrix(flat, flat[id]!), { x: 0, y: 0 });
      const after = applyToPoint(worldMatrix(wrapped, wrapped[id]!), { x: 0, y: 0 });
      expect([after.x, after.y]).toEqual([before.x, before.y]);
    }
    // Converting again changes nothing.
    expect(wrapLegacyViewRigs(parsed.document)).toBe(parsed.document);
  });
});
