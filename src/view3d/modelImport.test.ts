import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { guessUnit, MODEL_EXTENSIONS, modelFileFilters, primaryModelFile } from './modelImport';
import { MODEL_EXTENSION } from './modelFiles';
import { meshOf } from './meshes';
import { instanceElevationOf } from './geometry';

describe('3D model import', () => {
  it('knows every format it lists, and only those', () => {
    for (const extension of MODEL_EXTENSIONS) expect(MODEL_EXTENSION.test(`model.${extension}`), extension).toBe(true);
    expect(MODEL_EXTENSION.test('model.rvt')).toBe(false);
  });

  it('picks the model among companion files', () => {
    const files = [{ name: 'chair.mtl', bytes: new Uint8Array() }, { name: 'wood.jpg', bytes: new Uint8Array() }, { name: 'Chair.OBJ', bytes: new Uint8Array() }];
    expect(primaryModelFile(files)?.name).toBe('Chair.OBJ');
    expect(primaryModelFile(files.slice(0, 2))).toBeNull();
  });

  it('lists each format on its own line in the open dialog', () => {
    const filters = modelFileFilters();
    expect(filters[0]!.name).toBe('All 3D models');
    expect(filters.find((filter) => filter.name === 'FBX')?.extensions).toEqual(['fbx']);
    expect(filters.find((filter) => filter.name === 'USD')?.extensions).toEqual(['usd', 'usda', 'usdc']);
    expect(filters.flatMap((filter) => filter.extensions)).toEqual(expect.arrayContaining(MODEL_EXTENSIONS));
    expect(filters.at(-1)).toEqual({ name: 'All files', extensions: ['*'] });
  });

  it('guesses units from the size of unitless models', () => {
    expect(guessUnit(1.8)).toBe('m');
    expect(guessUnit(180)).toBe('cm');
    expect(guessUnit(1800)).toBe('mm');
  });

  it('places a converted model as a mesh element centred on the point, and swaps it keeping its centre', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-mesh-element', { name: 'Chair', glb: 'Z2xURgIAAAA=', x: 1000, y: 2000, size: [600, 500, 800], unit: 'cm', up: 'y', format: 'FBX' });
    const element = () => app.store.getState().doc.elements[id]!;
    expect(element()).toMatchObject({ x: 700, y: 1750, width: 600, height: 500 });
    expect(meshOf(element())).toMatchObject({ height: 800, unit: 'cm', up: 'y' });
    expect(instanceElevationOf(element())).toBe(0);
    expect(app.store.getState().ui.selection).toEqual([id]);
    run(app, 'replace-mesh-model', { id, glb: 'Z2xURgIAAAB=', size: [6000, 5000, 8000], unit: 'm', up: 'z' });
    expect(element()).toMatchObject({ x: -2000, y: -500, width: 6000, height: 5000 });
    expect(meshOf(element())).toMatchObject({ height: 8000, unit: 'm', up: 'z' });
  });
});
