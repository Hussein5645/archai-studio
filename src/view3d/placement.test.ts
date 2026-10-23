import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { scenePlacement } from './placement';
import { createToastStore } from '@/ui/toast-store';

describe('direct 3D placement', () => {
  it('creates a column on a picked floor and a wall from its clicked path, through undoable commands', () => {
    const app = createTestApp();
    const placement = scenePlacement({ ...app, toasts: createToastStore() });
    run(app, 'open-view3d');
    run(app, 'set-tool', { tool: 'arch:column' });
    expect(placement.place({ x: 1200, y: 2200, elevation: 3000, heading: 0 })).toBe(true);
    const column = Object.values(app.store.getState().doc.elements).find(
      (e) => (e.meta?.['arch'] as { type?: string })?.type === 'column',
    );
    expect(column?.meta?.['instanceElevation']).toBe(3000);
    run(app, 'set-tool', { tool: 'arch:wall' });
    placement.place({ x: 0, y: 0, elevation: 3000, heading: 0 });
    placement.place({ x: 5000, y: 0, elevation: 3000, heading: 0 });
    placement.finish();
    const wall = Object.values(app.store.getState().doc.elements).find(
      (e) => (e.meta?.['arch'] as { type?: string })?.type === 'wall',
    );
    expect(wall?.kind).toBe('line');
    expect(wall?.meta?.['instanceElevation']).toBe(3000);
    app.executor.undo();
    expect(app.store.getState().doc.elements[wall!.id]).toBeUndefined();
    expect(app.store.getState().doc.elements[column!.id]).toBeDefined();
  });
});
