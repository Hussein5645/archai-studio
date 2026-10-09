import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { Element, LineElement } from '@/document';
import { archOf, archTypeOf } from '@/assets/arch-meta';
import { instanceElevationOf, buildScene } from '@/view3d/geometry';
import { meshOf } from '@/view3d/meshes';
import { slabOpenings } from '@/assets/slabOpenings';
import { wallPathData } from '@/render/wallOpenings';
import type { RevitImportReport } from './importRevit';

const model = {
  archaiRevit: 1,
  name: 'Sample house',
  materials: [
    { id: 'm1', name: 'Brick, Common', color: '#a4513a', roughness: 0.9 },
    { id: 'm2', name: 'Gypsum Wall Board', color: '#f0eee8' },
    { id: 'm3', name: 'Glass', color: '#9cc5e8', opacity: 0.3 },
  ],
  levels: [{ id: 'L1', name: 'Level 1', elevation: 0 }, { id: 'L2', name: 'Level 2', elevation: 3000 }],
  walls: [
    { id: 'w1', name: 'Exterior - Brick on Block', level: 'L1', points: [[0, 0], [6000, 0], [6000, 4000]], base: 0, height: 3000, layers: [{ name: 'Brick', role: 'finish', thickness: 100, material: 'm1' }, { name: 'Block', role: 'core', thickness: 190 }, { name: 'Gypsum', role: 'finish', thickness: 13, material: 'm2' }] },
    { id: 'w2', name: 'Interior', level: 'L2', points: [[0, 4000], [6000, 4000]], base: 3000, height: 2800, layers: [{ name: 'Stud', role: 'core', thickness: 100 }] },
    { id: 'cw', name: 'Storefront', level: 'L1', points: [[0, 0], [0, 4000]], base: 0, height: 3000, layers: [{ name: 'Glazing', role: 'core', thickness: 50 }], curtain: true },
  ],
  openings: [
    { id: 'd1', kind: 'door', name: 'Single-Flush 915 x 2134', wall: 'w1', start: 1000, end: 1915, bottom: 0, height: 2134 },
    // On the second segment of w1 (which starts 6000 mm along the wall).
    { id: 'n1', kind: 'window', name: 'Fixed 1220 x 1220', wall: 'w1', start: 7000, end: 8220, bottom: 900, height: 1220 },
    { id: 'bad', kind: 'door', wall: 'missing', start: 0, end: 900, bottom: 0, height: 2100 },
  ],
  slabs: [
    { id: 'f1', kind: 'floor', name: 'Generic 300mm', level: 'L1', outline: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], holes: [[[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]]], bottom: -300, thickness: 300, material: 'm2' },
  ],
  columns: [{ id: 'c1', name: 'Concrete 450', level: 'L1', x: 3000, y: 2000, width: 450, depth: 450, base: 0, height: 3000 }],
  railings: [{ id: 'r1', level: 'L2', points: [[0, 0], [3000, 0]], base: 3000, height: 1070 }],
  rooms: [{ id: 'rm1', name: 'Living', number: '101', level: 'L1', outline: [[150, 150], [5850, 150], [5850, 3850], [150, 3850]] }],
  meshes: [{ id: 'roof', name: 'Basic Roof', category: 'Roofs', level: 'L2', origin: [-500, -500, 5800], size: [7000, 5000, 1200], glb: 'Z2xURgIAAAA=' }],
};

const byType = (elements: Record<string, Element>, type: string) => Object.values(elements).filter((element) => archTypeOf(element) === type);

describe('Revit import', () => {
  it('rebuilds a Revit export as native ArchAI elements', () => {
    const app = createTestApp();
    const report = run<RevitImportReport>(app, 'import-revit-model', { model });
    const doc = app.store.getState().doc;
    expect(report.created).toMatchObject({ material: 3, level: 2, wall: 2, 'curtain wall': 1, door: 1, window: 1, floor: 1, column: 1, railing: 1, room: 1, roofs: 1 });
    expect(report.skipped.map((entry) => entry.id)).toEqual(['bad']);

    // Walls keep their layers (with materials), their name and their level.
    const [exterior, interior] = byType(doc.elements, 'wall') as LineElement[];
    expect(exterior!.name).toBe('Exterior - Brick on Block');
    const layers = (archOf(exterior!)!['parameters'] as { layers: { name: string; material?: string }[] }).layers;
    expect(layers.map((layer) => layer.name)).toEqual(['Brick', 'Block', 'Gypsum']);
    expect(doc.materials[layers[0]!.material!]?.name).toBe('Brick, Common');
    expect(instanceElevationOf(interior!, doc.elements)).toBe(3000);
    expect(interior!.meta!['levelConstraint']).toMatchObject({ offset: 0 });

    // Openings are hosted and cut their wall; the window lands on the wall's second segment.
    const door = byType(doc.elements, 'door')[0]!;
    expect(archOf(door)!['opening']).toMatchObject({ segment: 0, start: 1000, end: 1915 });
    const window = byType(doc.elements, 'window')[0]!;
    expect(archOf(window)!['opening']).toMatchObject({ segment: 1, start: 1000, end: 2220 });
    expect(instanceElevationOf(window, doc.elements)).toBe(900);
    expect(wallPathData(exterior!, doc.elements)).toContain('M 1915 0');

    // The floor keeps its thickness, bottom and opening.
    const floor = byType(doc.elements, 'floor')[0]!;
    expect(floor.meta!['solid']).toEqual({ height: 300, elevation: 0 });
    expect(instanceElevationOf(floor, doc.elements)).toBe(-300);
    expect(slabOpenings(floor)).toHaveLength(1);

    expect(byType(doc.elements, 'room')[0]!.name).toBe('101 Living');
    expect(byType(doc.elements, 'column')[0]!.meta!['levelConstraint']).toBeTruthy();

    // Unmapped geometry: a mesh element at its plan box and elevation.
    const roof = Object.values(doc.elements).find((element) => meshOf(element))!;
    expect(roof).toMatchObject({ name: 'Basic Roof', x: -500, y: -500, width: 7000, height: 5000 });
    expect(instanceElevationOf(roof, doc.elements)).toBe(5800);
    expect(doc.blobs[meshOf(roof)!.blobId]?.mime).toBe('model/gltf-binary');

    // Everything builds in 3D (the mesh shows its box until the model decodes).
    expect(buildScene(doc, { textures: new Map(), models: new Map() }).length).toBeGreaterThan(10);
  });

  it('is one undo step', async () => {
    const app = createTestApp();
    run(app, 'import-revit-model', { model });
    expect(Object.keys(app.store.getState().doc.elements).length).toBeGreaterThan(10);
    await app.executor.dispatch('undo');
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
  });

  it('rejects files that are not Revit exports', () => {
    const app = createTestApp();
    expect(() => run(app, 'import-revit-model', { model: { archaiRevit: 2 } })).toThrow();
  });
});
