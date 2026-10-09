import { describe, expect, it } from 'vitest';
import { effectiveOverride, sheetViewOf } from '@/sheets/model';
import { pickInFrame } from '@/sheets/pick';
import { looksFor } from '@/sheets/frameRender';
import { recipeStyling, zoneColor } from '@/sheets/recipes';
import { createTestApp, run } from '@/test/harness';

/** A level with two walls and a rect, and an A3 sheet at 1:100 showing the level at 1:50. */
function setup() {
  const app = createTestApp();
  const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 8_000, name: 'Ground' });
  const [wallA] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 1000], [9000, 1000]], type: 'wall', parentId: null });
  const [wallB] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 6000], [9000, 6000]], type: 'wall', parentId: null });
  for (const id of [wallA!, wallB!]) run(app, 'set-element-level-link', { id, levelId: level, offset: 0 });
  const paper = run<string>(app, 'create-paper', { x: 100_000, y: 0, size: 'A3', orientation: 'landscape', scale: 100 });
  const frame = run<string>(app, 'add-sheet-view', { paperId: paper, sourceId: level, scale: 50, x: 20, y: 20 });
  run(app, 'open-sheet', { id: paper });
  const view = () => sheetViewOf(app.store.getState().doc.elements[frame])!;
  return { app, level, wallA: wallA!, wallB: wallB!, paper, frame, view, state: () => app.store.getState() };
}

describe('styling inside a view frame', () => {
  it('enters a frame, picks what it shows, and leaves', () => {
    const { app, frame, wallA, level, state } = setup();
    run(app, 'enter-sheet-view', { id: frame });
    expect(state().ui.sheet?.viewEdit).toEqual({ frameId: frame, picked: [] });
    // The level rect is view infrastructure: not pickable in its own plan.
    expect(run(app, 'pick-in-view', { ids: [wallA, level] })).toEqual([wallA]);
    run(app, 'exit-sheet-view');
    expect(state().ui.sheet?.viewEdit).toBeNull();
    expect(state().ui.selection).toEqual([frame]);
  });

  it('maps a click on the sheet into the frame crop', () => {
    const { app, frame, wallA, wallB, state } = setup();
    const doc = state().doc;
    const element = doc.elements[frame]!;
    // Frame at paper (20 mm, 20 mm) → board (100 000 + 2000, 2000); the crop starts at the level.
    const frameOrigin = { x: 100_000 + element.x, y: element.y };
    const k = 100 / 50; // board mm on the sheet per board mm of crop (1:50 on a 1:100 sheet)
    const view = sheetViewOf(element)!;
    const at = (x: number, y: number) => ({ x: frameOrigin.x + (x - view.crop.x) * k, y: frameOrigin.y + (y - view.crop.y) * k });
    expect(pickInFrame(doc, frame, at(5000, 1000), 20)).toBe(wallA);
    expect(pickInFrame(doc, frame, at(5000, 6000), 20)).toBe(wallB);
    expect(pickInFrame(doc, frame, at(5000, 3500), 20)).toBeNull();
    expect(pickInFrame(doc, frame, { x: 0, y: 0 }, 20)).toBeUndefined();
    // Once hidden in this view, a wall is looked through.
    run(app, 'set-view-override', { id: frame, elementIds: [wallA], patch: { visibility: 'hidden' } });
    expect(pickInFrame(state().doc, frame, at(5000, 1000), 20)).toBeNull();
  });

  it('stores overrides on the frame only and removes fields with null', async () => {
    const { app, frame, wallA, view, state } = setup();
    const before = JSON.stringify(state().doc.elements[wallA]);
    run(app, 'enter-sheet-view', { id: frame });
    run(app, 'pick-in-view', { ids: [wallA] });
    run(app, 'set-view-override', { patch: { fill: '#1d4ed8', emphasis: 'glow', label: 'Core' } });
    expect(view().overrides[wallA]).toEqual({ fill: '#1d4ed8', emphasis: 'glow', label: 'Core' });
    run(app, 'set-view-override', { patch: { emphasis: null } });
    expect(view().overrides[wallA]).toEqual({ fill: '#1d4ed8', label: 'Core' });
    expect(JSON.stringify(state().doc.elements[wallA])).toBe(before);
    expect(app.executor.dispatchSync('set-view-override', { patch: { fill: 'red' } }).ok).toBe(false);
    run(app, 'clear-view-override');
    expect(view().overrides).toEqual({});
    // Undo brings the styling back: it is ordinary document history.
    expect((await app.executor.dispatch('undo')).ok).toBe(true);
    expect(view().overrides[wallA]).toBeDefined();
  });

  it('picks similar elements and fades the rest', () => {
    const { app, frame, wallA, wallB, view, state } = setup();
    run(app, 'enter-sheet-view', { id: frame });
    run(app, 'pick-in-view', { ids: [wallA] });
    run(app, 'select-similar-in-view');
    expect(new Set(state().ui.sheet!.viewEdit!.picked)).toEqual(new Set([wallA, wallB]));
    run(app, 'set-view-override', { elementIds: [wallA], patch: { fill: '#ff0000' } });
    run(app, 'set-view-adjustments', { patch: { fadeOthers: true, contrast: 1.2 } });
    expect(view().adjustments).toMatchObject({ fadeOthers: true, contrast: 1.2, brightness: 1 });
    expect(effectiveOverride(view(), wallB)).toEqual({ visibility: 'ghost' });
    expect(looksFor(view(), [wallA, wallB])).toEqual({ [wallA]: { color: '#ff0000' }, [wallB]: { ghost: true } });
  });

  it('never deletes the frame with Delete while inside it', () => {
    const { app, frame, state } = setup();
    run(app, 'enter-sheet-view', { id: frame });
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(false);
    expect(state().doc.elements[frame]).toBeDefined();
  });
});

