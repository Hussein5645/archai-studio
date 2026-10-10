import { describe, expect, it } from 'vitest';
import { createTestApp, run, type TestApp } from '@/test/harness';
import type { ArchaiDocument, BridgeData, Element } from '@/document';
import { withoutLink } from '@/live/sync';
import type { BridgeSyncReport } from './engine';
import { flattenSourceGroups, pullPlan, type PullPlan } from './pull';

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

describe('Live Bridge sync', () => {
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

  it('links editable copies back to their element and applies the offered facets', () => {
    const app = createTestApp();
    sync(app, 'revit:tower', model({ app: 'Revit', meshes: [mesh('stair', 0, 'Stair')] }));
    sync(app, 'blender:viz', model({ app: 'Blender', meshes: [] }));
    const stair = bound(app, 'revit:tower', 'stair')!.id;
    // Reference geometry until offered.
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.get(stair)!['editable']).toBeUndefined();
    run(app, 'bridge-offer', { ids: [stair], key: 'blender:viz', facets: ['metadata', 'material'] });
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.get(stair)!['editable']).toEqual(['metadata', 'material']);
    // Blender made its copy and sends it with the element it came from.
    const copy = { ...mesh('obj-7', 0, 'Stair'), archai: stair };
    const linked = sync(app, 'blender:viz', model({ app: 'Blender', meshes: [copy] }));
    expect(linked).toMatchObject({ linked: 1, created: 0 });
    expect(real(app).length).toBe(1);
    expect(bridge(app).elements[stair]!.refs['blender:viz']).toMatchObject({ id: 'obj-7', role: 'copy' });
    // No longer a node for Blender (it has its own copy).
    expect(pullPlan(doc(app), 'blender:viz', null).nodes.has(stair)).toBe(false);
    // A rename in Blender is offered: applied. A move is not: Revit keeps the transform.
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
