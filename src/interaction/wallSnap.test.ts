import { describe, expect, it } from 'vitest';
import { doorMountOffset, doorTemplate } from '@/assets/system-geometry';
import { parseSystemParameters } from '@/catalog';
import type { LineElement } from '@/document';
import { createTestApp, run } from '@/test/harness';
import { wallPathData } from '@/render/wallOpenings';
import { buildScene } from '@/view3d/geometry';
import { findWallSnap, wallOpeningsFor } from './wallSnap';

const near = (value: number, expected: number, epsilon = 1e-4) => expect(Math.abs(value - expected)).toBeLessThan(epsilon);

describe('wall snapping and openings', () => {
  it('centres and aligns an opening on a horizontal wall', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    const snap = findWallSnap(app.store.getState().doc, { x: 1500, y: 80 }, 900, 0, 0);

    expect(snap).not.toBeNull();
    expect(snap?.rotation).toBe(0);
    expect(snap?.opening).toEqual({ wallId, segment: 0, start: 1050, end: 1950 });
    expect(snap).toMatchObject({ x: 1050, y: 0, thickness: 200 });
  });

  it('works on angled walls and offsets a centred window across the wall', () => {
    const app = createTestApp();
    run(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 3000]] });
    const snap = findWallSnap(app.store.getState().doc, { x: 1500, y: 1500 }, 1200, 75, 20);

    expect(snap).not.toBeNull();
    near(snap!.rotation, 45);
    const localCentre = { x: snap!.x + Math.cos(Math.PI / 4) * 600 - Math.sin(Math.PI / 4) * 75, y: snap!.y + Math.sin(Math.PI / 4) * 600 + Math.cos(Math.PI / 4) * 75 };
    near(localCentre.x, 1500);
    near(localCentre.y, 1500);
  });

  it('does not attach beyond the wall snap range', () => {
    const app = createTestApp();
    run(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    expect(findWallSnap(app.store.getState().doc, { x: 1500, y: 500 }, 900, 0, 20)).toBeNull();
  });

  it('snaps hosted elements to the tangent and arc length of a true curved wall', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-curved-wall', {
      path: {
        start: [0, 0],
        segments: [{ kind: 'arc', center: [0, 1000], radius: 1000, startAngle: -Math.PI / 2, endAngle: 0, clockwise: false }],
      },
    });
    const snap = findWallSnap(app.store.getState().doc, { x: 707, y: 293 }, 400, 0, 30);

    expect(snap).not.toBeNull();
    expect(snap!.rotation).toBeCloseTo(45, 0);
    expect(snap!.opening.wallId).toBe(wallId);
    expect(snap!.opening.curveAlong).toBeCloseTo(Math.PI * 1000 / 4, 0);
    expect((app.store.getState().doc.elements[wallId] as LineElement).path?.segments[0]).toMatchObject({ kind: 'arc', radius: 1000 });

    const doorId = run<string>(app, 'create-arch-element', {
      tool: 'door', x: snap!.x, y: snap!.y, rotation: snap!.rotation,
      meta: { arch: { type: 'door', width: 400, wallMountOffset: 0, opening: snap!.opening } },
    });
    const before = app.store.getState().doc.elements[doorId]!.y;
    run(app, 'move-line-curve-handle', { id: wallId, segment: 0, handle: 'center', x: 0, y: 1100 });
    expect(app.store.getState().doc.elements[doorId]!.y).not.toBeCloseTo(before);
  });

  it('removes attached door and window intervals from the wall path', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    run(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });
    const doc = app.store.getState().doc;
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 1050 0 M 1950 0 L 3000 0');
  });

  it('cuts upper floor wall when wall and door are on Level 2', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 3000, name: 'Level 2' });
    const wallId = run<string>(app, 'create-arch-element', {
      tool: 'wall',
      points: [[0, 0], [3000, 0]],
      meta: { levelConstraint: { levelId, offset: 0 }, instanceElevation: 3000 },
    });
    run(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });

    const doc = app.store.getState().doc;
    // Door inherits wall elevation (3000) so it cuts the wall on Level 2
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 1050 0 M 1950 0 L 3000 0');

    // 3D scene cut verification
    const built = buildScene(doc, { lod: 'high', models: new Map(), textures: new Map() });
    const wallBuilt = built.find((b) => b.id === wallId);
    expect(wallBuilt).toBeDefined();
    // A wall with an opening has multiple piece meshes (left, right, above opening)
    expect(wallBuilt!.object.children.length).toBeGreaterThan(2);
  });

  it('does not cut Level 2 wall if door is on Level 1 (elevation isolation)', () => {
    const app = createTestApp();
    const level1 = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 0, name: 'Level 1' });
    const level2 = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 3000, name: 'Level 2' });
    const wallId = run<string>(app, 'create-arch-element', {
      tool: 'wall',
      points: [[0, 0], [3000, 0]],
      meta: { levelConstraint: { levelId: level2, offset: 0 }, instanceElevation: 3000 },
    });
    // Door explicitly on Level 1
    run<string>(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: {
        levelConstraint: { levelId: level1, offset: 0 },
        instanceElevation: 0,
        arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } },
      },
    });

    const doc = app.store.getState().doc;
    // Does not cut Level 2 wall because door is vertically on Level 1 (0..2100 vs 3000..6000)
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 3000 0');
  });

  it('updates wall cut when duplicating a wall with hosted door', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    run(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });

    // Select wall and duplicate
    run(app, 'select', { ids: [wallId], mode: 'replace' });
    const duplicatedIds = run<string[]>(app, 'duplicate-selection', { ids: [wallId], offset: { x: 0, y: 500 } });
    const clonedWallId = duplicatedIds[0]!;

    const doc = app.store.getState().doc;
    const clonedWall = doc.elements[clonedWallId] as LineElement;
    expect(clonedWall).toBeDefined();

    // The cloned wall should have the door interval cut out
    expect(wallPathData(clonedWall, doc.elements)).toBe('M 0 0 L 1050 0 M 1950 0 L 3000 0');
  });

  it('updates wall cut when door is moved along the wall via move-selection', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    const doorId = run<string>(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });

    // Move door by dx: +200 along wall
    run(app, 'move-selection', { ids: [doorId], dx: 200, dy: 0 });

    const doc = app.store.getState().doc;
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 1250 0 M 2150 0 L 3000 0');
  });

  it('removes wall cut when door is moved off the wall', () => {
    const app = createTestApp();
    const wallId = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0]] });
    const doorId = run<string>(app, 'create-arch-element', {
      tool: 'door',
      x: 1050,
      y: 0,
      meta: { arch: { type: 'door', width: 900, opening: { wallId, segment: 0, start: 1050, end: 1950 } } },
    });

    // Move door far away from wall
    run(app, 'move-selection', { ids: [doorId], dx: 0, dy: 2000 });

    const doc = app.store.getState().doc;
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 3000 0');
  });

  it('cuts wall with window on Level 2 and updates when level elevation changes', () => {
    const app = createTestApp();
    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 5000, elevation: 3000, name: 'Level 2' });
    const wallId = run<string>(app, 'create-arch-element', {
      tool: 'wall',
      points: [[0, 0], [3000, 0]],
      meta: { levelConstraint: { levelId, offset: 0 }, instanceElevation: 3000 },
    });
    run(app, 'create-arch-element', {
      tool: 'window',
      x: 1000,
      y: 0,
      meta: {
        arch: {
          type: 'window',
          width: 1000,
          parameters: { sill: 900, height: 1200 },
          opening: { wallId, segment: 0, start: 1000, end: 2000 },
        },
      },
    });

    let doc = app.store.getState().doc;
    // 2D opening cut (window template width is 1200, spanning 1000 to 2200)
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 1000 0 M 2200 0 L 3000 0');

    // 3D scene: window mesh and wall cut pieces exist
    let built = buildScene(doc, { lod: 'high', models: new Map(), textures: new Map() });
    let wallBuilt = built.find((b) => b.id === wallId);
    expect(wallBuilt).toBeDefined();
    expect(wallBuilt!.object.children.length).toBeGreaterThan(2);

    // Now change Level 2 elevation from 3000 to 4500
    run(app, 'set-level-elevation', { id: levelId, elevation: 4500 });
    doc = app.store.getState().doc;

    // Both wall and cut remain updated and aligned
    expect(wallPathData(doc.elements[wallId] as LineElement, doc.elements)).toBe('M 0 0 L 1000 0 M 2200 0 L 3000 0');
    built = buildScene(doc, { lod: 'high', models: new Map(), textures: new Map() });
    wallBuilt = built.find((b) => b.id === wallId);
    expect(wallBuilt!.object.children.length).toBeGreaterThan(2);
  });
});

