import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { layerParentOf } from '@/layers/hierarchy';
import { buildScene } from '@/view3d/geometry';
import * as THREE from 'three';
import { locationOf, mapAnchorWorld, siteContextOf, siteContextRoot } from './model';
import { buildingHeight, overpassQuery, parseOverpass, roadWidth, type OverpassWay } from './siteContext';

const sample: { elements: OverpassWay[] } = {
  elements: [
    { type: 'way', id: 1, tags: { building: 'yes', 'building:levels': '5', name: 'Tower' }, geometry: [{ lat: 51.5, lon: -0.12 }, { lat: 51.5, lon: -0.1198 }, { lat: 51.5002, lon: -0.1198 }, { lat: 51.5, lon: -0.12 }] },
    { type: 'way', id: 2, tags: { highway: 'residential', name: 'High St' }, geometry: [{ lat: 51.4995, lon: -0.121 }, { lat: 51.4995, lon: -0.119 }] },
    { type: 'way', id: 3, tags: { highway: 'proposed' }, geometry: [{ lat: 51.4995, lon: -0.121 }, { lat: 51.4995, lon: -0.119 }] },
    { type: 'way', id: 4, tags: { building: 'house', height: '7.5 m' }, geometry: [{ lat: 51.5, lon: -0.12 }, { lat: 51.5, lon: -0.1199 }] },
  ],
};

describe('OpenStreetMap site context', () => {
  it('parses buildings with heights and roads with widths', () => {
    const features = parseOverpass(sample);
    expect(features.map((f) => [f.kind, f.osmId])).toEqual([['building', 1], ['road', 2]]);
    expect(features[0]!.points).toHaveLength(3);
    expect(features[0]!.size).toBe(5 * 3200);
    expect(buildingHeight({ building: 'house', height: '7.5 m' })).toBe(7500);
    expect(buildingHeight({ building: 'garage' })).toBe(3200);
    expect(roadWidth({ highway: 'primary', lanes: '4' })).toBe(14_000);
    expect(roadWidth({ highway: 'footway', width: '3' })).toBe(3000);
    expect(overpassQuery(51.5, -0.12, 250)).toContain('around:250,51.5000000,-0.1200000');
  });

  it('inserts editable solids under the map and replaces them on regenerate', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'update-analysis', { id: map, patch: { lat: 51.5, lon: -0.12, mapCenter: { lat: 51.5, lon: -0.12 } } });
    run(app, 'insert-site-context', { id: map, radius: 250, features: parseOverpass(sample) });
    let doc = app.store.getState().doc;
    const root = siteContextRoot(doc, map)!;
    expect(layerParentOf(doc.elements, root.id)).toBe(map);
    const solids = Object.values(doc.elements).filter((e) => ['building', 'road'].includes(siteContextOf(e)?.role ?? ''));
    expect(solids).toHaveLength(2);
    const building = solids.find((e) => siteContextOf(e)!.role === 'building')!;
    expect(building.kind === 'line' && building.closed).toBe(true);
    expect((building.meta!['solid'] as { height: number }).height).toBe(16_000);
    // At 1:1 the footprint is ~14 m wide (0.0002° of longitude at 51.5°N).
    expect(building.kind === 'line' && Math.max(...building.points.map((p) => p[0]))).toBeCloseTo(13_850, -2);
    // The map centre sits at the rect centre by default: the building's first corner is there.
    expect(building.x).toBeCloseTo(100_000, 0);

    run(app, 'insert-site-context', { id: map, radius: 100, features: parseOverpass(sample).slice(0, 1) });
    doc = app.store.getState().doc;
    expect(Object.values(doc.elements).filter((e) => siteContextOf(e)?.role === 'root')).toHaveLength(1);
    expect(Object.values(doc.elements).filter((e) => siteContextOf(e)?.role === 'road')).toHaveLength(0);
  });

  it('moves context with the map and keeps imagery still while resizing', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'insert-site-context', { id: map, radius: 250, features: parseOverpass(sample) });
    const rootId = siteContextRoot(app.store.getState().doc, map)!.id;
    run(app, 'move-selection', { ids: [map], dx: 5000, dy: -2000 });
    let doc = app.store.getState().doc;
    expect([doc.elements[rootId]!.x, doc.elements[rootId]!.y]).toEqual([5000, -2000]);
    const anchor = mapAnchorWorld(doc.elements, doc.elements[map]!)!;
    run(app, 'resize-selection', { ids: [map], from: { x: 5000, y: -2000, width: 200_000, height: 140_000 }, to: { x: -45_000, y: -2000, width: 250_000, height: 140_000 } });
    doc = app.store.getState().doc;
    const after = mapAnchorWorld(doc.elements, doc.elements[map]!)!;
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });
});

describe('site context in 3D', () => {
  it('extrudes buildings to their height and roads as thin strips', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'insert-site-context', { id: map, radius: 250, features: parseOverpass(sample) });
    const doc = app.store.getState().doc;
    const built = buildScene(doc, { lod: 'high', models: new Map(), textures: new Map() });
    // Groups build as one object: roots → [Roads, Buildings] → features.
    const root = built.find((b) => b.id === siteContextRoot(doc, map)!.id)!.object;
    const [roads, buildings] = root.children;
    const height = (object: THREE.Object3D) => { const box = new THREE.Box3().setFromObject(object); return box.max.y - box.min.y; };
    expect(height(buildings!)).toBeCloseTo(16_000, 0);
    expect(height(roads!)).toBeCloseTo(100, 0);
  });
});

describe('context follows the imagery', () => {
  it('slides with the map when its centre is panned', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'update-analysis', { id: map, patch: { lat: 51.5, lon: -0.12, mapCenter: { lat: 51.5, lon: -0.12 } } });
    run(app, 'insert-site-context', { id: map, radius: 250, features: parseOverpass(sample) });
    const rootId = siteContextRoot(app.store.getState().doc, map)!.id;
    run(app, 'update-analysis', { id: map, patch: { mapCenter: { lat: 51.5, lon: -0.1186 } } });
    const root = app.store.getState().doc.elements[rootId]!;
    expect(root.x).toBeLessThan(-90_000);
    expect(Math.abs(root.y)).toBeLessThan(10);
  });
});

describe('where context is gathered', () => {
  it('uses what the map shows, not a far-away pin, and prefers the site boundary', async () => {
    const { siteContextCentre } = await import('@/commands/builtin/analysis');
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    // Pin left at the London default; the imagery was panned to Basra.
    run(app, 'update-analysis', { id: map, patch: { mapCenter: { lat: 30.5085, lon: 47.8105 } } });
    let element = app.store.getState().doc.elements[map]!;
    let centre = siteContextCentre(element, locationOf(element)!);
    expect(centre.lat).toBeCloseTo(30.5085, 6);
    expect(centre.lon).toBeCloseTo(47.8105, 6);
    const boundary = [{ lat: 30.51, lon: 47.81 }, { lat: 30.51, lon: 47.812 }, { lat: 30.512, lon: 47.812 }];
    run(app, 'update-analysis', { id: map, patch: { boundary } });
    element = app.store.getState().doc.elements[map]!;
    centre = siteContextCentre(element, locationOf(element)!);
    expect(centre.lat).toBeCloseTo(30.510667, 5);
    expect(centre.lon).toBeCloseTo(47.811333, 5);
  });
});
