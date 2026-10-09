import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { Material, MaterialPattern } from '@/document';
import { PatternSchema } from '@/document';
import { buildScene } from '@/view3d/geometry';
import { applyWorldUvs, groupByNormal } from '@/view3d/surfaceUv';
import { renderPattern } from './patterns';
import { readMaterialPack, writeMaterialPack } from './pack';
import { materialById, slotsOf, surfacesOf } from './slots';
import { PRESETS } from './builtin';

const pattern = (input: Partial<MaterialPattern>) => PatternSchema.parse({ kind: 'brick', ...input });

function wall(app: ReturnType<typeof createTestApp>, layers = [{ name: 'Plaster', role: 'finish', thickness: 15 }, { name: 'Brick', role: 'core', thickness: 200 }, { name: 'Plaster', role: 'finish', thickness: 15 }]) {
  return run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [4000, 0]], meta: { arch: { parameters: { layers } } } });
}

function meshesOf(app: ReturnType<typeof createTestApp>, id: string): THREE.Mesh[] {
  const built = buildScene(app.store.getState().doc, { textures: new Map(), models: new Map() }).find((item) => item.id === id)!;
  const meshes: THREE.Mesh[] = [];
  built.object.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

const nameOf = (material: THREE.Material | THREE.Material[], index = 0) => (Array.isArray(material) ? material[index]! : material).name;

describe('procedural patterns', () => {
  it('renders one period of every pattern at true size, with joints in the joint colour', () => {
    for (const kind of ['brick', 'tiles', 'planks', 'stone', 'stripes'] as const) {
      const image = renderPattern(pattern({ kind, joint: 10, jointColor: '#000000' }), '#ff0000', 256);
      expect(image.width).toBeGreaterThan(15);
      expect(image.periodU).toBeGreaterThan(0);
      expect(image.albedo.length).toBe(image.width * image.height * 4);
      let joints = 0;
      for (let i = 0; i < image.albedo.length; i += 4) if (image.albedo[i] === 0 && image.albedo[i + 1] === 0 && image.albedo[i + 2] === 0) joints++;
      expect(joints, kind).toBeGreaterThan(0);
    }
  });

  it('lays stretcher bond as 4 bricks by 8 courses per period', () => {
    const image = renderPattern(pattern({ unitWidth: 215, unitHeight: 65, joint: 10 }), '#a4513a');
    expect(image.periodU).toBe(4 * 225);
    expect(image.periodV).toBe(8 * 75);
  });

  it('is deterministic and changes with the seed', () => {
    const a = renderPattern(pattern({ kind: 'stone', seed: 1 }), '#888888', 128);
    const b = renderPattern(pattern({ kind: 'stone', seed: 1 }), '#888888', 128);
    const c = renderPattern(pattern({ kind: 'stone', seed: 2 }), '#888888', 128);
    expect(a.albedo).toEqual(b.albedo);
    expect(a.albedo).not.toEqual(c.albedo);
  });

  it('tiles herringbone over a square period with both brick directions', () => {
    const image = renderPattern(pattern({ layout: 'herringbone', unitWidth: 200, unitHeight: 100, joint: 0 }), '#9a5a40', 128);
    expect(image.periodU).toBe(image.periodV);
  });
});

describe('material library commands', () => {
  it('creates from a preset, edits, duplicates and edits a default in place', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-material', { preset: 'preset:brick-red' });
    const doc = () => app.store.getState().doc;
    expect(doc().materials[id]?.name).toBe('Red brick');
    run(app, 'update-material', { id, patch: { roughness: 0.4, name: 'Old brick' } });
    expect(doc().materials[id]).toMatchObject({ roughness: 0.4, name: 'Old brick', id });
    run(app, 'update-material', { id, patch: { map: null } });
    expect(doc().materials[id]?.map).toBeUndefined();
    const copy = run<string>(app, 'duplicate-material', { id });
    expect(doc().materials[copy]?.name).toBe('Old brick copy');
    // A default becomes a library entry when edited, and deleting it resets it.
    run(app, 'update-material', { id: 'default:wall-core', patch: { color: '#123456' } });
    expect(materialById(doc(), 'default:wall-core')?.color).toBe('#123456');
    run(app, 'delete-material', { id: 'default:wall-core' });
    expect(materialById(doc(), 'default:wall-core')?.color).toBe('#8d8f96');
  });

  it('rejects invalid edits', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-material', {});
    expect(() => run(app, 'update-material', { id, patch: { roughness: 3 } })).toThrow();
    expect(() => run(app, 'create-material', { preset: 'preset:nope' })).toThrow();
  });

  it('every preset is a valid material', () => {
    expect(PRESETS.length).toBeGreaterThan(20);
    for (const preset of PRESETS) expect(preset.id.startsWith('preset:')).toBe(true);
  });
});

