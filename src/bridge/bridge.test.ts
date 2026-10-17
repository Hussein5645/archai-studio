import { describe, expect, it } from 'vitest';
import { createTestApp, run, type TestApp } from '@/test/harness';
import type { ArchaiDocument, BridgeData, Element } from '@/document';
import { withoutLink } from '@/live/sync';
import type { BridgeSyncReport } from './engine';
import { flattenSourceGroups, pullPlan, type PullPlan } from './pull';
import { needsRevert, startBridgeGuard } from './guard';
import { childLookup, facetHashes } from './facets';

type Mesh = { id: string; name?: string; category?: string; origin: [number, number, number]; size: [number, number, number]; glb: string; archai?: string; was?: string };
type Wall = { id: string; points: [number, number][]; base: number; height: number; layers: { name: string; role: 'core'; thickness: number; material?: string }[]; level?: string };

const mesh = (id: string, x = 0, name = `Object ${id}`): Mesh => ({ id, name, category: 'Generic', origin: [x, 0, 0], size: [500, 500, 900], glb: 'AAAA' });
const wall = (id: string, y = 0, length = 4000): Wall => ({ id, points: [[0, y], [length, y]], base: 0, height: 3000, layers: [{ name: 'Core', role: 'core', thickness: 200, material: 'm1' }] });
const model = (parts: { meshes?: Mesh[]; walls?: Wall[]; openings?: unknown[]; app?: string; color?: string }) => ({
  archaiRevit: 1,
  app: parts.app ?? 'Rhino',
  name: 'House',
  materials: [{ id: 'm1', name: 'Plaster', color: parts.color ?? '#eeeeee' }],
  walls: parts.walls ?? [],
  openings: parts.openings ?? [],
  meshes: parts.meshes ?? [],
});

const sync = (app: TestApp, key: string, body: ReturnType<typeof model>, extra: Record<string, unknown> = {}) =>
  run<BridgeSyncReport>(app, 'bridge-sync', { key, app: body.app, name: 'House', model: body, ...extra });
const doc = (app: TestApp): ArchaiDocument => app.store.getState().doc;
/** Elements other than groups (each model sits in a source group). */
const real = (app: TestApp) => Object.values(doc(app).elements).filter((e) => e.kind !== 'group');
const bridge = (app: TestApp): BridgeData => doc(app).bridge!;
/** The element bound to `id` of source `key`. */
const bound = (app: TestApp, key: string, id: string): Element | undefined => {
  const entry = Object.entries(bridge(app).elements).find(([, binding]) => binding.refs[key]?.id === id);
  return entry ? doc(app).elements[entry[0]] : undefined;
};

it('replaces only the chosen app model and restores it with undo', async () => {
  const app = createTestApp();
  sync(app, 'old', model({ walls: [wall('a')], app: 'Revit' }));
  sync(app, 'other', model({ walls: [wall('b', 1000)], app: 'Rhino' }));
  const old = bound(app, 'old', 'a')!;
  const other = bound(app, 'other', 'b')!;
  const group = bridge(app).sources['old']!.groupId!;
  run(app, 'create-rect', { x: 5000, y: 5000, width: 100, height: 100 });
  const before = doc(app);
  run(app, 'bridge-link-source', { key: 'new', app: 'revit', name: 'Replacement', replace: 'old' });
  expect(doc(app).elements[old.id]).toBeUndefined();
  expect(doc(app).elements[group]).toBeUndefined();
  expect(doc(app).elements[other.id]).toBeDefined();
  expect(bridge(app).sources['old']).toBeUndefined();
  expect(bridge(app).sources['new']?.name).toBe('Replacement');
  expect(Object.keys(doc(app).elements)).toHaveLength(Object.keys(before.elements).length - 2);
  await app.executor.dispatch('undo');
  expect(doc(app).elements).toEqual(before.elements);
  expect(bridge(app).sources).toEqual(before.bridge!.sources);
});

it('refuses to replace a model from another app', () => {
  const app = createTestApp();
  sync(app, 'rhino-model', model({ walls: [wall('a')], app: 'Rhino' }));
  const before = doc(app);
  const result = app.executor.dispatchSync('bridge-link-source', { key: 'revit-model', app: 'Revit', name: 'Tower', replace: 'rhino-model' });
  expect(result.ok).toBe(false);
  expect(doc(app)).toBe(before);
});