/** Places a door snapped onto whichever wall is nearest `point`, exactly like the interactive tool. */
function placeDoor(app: ReturnType<typeof createTestApp>, point: { x: number; y: number }): string {
  const doc = app.store.getState().doc;
  const params = parseSystemParameters('door', {});
  const template = doorTemplate(params);
  const centerY = doorMountOffset(params, template);
  const snap = findWallSnap(doc, point, template.width, centerY, 400);
  if (!snap) throw new Error('No wall near the door point');
  return run<string>(app, 'create-arch-element', {
    tool: 'door',
    x: snap.x,
    y: snap.y,
    rotation: snap.rotation,
    meta: { arch: { type: 'door', width: template.width, wallMountOffset: centerY, opening: snap.opening } },
  });
}

describe('wallOpeningsFor', () => {
  it('finds a door hosted on its wall and not on an unrelated wall', () => {
    const app = createTestApp();
    const wallAId = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]] })[0]!;
    const wallBId = run<string[]>(app, 'create-wall-segments', { points: [[0, 3000], [4000, 3000]] })[0]!;
    placeDoor(app, { x: 2000, y: 0 });

    const doc = app.store.getState().doc;
    const wallA = doc.elements[wallAId] as LineElement;
    const wallB = doc.elements[wallBId] as LineElement;

    expect(wallOpeningsFor(wallA, doc.elements)).toHaveLength(1);
    expect(wallOpeningsFor(wallB, doc.elements)).toHaveLength(0);
  });

  it('scopes multiple doors to their own walls only', () => {
    const app = createTestApp();
    const wallAId = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [6000, 0]] })[0]!;
    const wallBId = run<string[]>(app, 'create-wall-segments', { points: [[0, 3000], [6000, 3000]] })[0]!;
    placeDoor(app, { x: 1500, y: 0 });
    placeDoor(app, { x: 4500, y: 0 });
    placeDoor(app, { x: 3000, y: 3000 });

    const doc = app.store.getState().doc;
    const wallA = doc.elements[wallAId] as LineElement;
    const wallB = doc.elements[wallBId] as LineElement;

    expect(wallOpeningsFor(wallA, doc.elements)).toHaveLength(2);
    expect(wallOpeningsFor(wallB, doc.elements)).toHaveLength(1);
  });

  it('finds a door under both walls when an explicit host overrides a different stored opening wall', () => {
    const app = createTestApp();
    const wallAId = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]] })[0]!;
    // Close enough to wall A that a door snapped there also passes wall B's geometric tolerance.
    const wallBId = run<string[]>(app, 'create-wall-segments', { points: [[0, 80], [4000, 80]] })[0]!;
    const doorId = placeDoor(app, { x: 2000, y: 0 });

    const doc = app.store.getState().doc;
    const door = doc.elements[doorId]!;
    const arch = door.meta!['arch'] as Record<string, unknown>;
    // Point the explicit host at wall B while the stored opening still names wall A.
    const edited = { ...door, meta: { ...door.meta, host: wallBId, arch: { ...arch, opening: { ...(arch['opening'] as object), wallId: wallAId } } } };
    const nextDoc = { ...doc, elements: { ...doc.elements, [doorId]: edited } };

    const wallA = nextDoc.elements[wallAId] as LineElement;
    const wallB = nextDoc.elements[wallBId] as LineElement;
    expect(wallOpeningsFor(wallA, nextDoc.elements).map((o) => o.element.id)).toContain(doorId);
    expect(wallOpeningsFor(wallB, nextDoc.elements).map((o) => o.element.id)).toContain(doorId);
  });
});
