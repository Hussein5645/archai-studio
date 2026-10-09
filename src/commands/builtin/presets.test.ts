import { describe, expect, it } from 'vitest';
import { runAfterLanding } from '@/assets/system-geometry';
import { LOCAL_WALL_PRESETS_ID, parseSystemParameters } from '@/catalog';
import { createTestApp, runAsync } from '@/test/harness';

describe('wall presets', () => {
  it('save locally as one package, list under My presets and export/delete', async () => {
    const app = createTestApp();
    const layers = [
      { name: 'Brick', role: 'core', thickness: 102 },
      { name: 'Cavity', role: 'core', thickness: 50 },
    ];
    const id = await runAsync<string>(app, 'save-system-preset', { type: 'wall', name: 'Cavity wall', parameters: { layers, locationLine: 'outside' } });
    expect(id).toBe(`${LOCAL_WALL_PRESETS_ID}#cavity-wall`);
    await runAsync(app, 'save-system-preset', { type: 'wall', name: 'Stud', parameters: { layers: [{ name: 'Stud', role: 'core', thickness: 90 }] } });
    const types = await app.catalog.loadSystemTypes!('wall');
    expect(types.map((asset) => asset.name).sort()).toEqual(['Cavity wall', 'Stud']);
    expect(types.every((asset) => asset.packageId === LOCAL_WALL_PRESETS_ID && asset.isLocal)).toBe(true);
    expect(types.find((asset) => asset.id === id)?.systemParameters).toMatchObject({ layers, locationLine: 'outside' });
    // Overwriting by name keeps one entry.
    await runAsync(app, 'save-system-preset', { type: 'wall', name: 'Stud', parameters: { layers: [{ name: 'Stud', role: 'core', thickness: 120 }] } });
    expect((await app.catalog.loadSystemTypes!('wall')).length).toBe(2);
    expect(await runAsync(app, 'delete-system-preset', { type: 'wall', presetId: 'stud' })).toBe(1);
    // Every system tool has its own local preset package.
    const doorId = await runAsync<string>(app, 'save-system-preset', { type: 'door', name: 'Wide door', parameters: { width: 1100, handing: 'right' }, instanceEditable: ['width'] });
    expect(doorId).toBe('local-door-presets#wide-door');
    const doors = await app.catalog.loadSystemTypes!('door');
    expect(doors.map((asset) => asset.name)).toEqual(['Wide door']);
    expect(doors[0]!.systemParameters).toMatchObject({ width: 1100, handing: 'right' });
    expect(doors[0]!.instanceEditable).toEqual(['width']);
    expect((await app.catalog.loadSystemTypes!('wall')).map((asset) => asset.name)).toEqual(['Cavity wall']);
    // Presets never show in the Assets library tree.
    const root = await app.catalog.load();
    const flatten = (folder: typeof root): number => folder.assets.length + folder.folders.reduce((sum, child) => sum + flatten(child), 0);
    expect(flatten(root)).toBe(1); // the fake sofa only
  });
});

describe('preset files', () => {
  it('round-trips presets through a presets file and accepts a system .CAI', async () => {
    const app = createTestApp();
    await runAsync(app, 'save-system-preset', { type: 'door', name: 'Wide door', parameters: { width: 1100 } });
    const file = new TextEncoder().encode(JSON.stringify({ archaiPresets: 1, type: 'door', presets: [{ id: 'narrow', name: 'Narrow door', width: 700 }, { id: 'wide-door', name: 'Wide door', width: 1200 }] }));
    expect(await runAsync(app, 'import-system-presets', { type: 'door', bytes: file })).toBe(2);
    const doors = await app.catalog.loadSystemTypes!('door');
    expect(doors.map((asset) => [asset.name, asset.systemParameters?.['width']]).sort()).toEqual([
      ['Narrow door', 700],
      ['Wide door', 1200],
    ]);
    // Wrong tool and junk are rejected.
    const wall = new TextEncoder().encode(JSON.stringify({ archaiPresets: 1, type: 'wall', presets: [] }));
    expect((await app.executor.dispatch('import-system-presets', { type: 'door', bytes: wall })).ok).toBe(false);
    expect((await app.executor.dispatch('import-system-presets', { type: 'door', bytes: new TextEncoder().encode('{}') })).ok).toBe(false);
  });
});