describe('Live Bridge sync', () => {
  it('keeps local group normal repairs on source-controlled geometry without permission changes or outgoing edits', async () => {
    const app = createTestApp();
    sync(app, 'revit:normals', model({ app: 'Revit', meshes: [mesh('a'), mesh('b', 1000)] }));
    const a = bound(app, 'revit:normals', 'a')!, b = bound(app, 'revit:normals', 'b')!;
    const group = bridge(app).sources['revit:normals']!.groupId!;
    const before = doc(app);
    const hashes = facetHashes(childLookup(before.elements), before.elements[group]!);
    const authority = structuredClone(bridge(app).sources['revit:normals']!.authority);
    const originalBlob = a.meta?.['mesh'];
    const stop = startBridgeGuard(app.executor, app.store);
    try {
      run(app, 'auto-repair-group-normals', { ids: [group] });
      await new Promise((r) => setTimeout(r, 0));
      expect(needsRevert(doc(app), a.id)).toBe(false);
      expect(needsRevert(doc(app), b.id)).toBe(false);
      expect(facetHashes(childLookup(doc(app).elements), doc(app).elements[group]!)).toEqual(hashes);
      expect(doc(app).elements[a.id]!.meta?.['normalMode']).toBe('auto');
      expect(doc(app).elements[a.id]!.meta?.['mesh']).toEqual(originalBlob);
      expect(pullPlan(doc(app), 'revit:normals', null).updates).toEqual([]);
      expect(pullPlan(doc(app), 'revit:normals', null).nodes.has(a.id)).toBe(false);
      sync(app, 'revit:normals', model({ app: 'Revit', meshes: [{ ...mesh('a', 2000, 'Updated source'), glb: 'BBBB' }, mesh('b', 1000)] }));
      await new Promise((r) => setTimeout(r, 0));
      expect(doc(app).elements[a.id]).toMatchObject({ x: 2000, name: 'Updated source', meta: { normalMode: 'auto' } });
      expect(doc(app).elements[b.id]!.meta?.['normalMode']).toBe('auto');
      expect(bridge(app).sources['revit:normals']!.authority).toEqual(authority);
      expect(needsRevert(doc(app), a.id)).toBe(false);
      expect(bridge(app).conflicts).toEqual([]);
    } finally { stop(); }
  });
  it('keeps ArchAI whole-object paint while the source updates geometry, names and embedded material slots', () => {
    const app = createTestApp();
    sync(app, 'revit:paint', model({ meshes: [mesh('a')] }));
    const id = bound(app, 'revit:paint', 'a')!.id;
    const materialId = run<string>(app, 'create-material', { material: { name: 'ArchAI finish', color: '#ff5500' } });
    const stop = startBridgeGuard(app.executor, app.store);
    run(app, 'paint-element', { ids: [id], materialId, assetSlots: ['asset:Old source finish'] });
    expect(needsRevert(doc(app), id)).toBe(false);
    sync(app, 'revit:paint', model({ meshes: [{ ...mesh('a', 2300, 'New source name'), glb: 'BBBB' }] }));
    const updated = doc(app).elements[id]!;
    expect(updated.x).toBe(2300);
    expect(updated.meta?.['materials']).toEqual({ body: materialId, 'asset:Old source finish': materialId });
    expect(updated.meta?.['mesh']).not.toEqual(undefined);
    stop();
  });

  it('retains a project material edited in ArchAI when the source changes its colour and wall geometry', () => {
    const app = createTestApp();
    sync(app, 'revit:finish', model({ walls: [wall('w')] }));
    const materialId = Object.values(doc(app).materials).find(m => m.name === 'Plaster')!.id;
    run(app, 'update-material', { id: materialId, patch: { color: '#dd4400' } });
    sync(app, 'revit:finish', model({ walls: [wall('w', 0, 6500)], color: '#22bb00' }));
    expect(doc(app).materials[materialId]!.color).toBe('#dd4400');
    expect(Object.values(doc(app).materials).filter(m => m.name === 'Plaster')).toHaveLength(1);
  });

  it('hides source-view omissions without deletion/conflicts and restores the same painted element on unhide', () => {
    const app = createTestApp();
    const scoped = (visible: string[], meshes: Mesh[]) => ({ ...model({ meshes }), viewScope: { visible } });
    sync(app, 'revit:view', scoped(['a'], [mesh('a')]), { complete: false });
    const id = bound(app, 'revit:view', 'a')!.id;
    const materialId = run<string>(app, 'create-material', { material: { name: 'Saved paint', color: '#0066ff' } });
    run(app, 'paint-element', { ids: [id], materialId });
    const hidden = sync(app, 'revit:view', scoped([], []), { complete: false });
    expect(hidden).toMatchObject({ deleted: 0, held: 0, conflicts: 0 });
    expect(doc(app).elements[id]!.visible).toBe(false);
    expect(pullPlan(doc(app), 'other-app', null).nodes.has(id)).toBe(false);
    sync(app, 'revit:view', scoped(['a'], [{ ...mesh('a', 1200), glb: 'BBBB' }]), { complete: false });
    expect(bound(app, 'revit:view', 'a')!.id).toBe(id);
    expect(doc(app).elements[id]!.visible).toBe(true);
    expect(doc(app).elements[id]!.meta?.['materials']).toEqual({ body: materialId });
    expect(pullPlan(doc(app), 'other-app', null).nodes.has(id)).toBe(true);
  });
  it('keeps element identity across syncs and skips unchanged items', () => {
    const app = createTestApp();
    const first = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')], walls: [wall('w')] }));
    expect(first).toMatchObject({ created: 3, updated: 0, deleted: 0 });
    const ids = ['a', 'b', 'w'].map((id) => bound(app, 'rhino:house', id)!.id);
    const second = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')], walls: [wall('w')] }));
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 3, deleted: 0 });
    expect(['a', 'b', 'w'].map((id) => bound(app, 'rhino:house', id)!.id)).toEqual(ids);
    // Source colour, origin refs and fidelity are recorded.
    expect(bridge(app).sources['rhino:house']).toMatchObject({ app: 'Rhino', color: '#e8590c', mode: 'two-way' });
    expect(Object.values(bridge(app).elements).map((b) => b.refs['rhino:house']!.fidelity).sort()).toEqual(['converted', 'reference', 'reference']);
  });

  it('updates a changed item in place', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ walls: [wall('w', 0, 4000)] }));
    const before = bound(app, 'rhino:house', 'w')!;
    const report = sync(app, 'rhino:house', model({ walls: [wall('w', 0, 6000)] }));
    expect(report).toMatchObject({ created: 0, updated: 1 });
    const after = bound(app, 'rhino:house', 'w')!;
    expect(after.id).toBe(before.id);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    // No stray copies of the rebuilt wall.
    expect(Object.values(doc(app).elements).filter((e) => e.kind === 'line').length).toBe(1);
  });

  it('keeps ArchAI edits the source did not touch', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Chair')] }));
    const id = bound(app, 'rhino:house', 'a')!.id;
    run(app, 'rename', { id, name: 'Renamed in ArchAI' });
    // The source moves it (geometry/transform), not its name.
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 2000, 'Chair')] }));
    const element = doc(app).elements[id]!;
    expect(element.name).toBe('Renamed in ArchAI');
    expect(element.x).toBe(2000);
  });

  it('lets the owner win for the facets it owns', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Chair')] }));
    const id = bound(app, 'rhino:house', 'a')!.id;
    run(app, 'rename', { id, name: 'Renamed in ArchAI' });
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Armchair')] }));
    expect(doc(app).elements[id]!.name).toBe('Armchair');
    expect(bridge(app).log.at(-1)!.text).toContain('ArchAI edits replaced');
  });

  it('turns concurrent changes to a shared facet into a conflict', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Chair')] }));
    run(app, 'bridge-set-source', { key: 'rhino:house', authority: { metadata: 'shared' } });
    const id = bound(app, 'rhino:house', 'a')!.id;
    run(app, 'rename', { id, name: 'Mine' });
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Theirs')] }));
    expect(report.conflicts).toBe(1);
    expect(doc(app).elements[id]!.name).toBe('Mine');
    const conflict = bridge(app).conflicts[0]!;
    expect(conflict).toMatchObject({ element: id, facet: 'metadata', source: 'rhino:house' });
    run(app, 'bridge-resolve', { conflict: conflict.id, take: 'theirs' });
    expect(doc(app).elements[id]!.name).toBe('Theirs');
    expect(bridge(app).conflicts).toEqual([]);
    // Without an ArchAI edit, a shared facet simply follows the source.
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Again')] }));
    expect(doc(app).elements[id]!.name).toBe('Again');
  });

  it('does not apply changes to facets ArchAI owns', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Chair')] }));
    const id = bound(app, 'rhino:house', 'a')!.id;
    run(app, 'bridge-set-owner', { ids: [id], facet: 'metadata', owner: 'archai' });
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a', 500, 'Armchair')] }));
    expect(report.rejected).toBe(1);
    expect(doc(app).elements[id]).toMatchObject({ name: 'Chair', x: 500 });
  });

  it('never deletes from partial snapshots, only from explicit ids', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b'), mesh('c')] }));
    const partial = sync(app, 'rhino:house', model({ meshes: [mesh('a')] }), { complete: false });
    expect(partial.deleted).toBe(0);
    expect(['a', 'b', 'c'].every((id) => bound(app, 'rhino:house', id))).toBe(true);
    const explicit = sync(app, 'rhino:house', model({ meshes: [] }), { complete: false, deleted: ['b'] });
    expect(explicit.deleted).toBe(1);
    expect(bound(app, 'rhino:house', 'b')).toBeUndefined();
    expect(bound(app, 'rhino:house', 'c')).toBeDefined();
  });

  it('deletes missing items of a complete snapshot, but not elements edited in ArchAI', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b'), mesh('c')] }));
    const edited = bound(app, 'rhino:house', 'c')!.id;
    run(app, 'rename', { id: edited, name: 'Kept' });
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a')] }));
    expect(report).toMatchObject({ deleted: 1, conflicts: 1 });
    expect(bound(app, 'rhino:house', 'b')).toBeUndefined();
    expect(doc(app).elements[edited]).toBeDefined();
    const conflict = bridge(app).conflicts.find((c) => c.facet === 'delete')!;
    run(app, 'bridge-resolve', { conflict: conflict.id, take: 'mine' });
    // Kept, and no longer linked to the source.
    expect(doc(app).elements[edited]).toBeDefined();
    expect(bridge(app).elements[edited]).toBeUndefined();
  });

  it('holds mass deletions for confirmation', () => {
    const app = createTestApp();
    const many = Array.from({ length: 40 }, (_, i) => mesh(`m${i}`, i * 600));
    sync(app, 'rhino:house', model({ meshes: many }));
    const report = sync(app, 'rhino:house', model({ meshes: many.slice(0, 5) }));
    expect(report).toMatchObject({ held: 35, deleted: 0 });
    expect(Object.keys(bridge(app).elements).length).toBe(40);
    const held = bridge(app).held[0]!;
    expect(run<{ deleted: number }>(app, 'bridge-held', { id: held.id, apply: true }).deleted).toBe(35);
    expect(Object.keys(bridge(app).elements).length).toBe(5);
    expect(real(app).length).toBe(5);
  });

  it('answers a repeated change without applying it twice', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a')] }), { changeId: 'c1' });
    const elements = Object.keys(doc(app).elements).length;
    const again = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')] }), { changeId: 'c1' });
    expect(again).toMatchObject({ repeated: true, created: 1 });
    // The reply outlives the mutation (it crosses to the plugin later).
    expect(() => JSON.stringify(again)).not.toThrow();
    expect(Object.keys(doc(app).elements).length).toBe(elements);
  });

  it('keeps sources apart and sends each app only what others shared', () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('w1'), wall('w2', 3000)] }));
    sync(app, 'rhino:facade', model({ app: 'Rhino', meshes: [mesh('panel')] }));
    sync(app, 'blender:viz', model({ app: 'Blender', meshes: [mesh('tree', 5000)] }));
    expect(Object.values(bridge(app).sources).map((s) => s.color)).toEqual(['#e8590c', '#1c7ed6', '#2f9e44']);
    // A Rhino change leaves Revit's walls alone.
    sync(app, 'rhino:facade', model({ app: 'Rhino', meshes: [mesh('panel', 900)] }));
    expect(bound(app, 'revit:tower', 'w1')).toBeDefined();
    // Blender's tree stays in Blender: source-only.
    const tree = bound(app, 'blender:viz', 'tree')!.id;
    run(app, 'bridge-set-share', { ids: [tree], share: 'source-only' });
    const forRevit = withoutLink(doc(app), 'revit:tower');
    const names = Object.values(forRevit.elements).map((e) => bridge(app).elements[e.id]?.refs);
    expect(names.some((refs) => refs?.['revit:tower'])).toBe(false);
    expect(Object.keys(forRevit.elements)).not.toContain(tree);
    expect(Object.keys(forRevit.elements)).toContain(bound(app, 'rhino:facade', 'panel')!.id);
    // A paused link receives nothing.
    run(app, 'bridge-set-source', { key: 'revit:tower', mode: 'paused' });
    expect(Object.keys(withoutLink(doc(app), 'revit:tower').elements)).toEqual([]);
  });

  it('refuses changes from read-only and paused links', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a')] }));
    run(app, 'bridge-set-source', { key: 'rhino:house', mode: 'read-only' });
    const result = app.executor.dispatchSync('bridge-sync', { key: 'rhino:house', model: model({ meshes: [mesh('b')] }) });
    expect(result.ok).toBe(false);
  });

  it('replaces the old Live Bridge elements once, then binds', () => {
    const app = createTestApp();
    const own = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    // A project synced by the Live Bridge before the bridge: tagged elements, no bindings.
    run(app, 'import-revit-model', { model: model({ meshes: [mesh('a'), mesh('b')] }) });
    app.store.setState((state) => {
      const elements = Object.fromEntries(Object.entries(state.doc.elements).map(([id, e]) => [id, id === own ? e : { ...e, meta: { ...e.meta, liveLink: { key: 'rhino:house', app: 'Rhino' } } }]));
      return { ...state, doc: { ...state.doc, elements } };
    });
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')] }));
    expect(report).toMatchObject({ migrated: 2, created: 2 });
    expect(real(app).length).toBe(3);
    expect(doc(app).elements[own]).toBeDefined();
  });

  it('is one undo step', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 0, 'Chair')] }));
    const id = bound(app, 'rhino:house', 'a')!.id;
    sync(app, 'rhino:house', model({ meshes: [mesh('a', 900, 'Chair'), mesh('b')] }));
    expect(doc(app).elements[id]!.x).toBe(900);
    app.executor.undo();
    expect(doc(app).elements[id]!.x).toBe(0);
    expect(bound(app, 'rhino:house', 'b')).toBeUndefined();
    expect(Object.keys(bridge(app).elements).length).toBe(1);
  });

  it('does not bring back elements deleted in ArchAI', () => {
    const app = createTestApp();
    sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')] }));
    const a = bound(app, 'rhino:house', 'a')!.id;
    run(app, 'select', { ids: [a] });
    run(app, 'delete-selection', {});
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')] }));
    expect(report.created).toBe(0);
    expect(doc(app).elements[a]).toBeUndefined();
    expect(bridge(app).elements[a]!.removed).toBeTypeOf('number');
  });

  it('lists what it could not build instead of dropping it silently', () => {
    const app = createTestApp();
    const report = sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('w')], openings: [{ id: 'd', kind: 'door', wall: 'missing', start: 0, end: 900, bottom: 0, height: 2100 }] }));
    expect(report.unsupported).toBe(1);
    expect(bridge(app).sources['revit:tower']!.unsupported).toEqual([expect.objectContaining({ id: 'd', kind: 'door' })]);
  });

  it('rebuilds hosted openings on the bound wall when the wall changes', () => {
    const app = createTestApp();
    const door = { id: 'd', kind: 'door', wall: 'w', start: 1000, end: 1900, bottom: 0, height: 2100 };
    sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('w', 0, 4000)], openings: [door] }));
    const wallId = bound(app, 'revit:tower', 'w')!.id;
    const doorId = bound(app, 'revit:tower', 'd')!.id;
    const report = sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('w', 0, 6000)], openings: [door] }));
    // The door did not change itself: rebuilt against the new wall, it stays as it was.
    expect(report).toMatchObject({ created: 0, updated: 1 });
    const opening = (bound(app, 'revit:tower', 'd')!.meta!['arch'] as { opening: { wallId: string } }).opening;
    expect(bound(app, 'revit:tower', 'd')!.id).toBe(doorId);
    expect(opening.wallId).toBe(wallId);
  });

  it('keeps the Live Bridge command working for older plugins', () => {
    const app = createTestApp();
    run(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model({ meshes: [mesh('a'), mesh('b')] }) });
    const report = run<{ created: Record<string, number>; removed: number }>(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model({ meshes: [mesh('a')] }) });
    expect(report.removed).toBe(1);
    expect(real(app).length).toBe(1);
  });
});