describe('diagram recipes', () => {
  it('zoning darkens walls and ghosts the rest; clear resets everything', () => {
    const { app, frame, wallA, view, state } = setup();
    const loose = run<string>(app, 'create-rect', { x: 102_000, y: 2_000 }); // on the sheet, not in the view
    void loose;
    run(app, 'apply-diagram-recipe', { id: frame, recipe: 'zoning' });
    expect(view().overrides[wallA]).toEqual({ fill: '#374151', stroke: '#374151' });
    expect(view().style).toBeNull(); // render styles only apply to 3D frames
    run(app, 'apply-diagram-recipe', { id: frame, recipe: 'circulation' });
    expect(view().adjustments.fadeOthers).toBe(true);
    run(app, 'apply-diagram-recipe', { id: frame, recipe: 'clear' });
    expect(view().overrides).toEqual({});
    expect(view().adjustments.fadeOthers).toBe(false);
    expect(app.executor.dispatchSync('apply-diagram-recipe', { id: frame, recipe: 'exploded' }).ok).toBe(false);
    void state;
  });

  it('lifts levels apart in exploded 3D views', () => {
    const { state, app } = setup();
    const upper = run<string>(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 8_000, name: 'First', elevation: 3000 });
    const [wallC] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 3000], [9000, 3000]], type: 'wall', parentId: null });
    run(app, 'set-element-level-link', { id: wallC, levelId: upper, offset: 0 });
    const doc = state().doc;
    const view3d = { ...sheetViewOf(Object.values(doc.elements).find((element) => sheetViewOf(element))!)!, source: 'view' as const };
    const styling = recipeStyling('exploded', doc, view3d, Object.keys(doc.elements));
    expect(styling.overrides[wallC!]?.lift).toBeGreaterThanOrEqual(4000);
    expect(styling.style).toBe('shaded');
  });

  it('gives rooms of the same name the same colour', () => {
    expect(zoneColor('Kitchen')).toBe(zoneColor(' kitchen '));
    expect(zoneColor('Kitchen')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
