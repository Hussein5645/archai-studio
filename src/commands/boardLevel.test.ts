import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';

describe('board level', () => {
  it('starts new elements at the board level and steps between levels', () => {
    const app = createTestApp();
    run(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 10_000, elevation: 4000, name: 'L1' });
    expect(run(app, 'board-level-up')).toBe(4000);
    const raised = run<string>(app, 'create-rect', { x: 100, y: 100, width: 1000, height: 1000 });
    expect(app.store.getState().doc.elements[raised]!.meta?.['instanceElevation']).toBe(4000);
    expect(run(app, 'board-level-up')).toBe(7000);
    expect(run(app, 'board-level-down')).toBe(4000);
    expect(run(app, 'board-level-down')).toBe(0);
    const ground = run<string>(app, 'create-rect', { x: 100, y: 100, width: 1000, height: 1000 });
    expect(app.store.getState().doc.elements[ground]!.meta?.['instanceElevation']).toBeUndefined();
  });
});
