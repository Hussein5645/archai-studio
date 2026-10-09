import { describe, expect, it } from 'vitest';
import { annotationOf, inkOutline, isAnnotationLayer, isBoardOnly, stickyOf, thinStroke } from '@/annotations/model';
import { frameContentIds } from '@/sheets/model';
import { createTestApp, run } from '@/test/harness';

describe('annotation model', () => {
  it('outlines a pressure stroke as one closed path and thins dense samples', () => {
    const d = inkOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }], [10, 20, 10]);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    const thin = thinStroke([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }], [0.2, 0.3, 0.4, 0.5], 2);
    expect(thin.points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
    expect(thin.pressure).toEqual([0.2, 0.5]);
  });
});

describe('annotation commands', () => {
  it('draws ink into an annotation layer made on first use', () => {
    const app = createTestApp();
    const ink = run<string>(app, 'create-ink', { points: [[0, 0], [100, 50], [200, 0]], pressure: [0.2, 0.8, 0.5], width: 20, color: '#e11d48' });
    const { elements } = app.store.getState().doc;
    const stroke = elements[ink]!;
    expect(annotationOf(stroke)).toMatchObject({ kind: 'ink', pressure: [0.2, 0.8, 0.5], highlighter: false });
    const layer = elements[stroke.parentId!];
    expect(isAnnotationLayer(layer)).toBe(true);
    expect(app.store.getState().ui.annotation.layerId).toBe(layer!.id);
    expect(isBoardOnly(elements, ink)).toBe(true);
    // A second stroke reuses the layer.
    const second = run<string>(app, 'create-ink', { points: [[0, 0]], width: 10 });
    expect(app.store.getState().doc.elements[second]!.parentId).toBe(layer!.id);
  });

  it('starts a new layer when the active one is hidden, and on request', () => {
    const app = createTestApp();
    const first = run<string>(app, 'create-ink', { points: [[0, 0], [10, 10]], width: 5 });
    const layerId = app.store.getState().doc.elements[first]!.parentId!;
    run(app, 'set-property', { ids: [layerId], key: 'visible', value: false });
    const next = run<string>(app, 'create-ink', { points: [[0, 0], [10, 10]], width: 5 });
    expect(app.store.getState().doc.elements[next]!.parentId).not.toBe(layerId);
    const made = run<string>(app, 'create-annotation-layer', {});
    expect(app.store.getState().ui.annotation.layerId).toBe(made);
  });

  it('creates, edits and recolours sticky notes', () => {
    const app = createTestApp();
    const note = run<string>(app, 'create-sticky', { x: 1000, y: 1000, size: 400, color: '#fbcfe8' });
    const rect = app.store.getState().doc.elements[note]!;
    expect(rect.kind === 'rect' && rect.x).toBe(800);
    run(app, 'begin-text-edit', { id: note });
    expect(app.store.getState().ui.editingTextId).toBe(note);
    run(app, 'set-text', { id: note, text: 'Check the stair' });
    run(app, 'set-sticky', { ids: [note], color: '#bbf7d0' });
    expect(stickyOf(app.store.getState().doc.elements[note])).toEqual({ kind: 'sticky', text: 'Check the stair', color: '#bbf7d0' });
  });

  it('erases strokes in one undoable step', async () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-ink', { points: [[0, 0], [10, 10]], width: 5 });
    const b = run<string>(app, 'create-ink', { points: [[0, 0], [10, 10]], width: 5 });
    run(app, 'erase-annotations', { ids: [a, b] });
    expect(app.store.getState().doc.elements[a]).toBeUndefined();
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[a]).toBeDefined();
    expect(app.store.getState().doc.elements[b]).toBeDefined();
  });

  it('keeps annotations out of sheet view frames', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    const ink = run<string>(app, 'create-ink', { points: [[100, 100], [500, 500]], width: 20 });
    const ids = frameContentIds(app.store.getState().doc.elements, { source: 'board', sourceId: null, crop: { x: -100, y: -100, width: 2000, height: 2000 } } as never);
    expect(ids).toContain(rect);
    expect(ids).not.toContain(ink);
  });
});