describe('Live Bridge pulls and updates', () => {
  const ids = (plan: PullPlan) => [...plan.nodes.keys()];

  it('sends each app what others shared, then only what changed', () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('w1')] }));
    sync(app, 'rhino:facade', model({ app: 'Rhino', meshes: [mesh('panel'), mesh('fin', 900)] }));
    const wallId = bound(app, 'revit:tower', 'w1')!.id;
    const panel = bound(app, 'rhino:facade', 'panel')!.id;
    const first = pullPlan(doc(app), 'rhino:facade', null);
    expect(ids(first)).toEqual([wallId]);
    expect(first.nodes.get(wallId)).toMatchObject({ source: 'revit:tower', color: '#e8590c' });
    const forRevit = pullPlan(doc(app), 'revit:tower', null);
    expect(ids(forRevit).sort()).toEqual([panel, bound(app, 'rhino:facade', 'fin')!.id].sort());
    // Nothing changed: no nodes, but everything still present.
    const again = pullPlan(doc(app), 'revit:tower', forRevit.sent);
    expect(ids(again)).toEqual([]);
    expect(again.present.sort()).toEqual(forRevit.present.sort());
    // Rhino moves its panel: Revit gets that one node only.
    sync(app, 'rhino:facade', model({ app: 'Rhino', meshes: [mesh('panel', 300), mesh('fin', 900)] }));
    expect(ids(pullPlan(doc(app), 'revit:tower', forRevit.sent))).toEqual([panel]);
  });

  it("sends ArchAI's moves back to the app when it does not own the transform, and settles when the app catches up", () => {
    const app = createTestApp();
    sync(app, 'blender:viz', model({ app: 'Blender', meshes: [mesh('tree', 1000, 'Tree')] }));
    const tree = bound(app, 'blender:viz', 'tree')!.id;
    // Owned by Blender (the default): ArchAI's move stays in ArchAI.
    run(app, 'select', { ids: [tree] });
    run(app, 'move-selection', { ids: [tree], dx: 500, dy: 0 });
    expect(pullPlan(doc(app), 'blender:viz', null).updates).toEqual([]);
    // Shared: the move goes to Blender.
    run(app, 'bridge-set-source', { key: 'blender:viz', authority: { transform: 'shared', metadata: 'shared' } });
    run(app, 'rename', { id: tree, name: 'Oak' });
    const [update] = pullPlan(doc(app), 'blender:viz', null).updates;
    expect(update).toMatchObject({ ref: 'tree', element: tree, name: 'Oak' });
    expect(update!.move![0]).toBeCloseTo(500);
    // Blender applies it and sends its model again: in sync, no conflict, nothing more to send.
    const report = sync(app, 'blender:viz', model({ app: 'Blender', meshes: [mesh('tree', 1500.04, 'Oak')] }));
    expect(report.conflicts).toBe(0);
    expect(doc(app).elements[tree]).toMatchObject({ name: 'Oak' });
    expect(pullPlan(doc(app), 'blender:viz', null).updates).toEqual([]);
  });

  it("never lets another app edit an app's geometry until it is released into ArchAI", () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('stair', 0, 'Stair')] }));
    sync(app, 'blender:viz', model({ app: 'Blender', meshes: [] }));
    const stair = bound(app, 'revit:tower', 'stair')!.id;
    // Revit's stair cannot be offered to Blender, nor handed to Blender's authority.
    expect(app.executor.dispatchSync('bridge-offer', { ids: [stair], key: 'blender:viz', facets: ['metadata'] }).ok).toBe(false);
    expect(app.executor.dispatchSync('bridge-set-owner', { ids: [stair], facet: 'transform', owner: 'blender:viz' }).ok).toBe(false);
    expect(app.executor.dispatchSync('bridge-set-source', { key: 'revit:tower', authority: { geometry: 'blender:viz' } }).ok).toBe(false);
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.get(stair)!['editable']).toBeUndefined();
    // A copy Blender made anyway (an older plugin) changes nothing and adds nothing.
    const sneaky = sync(app, 'blender:viz', model({ app: 'Blender', meshes: [{ ...mesh('obj-1', 900, 'Stair X'), archai: stair }] }));
    expect(sneaky).toMatchObject({ created: 0, linked: 0 });
    expect(doc(app).elements[stair]).toMatchObject({ name: 'Stair', x: 0 });
    expect(real(app).length).toBe(1);
  });

  it('links editable copies of released elements back to them and applies the offered facets', () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('stair', 0, 'Stair')] }));
    sync(app, 'blender:viz', model({ app: 'Blender', meshes: [] }));
    const stair = bound(app, 'revit:tower', 'stair')!.id;
    // Released into an ArchAI element first: then it can be offered.
    run(app, 'bridge-convert', { ids: [stair] });
    run(app, 'bridge-offer', { ids: [stair], key: 'blender:viz', facets: ['metadata', 'material'] });
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.get(stair)!['editable']).toEqual(['metadata']);
    // Revit's next sync does not bring its stair back as a new element: it was released.
    expect(sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('stair', 0, 'Stair')] })).created).toBe(0);
    // Blender made its copy and sends it with the element it came from.
    const copy = { ...mesh('obj-7', 0, 'Stair'), archai: stair };
    const linked = sync(app, 'blender:viz', model({ app: 'Blender', meshes: [copy] }));
    expect(linked).toMatchObject({ linked: 1, created: 0 });
    expect(real(app).length).toBe(1);
    expect(bridge(app).elements[stair]!.refs['blender:viz']).toMatchObject({ id: 'obj-7', role: 'copy' });
    // No longer a node for Blender (it has its own copy).
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.has(stair)).toBe(false);
    // A rename in Blender is offered: applied. A move is not: ArchAI keeps the position.
    const report = sync(app, 'blender:viz', model({ app: 'Blender', meshes: [{ ...mesh('obj-7', 800, 'Stair B'), archai: stair }] }));
    expect(doc(app).elements[stair]).toMatchObject({ name: 'Stair B', x: 0 });
    expect(report.rejected).toBeGreaterThan(0);
  });
});