describe('assigning materials', () => {
  it('lists slots and surfaces per type', () => {
    const app = createTestApp();
    const id = wall(app);
    const element = app.store.getState().doc.elements[id]!;
    expect(slotsOf(element).map((slot) => slot.key)).toEqual(['layer:0', 'layer:1', 'layer:2']);
    expect(slotsOf(element).map((slot) => slot.label)).toEqual(['Plaster', 'Brick', 'Plaster']);
    expect(surfacesOf(element)).toContain('sideA');
  });

  it('puts a material on a wall layer by type and by element, and shows it in 3D', () => {
    const app = createTestApp();
    const id = wall(app);
    const brick = run<string>(app, 'create-material', { preset: 'preset:brick-red' });
    run(app, 'assign-material', { ids: [id], slot: 'layer:1', materialId: brick, scope: 'type' });
    const layers = (app.store.getState().doc.elements[id]!.meta!['arch'] as { parameters: { layers: { material?: string }[] } }).parameters.layers;
    expect(layers[1]!.material).toBe(brick);
    const core = meshesOf(app, id).filter((mesh) => mesh.userData['slot'] === 'layer:1');
    expect(core.length).toBeGreaterThan(0);
    expect(nameOf(core[0]!.material)).toBe('Red brick');

    const steel = run<string>(app, 'create-material', { preset: 'preset:steel' });
    run(app, 'assign-material', { ids: [id], slot: 'layer:1', materialId: steel });
    expect(nameOf(meshesOf(app, id).find((mesh) => mesh.userData['slot'] === 'layer:1')!.material)).toBe('Brushed steel');
    run(app, 'assign-material', { ids: [id], slot: 'layer:1', materialId: null });
    expect(nameOf(meshesOf(app, id).find((mesh) => mesh.userData['slot'] === 'layer:1')!.material)).toBe('Red brick');
    expect(() => run(app, 'assign-material', { ids: [id], slot: 'leaf', materialId: steel })).toThrow();
  });

  it('paints a wall side in a zone: the wall splits at the zone edge and only the zone gets the paint', () => {
    const app = createTestApp();
    const id = wall(app);
    const before = meshesOf(app, id).length;
    const tiles = run<string>(app, 'create-material', { preset: 'preset:tiles-white' });
    run(app, 'assign-material', { ids: [id], surface: 'sideB', materialId: tiles, zone: { v: [0, 1200] } });
    const meshes = meshesOf(app, id);
    expect(meshes.length).toBe(before * 2);
    const sideB = 4; // BoxGeometry group order: +x, -x, +y, -y, +z, -z
    const inside = meshes.filter((mesh) => mesh.userData['slot'] === 'layer:2');
    const painted = inside.filter((mesh) => nameOf(mesh.material, sideB) === 'White tiles 200');
    expect(painted).toHaveLength(1);
    painted[0]!.geometry.computeBoundingBox();
    const box = new THREE.Box3().setFromObject(painted[0]!);
    expect(box.max.y).toBeCloseTo(1200);
    // The other side and the other faces keep the layer's material.
    expect(nameOf(painted[0]!.material, 5)).toBe('Wall finish');

    // A whole-surface paint replaces the zones.
    run(app, 'assign-material', { ids: [id], surface: 'sideB', materialId: tiles });
    expect(meshesOf(app, id).length).toBe(before);
    run(app, 'set-surface-paint', { id, surface: 'sideB', paints: [] });
    expect(app.store.getState().doc.elements[id]!.meta!['surfaces']).toEqual({});
  });

  it('paints the top of an extruded solid separately from its sides', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    run(app, 'set-solid', { ids: [rect], height: 500 });
    const oak = run<string>(app, 'create-material', { preset: 'preset:oak' });
    run(app, 'assign-material', { ids: [rect], surface: 'top', materialId: oak });
    const mesh = meshesOf(app, rect)[0]!;
    expect(mesh.userData['surfaces']).toEqual(['top', 'bottom', 'sides']);
    expect((mesh.material as THREE.Material[]).map((material) => material.name)).toEqual(['Oak planks', '', '']);
  });

  it('deleting a material returns its users to their defaults (or a replacement)', () => {
    const app = createTestApp();
    const id = wall(app);
    const brick = run<string>(app, 'create-material', { preset: 'preset:brick-red' });
    const concrete = run<string>(app, 'create-material', { preset: 'preset:concrete' });
    run(app, 'assign-material', { ids: [id], slot: 'layer:1', materialId: brick, scope: 'type' });
    run(app, 'assign-material', { ids: [id], surface: 'sideA', materialId: brick });
    run(app, 'delete-material', { id: brick, replaceWith: concrete });
    const element = app.store.getState().doc.elements[id]!;
    expect(JSON.stringify(element.meta)).not.toContain(brick);
    expect(JSON.stringify(element.meta)).toContain(concrete);
    run(app, 'delete-material', { id: concrete });
    expect(JSON.stringify(app.store.getState().doc.elements[id]!.meta)).not.toContain(concrete);
  });
});

