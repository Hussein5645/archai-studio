import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { isPoint } from '@/document/point';
import { vrStopOf } from '@/document/vrStop';
import { buildScene } from '@/view3d/geometry';
import { vrStopsOf, vrTourJson } from '@/view3d/vrTour';

describe('VR stops', () => {
  it('places a stop as a reference point with a facing, and edits the facing', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-vr-stop', { x: 1000, y: 2000, elevation: 3000, heading: -90 });
    const stop = () => app.store.getState().doc.elements[id]!;
    expect(isPoint(stop())).toBe(true);
    expect(vrStopOf(stop())).toEqual({ heading: 270 });
    expect(stop().name).toBe('Stop 1');
    expect(app.store.getState().ui.selection).toEqual([id]);

    run(app, 'set-vr-stop-heading', { id, heading: 45 });
    expect(vrStopOf(stop())?.heading).toBe(45);
    expect(run<string>(app, 'create-vr-stop', { x: 0, y: 0 })).not.toBe(id);
    expect(app.store.getState().doc.elements[app.store.getState().ui.selection[0]!]!.name).toBe('Stop 2');
  });

  it('rejects a facing for an element that is not a stop', () => {
    const app = createTestApp();
    const point = run<string>(app, 'create-point', { x: 0, y: 0 });
    expect(() => run(app, 'set-vr-stop-heading', { id: point, heading: 10 })).toThrow();
  });

  it('draws a facing arrow on the 3D marker', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-vr-stop', { x: 0, y: 0, heading: 90 });
    const object = buildScene(app.store.getState().doc, { textures: new Map(), models: new Map() }).find((item) => item.id === id)!.object;
    const arrows: THREE.LineSegments[] = [];
    object.traverse((child) => {
      if (child instanceof THREE.LineSegments) arrows.push(child);
    });
    expect(arrows).toHaveLength(1);
    // Heading 90 points down the board, which is the scene's +z.
    const tip = new THREE.Vector3().fromBufferAttribute(arrows[0]!.geometry.getAttribute('position') as THREE.BufferAttribute, 1);
    expect(tip.x).toBeCloseTo(0);
    expect(tip.z).toBeCloseTo(900);
  });

  it('converts stops to the viewer tour format in metres', () => {
    const app = createTestApp();
    run(app, 'create-vr-stop', { x: 2000, y: -1500, elevation: 3200, heading: 0, name: 'Lounge' });
    run(app, 'create-vr-stop', { x: 0, y: 0, heading: 90 });
    run(app, 'create-point', { x: 9000, y: 9000 });
    const doc = app.store.getState().doc;
    expect(vrStopsOf(doc).map((stop) => stop.name)).toEqual(['Lounge', 'Stop 2']);
    const tour = vrTourJson(doc);
    expect(tour.model).toBe('model.glb');
    expect(tour.start).toBe('s1');
    expect(tour.spaces).toEqual([
      { id: 's1', name: 'Lounge', center: [2, -1.5], look: [5, -1.5], floor: 3.2 },
      { id: 's2', name: 'Stop 2', center: [0, 0], look: [0, 3], floor: 0 },
    ]);
  });
});
