import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { conceptRoot } from './massing';
import { locationFrame, locationOf, mapAnchorWorld, siteContextRoot } from './model';
import { geoToLocal } from './mapGeometry';
import { parseOverpass } from './siteContext';

describe('resizing the map', () => {
  it('treats dragging and typed position changes as a crop over fixed board coordinates', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-location', { x: 0, y: 0 });
    const world = () => { const doc = app.store.getState().doc; return mapAnchorWorld(doc.elements, doc.elements[id]!)!; };
    const initial = world();
    run(app, 'move-selection', { ids: [id], dx: 50000, dy: -20000 });
    expect(world()).toEqual(initial);
    run(app, 'set-transform', { id, x: -40000, y: 10000, width: 250000 });
    expect(world()).toEqual(initial);
    run(app, 'recenter-map', { id });
    const doc = app.store.getState().doc;
    const map = doc.elements[id]!;
    const meta = locationOf(map)!;
    const pin = geoToLocal(locationFrame(map, meta), meta);
    expect(pin.x).toBeCloseTo('width' in map ? map.width / 2 : 0);
    expect(world()).toEqual(initial);
    app.executor.undo();
    expect(world()).toEqual(initial);
  });
  it('leaves what is placed on the ground where it is', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'insert-site-context', { id: map, radius: 100, features: parseOverpass({ elements: [{ type: 'way', id: 1, tags: { building: 'yes' }, geometry: [{ lat: 51.5074, lon: -0.1278 }, { lat: 51.5074, lon: -0.1275 }, { lat: 51.5076, lon: -0.1275 }] }] }) });
    run(app, 'upsert-massing-form', { mapId: map, kind: 'solid', source: 'drawn', profile: [[90_000, 60_000], [110_000, 60_000], [110_000, 80_000]], start: 0, end: 3000 });
    const before = app.store.getState().doc;
    const ctx = siteContextRoot(before, map)!.id, concept = conceptRoot(before, map)!.id;
    const snapshot = (doc: typeof before) => [doc.elements[ctx]!.x, doc.elements[ctx]!.y, doc.elements[concept]!.x, doc.elements[concept]!.y];
    const start = snapshot(before);
    run(app, 'resize-selection', { ids: [map], from: { x: 0, y: 0, width: 200_000, height: 140_000 }, to: { x: -50_000, y: -20_000, width: 250_000, height: 160_000 } });
    expect(snapshot(app.store.getState().doc)).toEqual(start);
    run(app, 'set-transform', { id: map, width: 300_000 });
    expect(snapshot(app.store.getState().doc)).toEqual(start);
  });
});
