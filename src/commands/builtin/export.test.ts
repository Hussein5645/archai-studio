import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { ExportSettingsSchema, papersOf } from './export';

describe('export commands', () => {
  it('lists papers in board reading order with their regions and scales', () => {
    const app = createTestApp();
    const lower = run<string>(app, 'create-paper', { x: 0, y: 30_000, size: 'A3', scale: 100, title: 'Lower' });
    const right = run<string>(app, 'create-paper', { x: 20_000, y: 0, title: 'Right' });
    const left = run<string>(app, 'create-paper', { x: 0, y: 0, title: 'Left' });
    const papers = papersOf(app.store.getState().doc);
    expect(papers.map((paper) => paper.id)).toEqual([left, right, lower]);
    expect(papers[2]).toMatchObject({ title: 'Lower', scale: 100, region: { x: 0, y: 30_000, width: 42_000, height: 29_700 } });
  });

  it('opens the dialog on the selected paper, or the first one', () => {
    const app = createTestApp();
    expect(app.executor.dispatchSync('open-export-dialog', {}).ok).toBe(false);
    const first = run<string>(app, 'create-paper', { x: 0, y: 0 });
    const second = run<string>(app, 'create-paper', { x: 20_000, y: 0 });
    run(app, 'open-export-dialog', { id: second });
    expect(app.store.getState().ui.exportDialog).toEqual({ open: true, paperId: second });
    run(app, 'close-export-dialog');
    expect(app.store.getState().ui.exportDialog.open).toBe(false);
    run(app, 'clear-selection');
    run(app, 'open-export-dialog');
    expect(app.store.getState().ui.exportDialog.paperId).toBe(first);
  });

  it('rejects an export without a paper and validates settings', async () => {
    const app = createTestApp();
    const none = await app.executor.dispatch('export-paper', { format: 'png' });
    expect(none.ok).toBe(false);
    const bad = await app.executor.dispatch('export-paper', { format: 'dwg' });
    expect(bad.ok).toBe(false);
    expect(ExportSettingsSchema.parse({ format: 'dxf' })).toMatchObject({ format: 'dxf', dxfScope: 'sheet' });
    expect(ExportSettingsSchema.safeParse({ format: 'dxf', dxfScope: 'layout' }).success).toBe(false);
    const tooFine = await app.executor.dispatch('export-paper', { dpi: 5000 });
    expect(tooFine.ok).toBe(false);
    expect(app.platform.savedBinaries).toHaveLength(0);
  });
});