describe('stair landings', () => {
  const parameters = parseSystemParameters('stair', { width: 1000, landingDepth: 1200 });
  const landing = { kind: 'landing' as const, x: 0, y: 0, angle: 0 };

  it('continue straight from the far edge', () => {
    const next = runAfterLanding(landing, 10, parameters);
    expect(next.start).toEqual({ x: 1200, y: 0 });
    expect(next.angle).toBe(0);
  });

  it('turn 90 degrees from the landing side at its middle', () => {
    const right = runAfterLanding(landing, 90, parameters);
    expect(right.start.x).toBeCloseTo(600);
    expect(right.start.y).toBeCloseTo(500);
    expect(right.angle).toBe(90);
    const left = runAfterLanding(landing, -80, parameters);
    expect(left.start.y).toBeCloseTo(-500);
    expect(left.angle).toBe(-90);
  });

  it('come back beside the first run on a doubled landing for a U-turn', () => {
    const back = runAfterLanding(landing, 175, parameters);
    expect(back.angle).toBe(180);
    expect(back.start.x).toBeCloseTo(0);
    expect(back.start.y).toBeCloseTo(1000);
    expect(back.landing).toMatchObject({ width: 2000, offset: 0 });
    const other = runAfterLanding(landing, -175, parameters);
    expect(other.start.y).toBeCloseTo(-1000);
    expect(other.landing).toMatchObject({ width: 2000, offset: -1000 });
  });
});

describe('3D view', () => {
  it('places a portal rect, keeps its camera without history and edits heights through set-solid', async () => {
    const { createTestApp: make, run: runSync } = await import('@/test/harness');
    const app = make();
    const portal = runSync<string>(app, 'create-view3d', { x: 0, y: 0, width: 4000, height: 3000 });
    expect(app.store.getState().doc.elements[portal]).toMatchObject({ kind: 'rect', meta: { view3d: { camera: null } } });
    runSync(app, 'set-view3d-camera', { id: portal, camera: { position: [1, 2, 3], target: [0, 0, 0] } });
    expect(app.store.getState().history.past.map((entry) => entry.commandId)).toEqual(['create-view3d']);
    runSync(app, 'open-view3d', { id: portal });
    expect(app.store.getState().ui.view3d).toEqual({ open: true, portalId: portal });
    runSync(app, 'close-view3d');
    expect(app.store.getState().ui.view3d.open).toBe(false);

    const rect = runSync<string>(app, 'create-rect', { x: 0, y: 0, width: 500, height: 500 });
    runSync(app, 'set-solid', { ids: [rect], height: 750, elevation: 100 });
    expect(app.store.getState().doc.elements[rect]!.meta).toEqual({ solid: { height: 750, elevation: 100 } });
    const [wall] = runSync<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0]] });
    runSync(app, 'set-solid', { ids: [wall], height: 2700 });
    expect((app.store.getState().doc.elements[wall!]!.meta!['arch'] as { parameters: { height: number } }).parameters.height).toBe(2700);
  });
});

describe('section views and papers', () => {
  it('create a section portal beside its cut line and papers at sheet size, sent to the back', async () => {
    const { createTestApp: make, run: runSync } = await import('@/test/harness');
    const app = make();
    const wall = runSync<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]] });
    const section = runSync<string>(app, 'create-section-view', { a: [0, 2000], b: [4000, 2000] });
    const portal = app.store.getState().doc.elements[section]!;
    expect(portal).toMatchObject({ kind: 'rect', meta: { view3d: { cut: { x: 2000, y: 2000, angle: 0, length: 4000 } } } });
    // Looking to the right of a left-to-right line means looking down the page; the portal sits above the line.
    expect(portal.y + (portal as { height: number }).height).toBeLessThan(2000);

    const paper = runSync<string>(app, 'create-paper', { x: 0, y: 0, size: 'A3', orientation: 'portrait', scale: 100 });
    const sheet = app.store.getState().doc.elements[paper]!;
    expect(sheet).toMatchObject({ kind: 'rect', width: 29700, height: 42000, meta: { paper: { size: 'A3', scale: 100, title: 'Paper 01' } } });
    expect(sheet.index < app.store.getState().doc.elements[wall[0]!]!.index).toBe(true);
    runSync(app, 'set-paper', { id: paper, orientation: 'landscape', scale: 50, title: 'Ground floor' });
    expect(app.store.getState().doc.elements[paper]).toMatchObject({ width: 21000, height: 14850, name: 'Ground floor' });
  });
});