describe('Live Bridge ids', () => {
  it('moves a link to the new id an object now has (plugins that used to send names)', () => {
    const app = createTestApp();
    sync(app, 'blender:scene', model({ app: 'Blender', meshes: [mesh('Cube', 0, 'Cube')] }));
    const id = bound(app, 'blender:scene', 'Cube')!.id;
    const report = sync(app, 'blender:scene', model({ app: 'Blender', meshes: [{ ...mesh('uid-1', 0, 'Cube'), was: 'Cube' }] }));
    expect(report).toMatchObject({ created: 0, deleted: 0 });
    expect(bound(app, 'blender:scene', 'uid-1')!.id).toBe(id);
    expect(bound(app, 'blender:scene', 'Cube')).toBeUndefined();
  });
});

describe('Live Bridge models on the board', () => {
  it('keeps batch ordering unique and applies a control preset to multiple sources in one undo step', () => {
    const app = createTestApp();
    const meshes = Array.from({ length: 300 }, (_, i) => mesh(`m${i}`, i * 500));
    sync(app, 'rhino:batch', model({ meshes }));
    const elements = real(app);
    expect(new Set(elements.map((element) => element.index)).size).toBe(300);
    const group = bridge(app).sources['rhino:batch']!.groupId;
    expect(elements.every((element) => element.parentId === group)).toBe(true);
    const ids = elements.slice(0, 2).map((element) => element.id);
    run(app, 'bridge-set-control', { ids, control: 'placement' });
    for (const id of ids) expect(bridge(app).elements[id]!.owners).toEqual({ geometry: 'origin', material: 'archai', transform: 'archai', metadata: 'archai' });
    app.executor.undo();
    for (const id of ids) expect(bridge(app).elements[id]!.owners).toBeUndefined();
    app.executor.undo();
    expect(real(app)).toHaveLength(0);
    app.executor.redo();
    expect(real(app)).toHaveLength(300);
  });
  it('puts each model in a group of its own', () => {
    const app = createTestApp();
    sync(app, 'rhino:facade', model({ meshes: [mesh('a'), mesh('b', 900)] }));
    const group = bridge(app).sources['rhino:facade']!.groupId!;
    expect(doc(app).elements[group]).toMatchObject({ kind: 'group', name: 'Rhino: House' });
    expect(bound(app, 'rhino:facade', 'a')!.parentId).toBe(group);
    // Later elements join the same group.
    sync(app, 'rhino:facade', model({ meshes: [mesh('a'), mesh('b', 900), mesh('c', 1800)] }));
    expect(bound(app, 'rhino:facade', 'c')!.parentId).toBe(group);
  });

  it('converts elements into ArchAI elements, keeping where they came from', () => {
    const app = createTestApp();
    sync(app, 'rhino:facade', model({ meshes: [mesh('a', 0, 'Panel')] }));
    const id = bound(app, 'rhino:facade', 'a')!.id;
    run(app, 'bridge-convert', { ids: [id] });
    expect(bridge(app).elements[id]).toMatchObject({ refs: {}, history: [expect.objectContaining({ source: 'rhino:facade', id: 'a', app: 'Rhino' })] });
    // Rhino's next sync does not touch it: it is ArchAI's now (Rhino's object is new to the link).
    sync(app, 'rhino:facade', model({ meshes: [mesh('a', 500, 'Panel moved')] }));
    expect(doc(app).elements[id]).toMatchObject({ name: 'Panel', x: 0 });
    // Not sent back to Rhino, which still has its original.
    expect(pullPlan(doc(app), 'rhino:facade', null).nodes.has(id)).toBe(false);
  });
});

