import { describe, expect, it } from 'vitest';
import { hitTest } from '@/geometry';
import { selectableTarget } from '@/selection';
import { frameContentIds, sheetSources, sheetViewOf } from '@/sheets/model';
import { createTestApp, run } from '@/test/harness';

function setup() {
  const app = createTestApp();
  const paper = run<string>(app, 'create-paper', { x: 100_000, y: 0, size: 'A3', orientation: 'landscape', scale: 50 });
  return { app, paper, state: () => app.store.getState() };
}

describe('sheet mode', () => {
  it('opens a paper full screen and returns to the board where it was', () => {
    const { app, paper, state } = setup();
    const before = { ...state().ui.viewport };
    run(app, 'open-sheet', { id: paper });
    expect(state().ui.sheet?.paperId).toBe(paper);
    expect(state().ui.selection).toEqual([]);
    expect(state().ui.viewport).not.toEqual(before);
    run(app, 'close-sheet');
    expect(state().ui.sheet).toBeNull();
    expect(state().ui.viewport).toEqual(before);
    expect(state().ui.selection).toEqual([paper]);
  });

  it('puts new drawing onto the open sheet, in the paper frame', () => {
    const { app, paper, state } = setup();
    run(app, 'open-sheet', { id: paper });
    const rect = run<string>(app, 'create-rect', { x: 101_000, y: 2_000, width: 500, height: 500 });
    const element = state().doc.elements[rect]!;
    expect(element.parentId).toBe(paper);
    expect([element.x, element.y]).toEqual([1_000, 2_000]);
    run(app, 'close-sheet');
    const outside = run<string>(app, 'create-rect', { x: 0, y: 0 });
    expect(state().doc.elements[outside]!.parentId).toBeNull();
  });

  it('scopes clicks to the sheet and stops selection at its items', () => {
    const { app, paper, state } = setup();
    run(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000, style: { fill: '#000000' } });
    run(app, 'open-sheet', { id: paper });
    const item = run<string>(app, 'create-rect', { x: 101_000, y: 1_000, width: 1000, height: 1000, style: { fill: '#000000' } });
    const doc = state().doc;
    expect(hitTest(doc, { x: 500, y: 500 }, { tolerance: 1, scopeId: paper })).toBeNull();
    const hit = hitTest(doc, { x: 101_500, y: 1_500 }, { tolerance: 1, scopeId: paper });
    expect(hit?.id).toBe(item);
    expect(selectableTarget(doc.elements, hit!, false, paper).id).toBe(item);
    // On the board, the same click selects the whole sheet.
    expect(selectableTarget(doc.elements, hit!).id).toBe(paper);
  });
});

describe('sheet items', () => {
  it('places a level plan at the largest standard scale that fits, and rescales about its centre', () => {
    const { app, paper, state } = setup();
    const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 20_000, height: 12_000, name: 'Ground' });
    const source = sheetSources(state().doc).find((candidate) => candidate.id === level)!;
    expect(source).toMatchObject({ kind: 'plan', name: 'Ground plan' });
    const frame = run<string>(app, 'add-sheet-view', { paperId: paper, sourceId: level });
    let element = state().doc.elements[frame]!;
    const view = sheetViewOf(element)!;
    expect(element.parentId).toBe(paper);
    expect(view).toMatchObject({ source: 'plan', sourceId: level, number: '1', title: 'Ground plan' });
    // A3 landscape (420 × 297 mm): 20 m fits at 1:75 (267 mm) but not 1:50 (400 mm > 80%).
    expect(view.scale).toBe(75);
    expect(element.kind === 'rect' && element.width).toBeCloseTo((20_000 * 50) / 75);
    const centre = element.kind === 'rect' ? element.x + element.width / 2 : 0;
    run(app, 'set-sheet-view', { id: frame, scale: 100 });
    element = state().doc.elements[frame]!;
    expect(sheetViewOf(element)!.scale).toBe(100);
    expect(element.kind === 'rect' && element.width).toBeCloseTo(10_000);
    expect(element.kind === 'rect' && element.x + element.width / 2).toBeCloseTo(centre);
  });

  it('redraws only the level’s own elements in a plan frame, never sheets or other floors', () => {
    const { app, state } = setup();
    const ground = run<string>(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 10_000, name: 'Ground' });
    const first = run<string>(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 10_000, name: 'First', elevation: 3000 });
    const [wallA] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 1000], [5000, 1000]], type: 'wall', parentId: null });
    const [wallB] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 2000], [5000, 2000]], type: 'wall', parentId: null });
    run(app, 'set-element-level-link', { id: wallA, levelId: ground, offset: 0 });
    run(app, 'set-element-level-link', { id: wallB, levelId: first, offset: 0 });
    const loose = run<string>(app, 'create-rect', { x: 500, y: 500 });
    const crop = { x: 0, y: 0, width: 10_000, height: 10_000 };
    const plan = frameContentIds(state().doc.elements, { source: 'plan', sourceId: ground, crop });
    expect(plan).toContain(wallA);
    expect(plan).not.toContain(wallB);
    expect(plan).not.toContain(ground);
    const board = frameContentIds(state().doc.elements, { source: 'board', sourceId: null, crop });
    expect(board).toEqual(expect.arrayContaining([wallA, wallB, loose]));
    expect(board).not.toContain(first);
  });

  it('adds a title block, scale bar (following the frame) and north arrow', () => {
    const { app, paper, state } = setup();
    const frame = run<string>(app, 'add-sheet-view', { paperId: paper, crop: { x: 0, y: 0, width: 5000, height: 3000 }, scale: 50 });
    const block = run<string>(app, 'add-title-block', { paperId: paper, project: 'Harbour House' });
    run(app, 'set-title-block', { id: block, drawnBy: 'HK' });
    expect(state().doc.elements[block]!.meta?.['titleBlock']).toMatchObject({ project: 'Harbour House', drawnBy: 'HK', revision: 'A' });
    run(app, 'select', { ids: [frame] });
    const bar = run<string>(app, 'add-scale-bar', { paperId: paper });
    expect(state().doc.elements[bar]!.meta?.['scaleBar']).toEqual({ frameId: frame });
    const north = run<string>(app, 'add-north-arrow', { paperId: paper, rotation: 15 });
    expect(state().doc.elements[north]!.meta?.['northArrow']).toEqual({ rotation: 15 });
    for (const id of [block, bar, north]) expect(state().doc.elements[id]!.parentId).toBe(paper);
    run(app, 'set-paper', { id: paper, number: 'A-201' });
    expect(state().doc.elements[paper]!.meta?.['paper']).toMatchObject({ number: 'A-201' });
  });

  it('rejects placing something that is not a level or view', () => {
    const { app, paper } = setup();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0 });
    expect(app.executor.dispatchSync('add-sheet-view', { paperId: paper, sourceId: rect }).ok).toBe(false);
  });
});
