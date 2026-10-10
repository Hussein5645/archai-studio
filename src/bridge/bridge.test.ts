import { describe, expect, it } from 'vitest';
import { createTestApp, run, type TestApp } from '@/test/harness';
import type { ArchaiDocument, BridgeData, Element } from '@/document';
import { withoutLink } from '@/live/sync';
import type { BridgeSyncReport } from './engine';

type Mesh = { id: string; name?: string; category?: string; origin: [number, number, number]; size: [number, number, number]; glb: string };
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
    expect(Object.values(doc(app).elements).length).toBe(5);
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

  it('replaces the old live link elements once, then binds', () => {
    const app = createTestApp();
    const own = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    // A project synced by the live link before the bridge: tagged elements, no bindings.
    run(app, 'import-revit-model', { model: model({ meshes: [mesh('a'), mesh('b')] }) });
    app.store.setState((state) => {
      const elements = Object.fromEntries(Object.entries(state.doc.elements).map(([id, e]) => [id, id === own ? e : { ...e, meta: { ...e.meta, liveLink: { key: 'rhino:house', app: 'Rhino' } } }]));
      return { ...state, doc: { ...state.doc, elements } };
    });
    const report = sync(app, 'rhino:house', model({ meshes: [mesh('a'), mesh('b')] }));
    expect(report).toMatchObject({ migrated: 2, created: 2 });
    expect(Object.keys(doc(app).elements).length).toBe(3);
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

  it('keeps the live link command working for older plugins', () => {
    const app = createTestApp();
    run(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model({ meshes: [mesh('a'), mesh('b')] }) });
    const report = run<{ created: Record<string, number>; removed: number }>(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model({ meshes: [mesh('a')] }) });
    expect(report.removed).toBe(1);
    expect(Object.keys(doc(app).elements).length).toBe(1);
  });
});