describe('Live Bridge export', () => {
  it('sends model-group moves to receivers and permitted source objects with a new update token', () => {
    const app = createTestApp();
    sync(app, 'rhino:facade', model({ meshes: [mesh('a', 1000)] }));
    const group = bridge(app).sources['rhino:facade']!.groupId!;
    const id = bound(app, 'rhino:facade', 'a')!.id;
    run(app, 'bridge-set-control', { ids: [id], control: 'placement' });
    const before = pullPlan(doc(app), 'other', null);
    run(app, 'select', { ids: [group] });
    run(app, 'move-selection', { ids: [group], dx: 500, dy: 200 });
    expect(pullPlan(doc(app), 'other', before.sent).nodes.has(id)).toBe(true);
    const first = pullPlan(doc(app), 'rhino:facade', null).updates[0]!;
    expect(first.move).toEqual([500, 200, 0]);
    run(app, 'move-selection', { ids: [group], dx: 100, dy: 0 });
    const second = pullPlan(doc(app), 'rhino:facade', null).updates[0]!;
    expect(second.move).toEqual([600, 200, 0]);
    expect(second.token).not.toBe(first.token);
  });
  it('dissolves source groups for export, keeping world positions', () => {
    const app = createTestApp();
    sync(app, 'rhino:facade', model({ meshes: [mesh('a', 1000)] }));
    const group = bridge(app).sources['rhino:facade']!.groupId!;
    const id = bound(app, 'rhino:facade', 'a')!.id;
    // The user moves the whole model on the board.
    app.store.setState((state) => ({ ...state, doc: { ...state.doc, elements: { ...state.doc.elements, [group]: { ...state.doc.elements[group]!, x: 500, y: 200 } } } }));
    const flat = flattenSourceGroups(doc(app));
    expect(flat.elements[group]).toBeUndefined();
    expect(flat.elements[id]).toMatchObject({ parentId: null, x: 1500, y: 200 });
  });
});

