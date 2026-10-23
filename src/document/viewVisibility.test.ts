import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { documentInContext, viewContext } from './viewVisibility';
import { boardDoc } from '@/store';

describe('view-specific visibility', () => {
  it('keeps the Board and two views independent, with undo and an explicit global override', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 200, height: 200 });
    const first = run<string>(app, 'create-view3d');
    const second = run<string>(app, 'create-view3d');
    run(app, 'open-view3d', { id: first });
    run(app, 'set-context-visibility', { ids: [id], visible: false });
    let doc = app.store.getState().doc;
    expect(doc.elements[id]!.visible).toBe(true);
    expect(documentInContext(doc, viewContext(first)).elements[id]!.visible).toBe(false);
    expect(documentInContext(doc, viewContext(second)).elements[id]!.visible).toBe(true);
    expect(boardDoc(app.store.getState()).elements[id]!.visible).toBe(true);
    run(app, 'close-view3d');
    run(app, 'set-context-visibility', { ids: [id], visible: false });
    expect(boardDoc(app.store.getState()).elements[id]!.visible).toBe(false);
    app.executor.undo();
    expect(boardDoc(app.store.getState()).elements[id]!.visible).toBe(true);
    run(app, 'set-context-visibility', { ids: [id], visible: false, everywhere: true });
    doc = app.store.getState().doc;
    expect(documentInContext(doc, viewContext(second)).elements[id]!.visible).toBe(false);
    run(app, 'set-context-visibility', { ids: [id], visible: true, everywhere: true });
    doc = app.store.getState().doc;
    expect(documentInContext(doc, viewContext(first)).elements[id]!.visible).toBe(true);
    expect(documentInContext(doc, viewContext(first))).toBe(
      documentInContext(doc, viewContext(first)),
    );
  });
});