describe('geometry for materials', () => {
  it('groups faces into top, bottom and sides', () => {
    const geometry = groupByNormal(new THREE.BoxGeometry(100, 100, 100));
    expect(geometry.groups.map((group) => [group.materialIndex, group.count])).toEqual([[0, 6], [1, 6], [2, 24]]);
  });

  it('maps textured meshes in world millimetres, continuing across neighbouring boxes', () => {
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 100), material);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 100), material);
    a.position.set(500, 500, 0);
    b.position.set(1500, 500, 0);
    root.add(a, b);
    applyWorldUvs(root);
    const range = (mesh: THREE.Mesh) => {
      const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const us: number[] = [];
      for (let i = 0; i < uv.count; i++) us.push(Math.abs(uv.getX(i)));
      return [Math.min(...us), Math.max(...us)];
    };
    expect(range(a)[1]).toBeCloseTo(1000);
    expect(range(b)[1]).toBeCloseTo(2000);
  });
});

describe('material packs', () => {
  it('round-trips materials and their image textures', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-material', { material: { name: 'Photo', color: '#ffffff' } });
    run(app, 'set-material-texture', { id, channel: 'map', blob: { mime: 'image/png', data: 'iVBORw0KGgo=', width: 2, height: 2 } });
    const doc = app.store.getState().doc;
    const bytes = writeMaterialPack(doc, [doc.materials[id] as Material], 'Pack');
    const pack = readMaterialPack(bytes);
    expect(pack.name).toBe('Pack');
    expect(pack.materials[0]?.name).toBe('Photo');
    expect(pack.blobs).toHaveLength(1);

    const other = createTestApp();
    const added = run<string[]>(other, 'import-material-pack', { data: Buffer.from(bytes).toString('base64') });
    const imported = other.store.getState().doc.materials[added[0]!]!;
    expect(imported.name).toBe('Photo');
    expect(imported.map && 'blobId' in imported.map && other.store.getState().doc.blobs[imported.map.blobId]).toBeTruthy();
  });
});