describe('Live Bridge on online projects', () => {
  it("treats a collaborator's edit like an ArchAI edit: kept, and a conflict when a shared part changes in the app too", () => {
    const app = createTestApp();
    sync(app, 'rhino:facade', model({ meshes: [mesh('a', 0, 'Panel')] }));
    run(app, 'bridge-set-source', { key: 'rhino:facade', authority: { metadata: 'shared' } });
    const id = bound(app, 'rhino:facade', 'a')!.id;
    // A collaborator renames it on the online board (their patch arrives through the board).
    expect(app.executor.applyRemote([{ op: 'replace', path: ['elements', id, 'name'], value: 'Renamed by a collaborator' }])).toBe(true);
    const report = sync(app, 'rhino:facade', model({ meshes: [mesh('a', 0, 'Renamed in Rhino')] }));
    expect(report.conflicts).toBe(1);
    expect(doc(app).elements[id]!.name).toBe('Renamed by a collaborator');
  });

  it("replays a collaborator's sync as plain document changes (bindings travel with the project)", () => {
    const here = createTestApp();
    const there = createTestApp();
    const patches: Parameters<typeof there.executor.applyRemote>[0][] = [];
    here.executor.onDocChange((p) => patches.push(p));
    run(here, 'new-document', { name: 'Online' });
    there.store.setState((state) => ({ ...state, doc: here.store.getState().doc }));
    sync(here, 'revit:tower', model({ app: 'Revit', walls: [wall('w')] }));
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) expect(there.executor.applyRemote(p)).toBe(true);
    const theirs = there.store.getState().doc;
    expect(Object.keys(theirs.bridge!.sources)).toEqual(['revit:tower']);
    expect(Object.values(theirs.elements).filter((e) => e.kind !== 'group')).toHaveLength(1);
    // The other desktop app can pull it for its own apps.
    expect(pullPlan(theirs, 'rhino:facade', null).nodes.size).toBe(1);
  });
});

