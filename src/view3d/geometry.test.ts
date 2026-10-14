import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import * as THREE from 'three';
import { createTestApp, run } from '@/test/harness';
import { buildScene, type Built } from './geometry';
import { meshStore } from './meshes';

const options = { lod: 'high' as const, models: new Map(), textures: new Map() };
const byId = (built: Built[]) => new Map(built.map((item) => [item.id, item]));

describe('incremental scene builds', () => {
  it('uses whole-object ArchAI paint on new source material slots without mutating cached source materials', () => {
    const app = createTestApp();
    const materialId = run<string>(app, 'create-material', { material: { name: 'ArchAI orange', color: '#ff6600' } });
    const blobId = 'mesh-material-priority-test';
    const sourceMaterial = new THREE.MeshStandardMaterial({color: '#008800'});
    sourceMaterial.name = 'Renamed source slot';
    const source = new THREE.Group();
    source.add(new THREE.Mesh(new THREE.BoxGeometry(100,100,100), sourceMaterial));
    meshStore.models.set(blobId, source);
    try {
      const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100, meta: { mesh: { blobId, height: 100 }, materials: { body: materialId, 'asset:Old slot': materialId } } });
      const built = buildScene(app.store.getState().doc, options).find(entry => entry.id === id)!;
      const materials: THREE.Material[] = [];
      built.object.traverse(object => { if (object instanceof THREE.Mesh) materials.push(...(Array.isArray(object.material) ? object.material : [object.material])); });
      expect(materials.length).toBeGreaterThan(0);
      for (const material of materials) expect((material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff6600');
      expect(sourceMaterial.color.getHexString()).toBe('008800');
    } finally { meshStore.models.delete(blobId); }
  });
  it('selects geometry before construction while retaining hosted opening context', () => {
    const app = createTestApp();
    const wall = run<string>(app, 'create-arch-element', {
      tool: 'wall',
      points: [
        [0, 0],
        [3000, 0],
      ],
    });
    run(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      host: { wallId: wall, segment: 0, along: 1500 },
      rotation: 0,
    });
    run(app, 'create-rect', {
      x: 10000,
      y: 0,
      width: 100,
      height: 100,
      meta: { solid: { height: 1000 } },
    });
    const doc = app.store.getState().doc;
    const all = buildScene(doc, options);
    const selected = buildScene(doc, { ...options, include: (id) => id === wall });
    expect(selected.map((entry) => entry.id)).toEqual([wall]);
    const vertices = (items: Built[]) => {
      const counts: number[] = [];
      items
        .find((item) => item.id === wall)!
        .object.traverse((object) => {
        const mesh = object as Mesh;
          if (mesh.isMesh) counts.push(mesh.geometry.getAttribute('position').count);
        });
      return counts;
    };
    expect(vertices(selected)).toEqual(vertices(all));
    expect(buildScene(doc, { ...options, include: () => false })).toHaveLength(0);
  });
  it('reuses untouched objects and rebuilds edited ones and the walls their openings cut', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    const doorId = run<string>(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });
    const rectId = run<string>(app, 'create-rect', { x: 5000, y: 5000, meta: { solid: { height: 500, elevation: 0 } } });
    const first = byId(buildScene(app.store.getState().doc, options));

    // An edit elsewhere keeps both the wall and the door.
    run(app, 'move-selection', { ids: [rectId], dx: 100, dy: 0 });
    const second = byId(buildScene(app.store.getState().doc, options, first));
    expect(second.get(wallId)!.object).toBe(first.get(wallId)!.object);
    expect(second.get(doorId)!.object).toBe(first.get(doorId)!.object);
    expect(second.get(rectId)!.object).not.toBe(first.get(rectId)!.object);

    // Moving the door re-cuts its host wall.
    run(app, 'move-selection', { ids: [doorId], dx: 300, dy: 0 });
    const third = byId(buildScene(app.store.getState().doc, options, second));
    expect(third.get(doorId)!.object).not.toBe(second.get(doorId)!.object);
    expect(third.get(wallId)!.object).not.toBe(second.get(wallId)!.object);
    expect(third.get(rectId)!.object).toBe(second.get(rectId)!.object);

    // Shared inputs (graphics, definitions, models, LOD) invalidate everything.
    const low = byId(buildScene(app.store.getState().doc, { ...options, lod: 'low' }, third));
    expect(low.get(rectId)!.object).not.toBe(third.get(rectId)!.object);
  });
});
