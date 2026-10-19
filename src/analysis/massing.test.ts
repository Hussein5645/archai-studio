import Module from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { buildScene, ribbonMesh } from '@/view3d/geometry';
import { conceptRoot, formsOf, geometryFromPositions, insetProfile, massingOf, massingPositions, primeMassing, type Form, type Plan } from './massing';
import { locationOf, siteContextRoot } from './model';

let wasm: Awaited<ReturnType<typeof Module>>;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const square = (size: number, x = 0, y = 0): Plan => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
const form = (kind: 'solid' | 'void', profile: Plan, start: number, end: number): Form => ({ id: kind + start, name: kind, visible: true, profile, meta: { mapId: 'm', kind, source: 'drawn', inset: 0, start, end } });

function volume(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute('position');
  let sum = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    sum += a.dot(b.clone().cross(c));
  }
  return sum / 6;
}

describe('concept massing', () => {
  it('sets a profile back from the boundary (either winding)', () => {
    const inset = insetProfile(wasm, square(20_000), 3000);
    const xs = inset.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(3000, 3);
    expect(Math.max(...xs)).toBeCloseTo(17_000, 3);
    expect(insetProfile(wasm, [...square(20_000)].reverse(), 3000)).toHaveLength(4);
    expect(insetProfile(wasm, square(4000), 3000)).toEqual([]);
  });

  it('subtracts voids from solids, with outward normals (positive volume)', () => {
    const solid = form('solid', square(10_000), 0, 10_000);
    const cut = form('void', square(4000, 3000, 3000), 2000, 6000);
    const whole = geometryFromPositions(massingPositions(wasm, [solid])!);
    expect(volume(whole)).toBeCloseTo(10_000 ** 3, -6);
    const carved = geometryFromPositions(massingPositions(wasm, [solid, cut])!);
    expect(volume(carved)).toBeCloseTo(10_000 ** 3 - 4000 * 4000 * 4000, -6);
    const box = new THREE.Box3().setFromBufferAttribute(carved.getAttribute('position') as THREE.BufferAttribute);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(10_000);
    expect(massingPositions(wasm, [cut])).toBeNull();
  });

  it('stores forms under a concept group hosted by the map and builds them cut in 3D', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    const solid = run<string>(app, 'upsert-massing-form', { mapId: map, kind: 'solid', source: 'drawn', base: square(10_000, 50_000, 50_000), profile: square(10_000, 50_000, 50_000), start: 0, end: 10_000 });
    run(app, 'upsert-massing-form', { mapId: map, kind: 'void', source: 'drawn', base: square(4000, 53_000, 53_000), profile: square(4000, 53_000, 53_000), start: 2000, end: 6000 });
    let doc = app.store.getState().doc;
    const root = conceptRoot(doc, map)!;
    expect(root.meta?.['host']).toBe(map);
    expect(formsOf(doc.elements, root.id)).toHaveLength(2);
    // Updating keeps the element and its identity.
    run(app, 'upsert-massing-form', { id: solid, mapId: map, kind: 'solid', source: 'drawn', base: square(10_000, 50_000, 50_000), profile: square(10_000, 50_000, 50_000), start: 0, end: 12_000 });
    doc = app.store.getState().doc;
    expect(massingOf(doc.elements[solid])?.end).toBe(12_000);
    // The worker is not available in Node: compute the booleans here and hand them to the cache.
    const forms = formsOf(doc.elements, root.id);
    primeMassing(forms, massingPositions(wasm, forms));
    const built = buildScene(doc, { lod: 'high', models: new Map(), textures: new Map() });
    const object = built.find((b) => b.id === root.id)!.object;
    let meshVolume = 0;
    object.traverse((child) => { if (child instanceof THREE.Mesh) meshVolume += volume(child.geometry); });
    expect(meshVolume).toBeCloseTo(10_000 * 10_000 * 12_000 - 4000 ** 3, -6);
  });

  it('recenters the map frame on the pin without sliding placed context', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    run(app, 'update-analysis', { id: map, patch: { lat: 51.5, lon: -0.12, mapCenter: { lat: 51.5, lon: -0.1186 } } });
    run(app, 'upsert-massing-form', { mapId: map, kind: 'solid', source: 'drawn', profile: square(1000), start: 0, end: 3000 });
    run(app, 'recenter-map', { id: map });
    const doc = app.store.getState().doc;
    expect(locationOf(doc.elements[map])?.mapCenter).toEqual({ lat: 51.5, lon: -0.1186 });
    expect(conceptRoot(doc, map)!.x).toBe(0);
    expect(siteContextRoot(doc, map)).toBeNull();
  });
});

describe('ribbon meshes', () => {
  it('builds one continuous strip with outward-facing faces', () => {
    const points = [{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 15_000, y: 5000 }, { x: 15_000, y: 15_000 }];
    const mesh = ribbonMesh(points, 6000, 0, 100, new THREE.MeshBasicMaterial())!;
    expect(volume(mesh.geometry)).toBeGreaterThan(0);
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.max.y - box.min.y).toBeCloseTo(100);
    expect(box.min.z).toBeCloseTo(-3000);
    expect(ribbonMesh([{ x: 0, y: 0 }], 6000, 0, 100, new THREE.MeshBasicMaterial())).toBeNull();
  });
});