describe('Live Bridge generic meshes', () => {
  it('drops retired mesh bytes only when unreferenced and restores them on undo', () => {
    const app = createTestApp();
    sync(app, 'test', model({ meshes: [mesh('a')] }));
    const id = bound(app, 'test', 'a')!.id;
    const before = Object.keys(doc(app).blobs);
    sync(app, 'test', model({ meshes: [{ ...mesh('a'), glb: 'AAAB' }] }), { complete: false });
    expect(Object.keys(doc(app).blobs)).toHaveLength(1);
    expect(Object.keys(doc(app).blobs)).not.toEqual(before);
    app.executor.undo();
    expect(Object.keys(doc(app).blobs)).toEqual(before);
    expect(doc(app).elements[id]!.meta!['mesh']).toMatchObject({ blobId: before[0] });
    app.executor.redo();
    expect(Object.keys(doc(app).blobs)).toHaveLength(1);
    // A second element still using a blob prevents collection when only the first changes.
    sync(app, 'test', model({ meshes: [{ ...mesh('a'), glb: 'AAAB' }, { ...mesh('b'), glb: 'AAAB' }] }), { complete: false });
    sync(app, 'test', model({ meshes: [{ ...mesh('a'), glb: 'AAAC' }] }), { complete: false });
    expect(Object.keys(doc(app).blobs)).toHaveLength(2);
  });
  it('turns an element an app used to send as a wall into the mesh it now sends, in place', () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', walls: [wall('e101')] }));
    const id = bound(app, 'revit:tower', 'e101')!.id;
    expect(doc(app).elements[id]!.kind).toBe('line');
    const report = sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('e101', 0, 'Basic Wall')] }), { complete: false });
    expect(report).toMatchObject({ created: 0, updated: 1 });
    expect(doc(app).elements[id]).toMatchObject({ kind: 'rect', name: 'Basic Wall' });
    expect(bridge(app).elements[id]!.refs['revit:tower']!.kind).toBe('meshes');
    expect(real(app)).toHaveLength(1);
  });
});

