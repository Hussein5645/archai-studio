import { describe, expect, it } from 'vitest';
import { createTestApp, run, runAsync } from '@/test/harness';
import type { RectElement } from '@/document';
import { sheetViewOf } from '@/sheets/model';

describe('sheet layout', () => {
  it('creates one numbered sheet per level plan and arranges views in a grid', () => {
    const app = createTestApp();
    run(app, 'create-level', { x: 0, y: 0, width: 6000, height: 4000, name: 'Ground' });
    run(app, 'create-level', { x: 0, y: 8000, width: 6000, height: 4000, name: 'First' });
    const sheets = run<string[]>(app, 'create-level-sheets');
    expect(sheets).toHaveLength(2);
    const elements = () => app.store.getState().doc.elements;
    const viewsOn = (paper: string) => Object.values(elements()).filter((e) => e.parentId === paper && sheetViewOf(e));
    expect(viewsOn(sheets[0]!)).toHaveLength(1);
    expect(() => run(app, 'create-level-sheets')).toThrow(/already on a sheet/);

    // Two more views on the first sheet, then a row layout inside the margins.
    const paper = sheets[0]!;
    const crop = { x: 0, y: 0, width: 2000, height: 2000 };
    run(app, 'add-sheet-view', { paperId: paper, crop, scale: 200 });
    run(app, 'add-sheet-view', { paperId: paper, crop, scale: 200 });
    run(app, 'arrange-sheet-views', { paperId: paper, layout: 'row' });
    const frames = viewsOn(paper) as RectElement[];
    const scale = 100;
    for (const frame of frames) {
      expect(frame.x).toBeGreaterThanOrEqual(15 * scale - 1e-6);
      expect(frame.x + frame.width).toBeLessThanOrEqual((elements()[paper] as RectElement).width - 15 * scale + 1e-6);
    }
    const xs = frames.map((f) => f.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(xs[1]!);
  });

  it('saves a sheet as a template without its views and makes new sheets from it', async () => {
    const app = createTestApp();
    const paper = run<string>(app, 'create-paper', { x: 0, y: 0 });
    run(app, 'add-title-block', { paperId: paper });
    run(app, 'add-sheet-view', { paperId: paper, crop: { x: 0, y: 0, width: 1000, height: 1000 } });
    await runAsync(app, 'save-sheet-template', { paperId: paper, name: 'Office A4' });
    const before = Object.keys(app.store.getState().doc.elements).length;
    const roots = await runAsync<string[]>(app, 'new-sheet-from-template', { name: 'Office A4', x: 100_000, y: 0 });
    const doc = app.store.getState().doc;
    const created = Object.keys(doc.elements).length - before;
    expect(created).toBe(2);
    const newPaper = doc.elements[roots[0]!] as RectElement;
    expect(newPaper.meta?.['paper']).toBeDefined();
    expect(newPaper.x).toBe(100_000);
    expect(Object.values(doc.elements).some((e) => e.parentId === newPaper.id && sheetViewOf(e))).toBe(false);
  });
});
