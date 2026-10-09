import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { boardDoc } from './state';

describe('gesture previews', () => {
  it('draws on the board only, leaving the document as the base until a commit clears it', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const base = app.store.getState().doc;
    const preview = app.executor.preview('move-selection', { ids: [id], dx: 500, dy: 0 }, base);
    app.store.setState({ preview });

    expect(app.store.getState().doc).toBe(base);
    expect(boardDoc(app.store.getState()).elements[id]!.x).toBe(500);

    // Selection changes the UI, not the document: the preview stays.
    run(app, 'select', { ids: [id] });
    expect(app.store.getState().preview).toBe(preview);

    // The gesture's command commits against the untouched base and supersedes the preview.
    run(app, 'move-selection', { ids: [id], dx: 500, dy: 0 });
    expect(app.store.getState().preview).toBeNull();
    expect(app.store.getState().doc.elements[id]!.x).toBe(500);
  });
});
