import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { instanceElevationOf } from '@/view3d/geometry';
import { layerChildrenOf, layerPaintOrder, layerParentOf, LEVEL_LAYER_ARCH_TYPES } from './hierarchy';

describe('layer hierarchy', () => {
  it('paints hosted elements immediately after their host and keeps unrelated z-order', () => {
    const app = createTestApp();
    const hosted = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const behind = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const host = run<string>(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'set-host', { id: hosted, hostId: host });
    const elements = app.store.getState().doc.elements;

    expect(layerParentOf(elements, hosted)).toBe(host);
    expect(layerPaintOrder(elements)).toEqual([behind, host, hosted]);
  });

  it('places architectural elements under a level in layers when linked, if not already under another layer', () => {
    const app = createTestApp();
    const level1 = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 3000, name: 'Level 1' });
    const level2 = run<string>(app, 'create-level', { x: 6000, y: 0, width: 5000, height: 5000, elevation: 6000, name: 'Level 2' });

    // Verify all 11 architectural types
    for (const archType of LEVEL_LAYER_ARCH_TYPES) {
      const elId = run<string>(app, 'create-rect', {
        x: 100,
        y: 100,
        width: 500,
        height: 500,
        meta: { arch: { type: archType } },
      });

      // Initially at root
      expect(layerParentOf(app.store.getState().doc.elements, elId)).toBeNull();
      expect(layerChildrenOf(app.store.getState().doc.elements, level1)).not.toContain(elId);

      // Link to Level 1 -> becomes child of Level 1 in layers
      run(app, 'set-element-level-link', { id: elId, levelId: level1, offset: 150 });
      expect(layerParentOf(app.store.getState().doc.elements, elId)).toBe(level1);
      expect(layerChildrenOf(app.store.getState().doc.elements, level1)).toContain(elId);
      expect(instanceElevationOf(app.store.getState().doc.elements[elId]!)).toBe(3150);

      // Change link to Level 2 -> moves under Level 2 in layers
      run(app, 'set-element-level-link', { id: elId, levelId: level2, offset: 0 });
      expect(layerParentOf(app.store.getState().doc.elements, elId)).toBe(level2);
      expect(layerChildrenOf(app.store.getState().doc.elements, level2)).toContain(elId);
      expect(layerChildrenOf(app.store.getState().doc.elements, level1)).not.toContain(elId);
      expect(instanceElevationOf(app.store.getState().doc.elements[elId]!)).toBe(6000);

      // Unlink -> returns to root in layers
      run(app, 'set-element-level-link', { id: elId, levelId: null, offset: 0 });
      expect(layerParentOf(app.store.getState().doc.elements, elId)).toBeNull();
      expect(layerChildrenOf(app.store.getState().doc.elements, level2)).not.toContain(elId);
    }
  });

  it('updates elevation without changing layer parent if element is already under another layer', () => {
    const app = createTestApp();
    const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 8000, height: 6000, elevation: 3200, name: 'Level 1' });

    // 1. Door hosted on a wall
    const wall = run<string>(app, 'create-line', { points: [[0, 0], [2000, 0]], meta: { arch: { type: 'wall' } } });
    const door = run<string>(app, 'create-rect', { x: 500, y: 0, width: 900, height: 100, meta: { arch: { type: 'door', opening: { wallId: wall } } } });
    expect(layerParentOf(app.store.getState().doc.elements, door)).toBe(wall);

    run(app, 'set-element-level-link', { id: door, levelId: level, offset: 50 });
    // Elevation updated: 3200 + 50 = 3250
    expect(instanceElevationOf(app.store.getState().doc.elements[door]!)).toBe(3250);
    // Layer parent unchanged: still wall
    expect(layerParentOf(app.store.getState().doc.elements, door)).toBe(wall);
    expect(layerChildrenOf(app.store.getState().doc.elements, level)).not.toContain(door);

    // 2. Railing attached to a stair
    const stair = run<string>(app, 'create-stair', { flights: [{ kind: 'run', x: 0, y: 0, angle: 0, treads: 5 }] });
    const railing = run<string>(app, 'create-line', { points: [[100, 100], [100, 500]], meta: { arch: { type: 'railing' } } });
    run(app, 'reparent-element', { id: railing, parentId: stair });
    expect(layerParentOf(app.store.getState().doc.elements, railing)).toBe(stair);

    run(app, 'set-element-level-link', { id: railing, levelId: level, offset: 900 });
    // Elevation updated: 3200 + 900 = 4100
    expect(instanceElevationOf(app.store.getState().doc.elements[railing]!)).toBe(4100);
    // Layer parent unchanged: still stair
    expect(layerParentOf(app.store.getState().doc.elements, railing)).toBe(stair);
    expect(layerChildrenOf(app.store.getState().doc.elements, level)).not.toContain(railing);

    // 3. Wall inside a group
    const groupedWall = run<string>(app, 'create-line', { points: [[200, 200], [1200, 200]], meta: { arch: { type: 'wall' } } });
    const group = run<string>(app, 'group-selection', { ids: [groupedWall] });
    expect(layerParentOf(app.store.getState().doc.elements, groupedWall)).toBe(group);

    run(app, 'set-element-level-link', { id: groupedWall, levelId: level, offset: 0 });
    // Elevation updated: 3200
    expect(instanceElevationOf(app.store.getState().doc.elements[groupedWall]!)).toBe(3200);
    // Layer parent unchanged: still group
    expect(layerParentOf(app.store.getState().doc.elements, groupedWall)).toBe(group);
    expect(layerChildrenOf(app.store.getState().doc.elements, level)).not.toContain(groupedWall);
  });

  it('does not place non-architectural elements under a level in layers', () => {
    const app = createTestApp();
    const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 4000, height: 4000, elevation: 2500 });
    const plainRect = run<string>(app, 'create-rect', { x: 100, y: 100, width: 200, height: 200 });

    run(app, 'set-element-level-link', { id: plainRect, levelId: level, offset: 100 });
    expect(instanceElevationOf(app.store.getState().doc.elements[plainRect]!)).toBe(2600);
    // Plain rect is not an architectural element, remains at root in layers
    expect(layerParentOf(app.store.getState().doc.elements, plainRect)).toBeNull();
    expect(layerChildrenOf(app.store.getState().doc.elements, level)).not.toContain(plainRect);
  });

  it('links and unlinks when reparented into and out of a level via reparent-element', () => {
    const app = createTestApp();
    const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 4000, height: 4000, elevation: 2500 });
    const wall = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]], meta: { arch: { type: 'wall' }, instanceElevation: 2500 } });

    // Drag wall inside level
    run(app, 'reparent-element', { id: wall, parentId: level });
    expect(layerParentOf(app.store.getState().doc.elements, wall)).toBe(level);
    expect(app.store.getState().doc.elements[wall]!.meta?.['levelConstraint']).toEqual({ levelId: level, offset: 0 });

    // Drag wall back to root
    run(app, 'reparent-element', { id: wall, parentId: null });
    expect(layerParentOf(app.store.getState().doc.elements, wall)).toBeNull();
    expect(app.store.getState().doc.elements[wall]!.meta?.['levelConstraint']).toBeUndefined();
  });
});
