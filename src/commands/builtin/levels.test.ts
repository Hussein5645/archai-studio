import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { buildScene, instanceElevationOf, levelElevationOf } from '@/view3d/geometry';

describe('levels', () => {
  it('creates a rectangular datum and keeps linked element elevations updated with offsets', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 100, y: 200, width: 6000, height: 4000, elevation: 3000, name: 'Level 2' });
    const elementId = run<string>(app, 'create-rect', { x: 500, y: 500, width: 800, height: 600 });

    run(app, 'set-element-level-link', { id: elementId, levelId, offset: 250 });
    expect(instanceElevationOf(app.store.getState().doc.elements[elementId]!)).toBe(3250);
    expect(app.store.getState().doc.elements[elementId]!.meta?.['levelConstraint']).toEqual({ levelId, offset: 250 });

    run(app, 'set-level-elevation', { id: levelId, elevation: 3600 });
    expect(levelElevationOf(app.store.getState().doc.elements[levelId]!)).toBe(3600);
    expect(instanceElevationOf(app.store.getState().doc.elements[elementId]!)).toBe(3850);

    run(app, 'set-element-level-link', { id: elementId, levelId: null, offset: 0 });
    expect(app.store.getState().doc.elements[elementId]!.meta?.['levelConstraint']).toBeUndefined();
    expect(instanceElevationOf(app.store.getState().doc.elements[elementId]!)).toBe(3850);

    run(app, 'set-element-level-link', { id: elementId, levelId, offset: 100 });
    run(app, 'delete-selection', { ids: [levelId] });
    expect(app.store.getState().doc.elements[elementId]!.meta?.['levelConstraint']).toBeUndefined();
    expect(instanceElevationOf(app.store.getState().doc.elements[elementId]!)).toBe(3700);
  });

  it('renders the level perimeter as a dashed 3D datum at its elevation', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 3000, elevation: 2700 });
    const built = buildScene(app.store.getState().doc, { textures: new Map(), models: new Map() });
    const datum = built.find((item) => item.id === levelId)?.object;

    expect(datum).toBeInstanceOf(THREE.LineLoop);
    expect((datum as THREE.Line).material).toBeInstanceOf(THREE.LineDashedMaterial);
    const positions = (datum as THREE.Line).geometry.getAttribute('position');
    expect([...Array(positions.count)].map((_, index) => positions.getY(index))).toEqual([2700, 2700, 2700, 2700]);
  });
});