describe("An app's geometry edited in ArchAI", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is put back as the app sent it: moved, renamed, deleted', async () => {
    const app = createTestApp();
    const told: string[] = [];
    startBridgeGuard(app.executor, app.store, (name) => told.push(name));
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('e1', 1000, 'Basic Wall')] }));
    const id = bound(app, 'revit:tower', 'e1')!.id;
    run(app, 'select', { ids: [id] });
    run(app, 'move-selection', { ids: [id], dx: 500, dy: 0 });
    await settle();
    expect(doc(app).elements[id]!.x).toBe(1000);
    run(app, 'rename', { id, name: 'Mine now' });
    await settle();
    expect(doc(app).elements[id]!.name).toBe('Basic Wall');
    run(app, 'select', { ids: [id] });
    run(app, 'delete-selection', {});
    await settle();
    expect(doc(app).elements[id]).toMatchObject({ name: 'Basic Wall', x: 1000 });
    expect(told).toContain('Revit');
    // The app's own next change still applies.
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('e1', 3000, 'Basic Wall')] }));
    await settle();
    expect(doc(app).elements[id]!.x).toBe(3000);
  });

  it('stays edited once converted into an ArchAI element, or for parts handed to ArchAI', async () => {
    const app = createTestApp();
    startBridgeGuard(app.executor, app.store);
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('e1', 1000, 'Wall'), mesh('e2', 3000, 'Door')] }));
    const wall = bound(app, 'revit:tower', 'e1')!.id;
    const door = bound(app, 'revit:tower', 'e2')!.id;
    run(app, 'bridge-convert', { ids: [wall] });
    run(app, 'rename', { id: wall, name: 'ArchAI wall' });
    run(app, 'bridge-set-owner', { ids: [door], facet: 'metadata', owner: 'archai' });
    run(app, 'rename', { id: door, name: 'Named in ArchAI' });
    await settle();
    expect(doc(app).elements[wall]!.name).toBe('ArchAI wall');
    expect(doc(app).elements[door]!.name).toBe('Named in ArchAI');
  });
});

for (const take of ['theirs', 'mine'] as const) it('resolves all conflicts with one undo: ' + take, () => {
  const app = createTestApp();
  sync(app, 'batch', model({ meshes: [mesh('a'), mesh('b')] }));
  run(app, 'bridge-set-source', { key: 'batch', authority: { metadata: 'shared' } });
  const ids = ['a', 'b'].map(id => bound(app, 'batch', id)!.id);
  ids.forEach(id => run(app, 'rename', { id, name: 'Mine' }));
  sync(app, 'batch', model({ meshes: [mesh('a', 0, 'Theirs'), mesh('b', 0, 'Theirs')] }));
  expect(bridge(app).conflicts).toHaveLength(2);
  const before = doc(app);
  const idsToResolve = bridge(app).conflicts.map(c => c.id);
  expect(run(app, 'bridge-resolve-all', { take, conflicts: [...idsToResolve, idsToResolve[0], 'stale'] })).toEqual({ resolved: 2 });
  expect(bridge(app).conflicts).toEqual([]);
  expect(ids.map(id => doc(app).elements[id]!.name)).toEqual([take === 'theirs' ? 'Theirs' : 'Mine', take === 'theirs' ? 'Theirs' : 'Mine']);
  app.executor.undo();
  expect(doc(app).elements).toEqual(before.elements);
  expect(bridge(app).conflicts).toEqual(before.bridge!.conflicts);
});
