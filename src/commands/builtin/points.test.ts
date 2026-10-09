import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { RectElement } from '@/document';
import { isPoint } from '@/document/point';
import { buildScene, instanceElevationOf } from '@/view3d/geometry';

describe('reference points', () => {
  it('places a point centred on the click and moves it in plan and height', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-point', { x: 1000, y: 2000 });
    const point = () => app.store.getState().doc.elements[id] as RectElement;
    expect(isPoint(point())).toBe(true);
    expect(point().x + point().width / 2).toBe(1000);
    expect(app.store.getState().ui.selection).toEqual([id]);

    run(app, 'move-points', { ids: [id], dx: 500, dy: -250, dz: 1200 });
    expect([point().x + point().width / 2, point().y + point().height / 2]).toEqual([1500, 1750]);
    expect(instanceElevationOf(point())).toBe(1200);
  });

  it('shows in 3D as a fixed-size marker at its elevation', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-point', { x: 0, y: 0, elevation: 2500 });
    const built = buildScene(app.store.getState().doc, { textures: new Map(), models: new Map() });
    const object = built.find((item) => item.id === id)!.object;
    let marker: THREE.Object3D | null = null;
    object.traverse((child) => { if (child.userData['pointMarker']) marker = child; });
    expect(marker).toBeInstanceOf(THREE.Points);
    expect(((marker as unknown as THREE.Points).material as THREE.PointsMaterial).sizeAttenuation).toBe(false);
    object.updateMatrixWorld(true);
    expect((marker as unknown as THREE.Points).getWorldPosition(new THREE.Vector3()).y).toBe(2500);
  });

  it('lifts any element, but not one whose level controls its elevation', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'move-points', { ids: [rect], dx: 0, dy: 0, dz: 300 });
    expect(instanceElevationOf(app.store.getState().doc.elements[rect]!)).toBe(300);
    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 3000 });
    run(app, 'set-element-level-link', { id: rect, levelId, offset: 0 });
    expect(() => run(app, 'move-points', { ids: [rect], dx: 0, dy: 0, dz: 100 })).toThrow(/level/);
    run(app, 'move-points', { ids: [rect], dx: 100, dy: 0, dz: 0 });
  });
});
