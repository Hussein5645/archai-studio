import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';

describe('CommandExecutor', () => {
  it('runs a mutation, records history and selects the result', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 100, y: 200, width: 500, height: 300 });
    const state = app.store.getState();
    expect(id).toBe('el_1');
    expect(state.doc.elements[id]).toMatchObject({ kind: 'rect', x: 100, y: 200, width: 500, height: 300 });
    expect(state.ui.selection).toEqual([id]);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0]!.commandId).toBe('create-rect');
    expect(state.history.past[0]!.selectionBefore).toEqual([]);
    expect(state.history.past[0]!.selectionAfter).toEqual([id]);
    expect(state.session.dirty).toBe(true);
    expect(state.doc.meta.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('applies zod defaults and rejects invalid input without touching state', () => {
    const app = createTestApp();
    const before = app.store.getState();
    const bad = app.executor.dispatchSync('create-rect', { x: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-input');
    expect(app.store.getState()).toBe(before);

    run(app, 'create-rect', { x: 0, y: 0 });
    expect(app.store.getState().doc.elements['el_1']).toMatchObject({ width: 1000, height: 1000, radius: 0 });
  });

  it('reports unknown commands and unavailable commands', () => {
    const app = createTestApp();
    const unknown = app.executor.dispatchSync('no-such-command');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown-command');

    const unavailable = app.executor.dispatchSync('delete-selection', {});
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe('unavailable');
    expect(app.executor.isAvailable('delete-selection')).toBe(false);
  });

  it('undoes and redoes with selection restored', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'move-selection', { dx: 50, dy: 25 });
    expect(app.store.getState().doc.elements[id]).toMatchObject({ x: 50, y: 25 });

    expect(app.executor.undo()).toBe(true);
    expect(app.store.getState().doc.elements[id]).toMatchObject({ x: 0, y: 0 });
    expect(app.store.getState().ui.selection).toEqual([id]);

    expect(app.executor.undo()).toBe(true);
    expect(app.store.getState().doc.elements[id]).toBeUndefined();
    expect(app.store.getState().ui.selection).toEqual([]);
    expect(app.executor.undo()).toBe(false);

    expect(app.executor.redo()).toBe(true);
    expect(app.store.getState().doc.elements[id]).toMatchObject({ x: 0, y: 0 });
    expect(app.store.getState().ui.selection).toEqual([id]);
    expect(app.executor.redo()).toBe(true);
    expect(app.store.getState().doc.elements[id]).toMatchObject({ x: 50, y: 25 });
    expect(app.executor.redo()).toBe(false);
  });

  it('drops the redo stack when a new mutation lands', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    app.executor.undo();
    expect(app.store.getState().history.future).toHaveLength(1);
    run(app, 'create-rect', { x: 10, y: 10 });
    expect(app.store.getState().history.future).toHaveLength(0);
  });

  it('collapses a transaction into one history entry that undoes atomically', () => {
    const app = createTestApp();
    app.executor.transaction('Two rectangles', () => {
      run(app, 'create-rect', { x: 0, y: 0 });
      run(app, 'create-rect', { x: 2000, y: 0 });
    });
    const state = app.store.getState();
    expect(Object.keys(state.doc.elements)).toHaveLength(2);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0]!.label).toBe('Two rectangles');
    expect(state.history.past[0]!.commandId).toBe('transaction');

    app.executor.undo();
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
    app.executor.redo();
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(2);
  });

  it('does not record UI-only commands', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'clear-selection');
    run(app, 'zoom-in');
    expect(app.store.getState().history.past).toHaveLength(1);
    expect(app.store.getState().ui.selection).toEqual([]);
  });

  it('previews a mutation against a base document without committing', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const base = app.store.getState().doc;
    const previewed = app.executor.preview('move-selection', { dx: 300, dy: 0 }, base);
    expect(previewed.elements[id]).toMatchObject({ x: 300 });
    expect(app.store.getState().doc).toBe(base);
    expect(app.store.getState().history.past).toHaveLength(1);
  });

  it('reports changed ids and patches', () => {
    const app = createTestApp();
    const result = app.executor.dispatchSync('create-rect', { x: 0, y: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changedIds).toEqual(['el_1']);
      expect(result.patches.length).toBeGreaterThan(0);
      expect(result.historyEntryId).toBe('hist_1');
    }
  });

  it('describes every command with a JSON schema for its input', () => {
    const app = createTestApp();
    const described = app.executor.describe();
    const move = described.find((d) => d.id === 'move-selection');
    expect(move).toBeDefined();
    expect(move!.available).toBe(false);
    expect(move!.inputSchema).toMatchObject({ type: 'object' });
    expect(new Set(described.map((d) => d.id)).size).toBe(described.length);
  });

  it('accepts an empty input for every command reachable from the palette or a shortcut', async () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    const reachable = app.registry.all().filter((c) => c.palette !== false || (c.shortcuts?.length ?? 0) > 0);
    expect(reachable.length).toBeGreaterThan(30);
    for (const command of reachable) {
      const result = await app.executor.dispatch(command.id);
      if (!result.ok) expect(`${command.id}: ${result.error.code}`).not.toContain('invalid-input');
    }
  });

  it('runs effects that dispatch mutations', async () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    const result = await app.executor.dispatch('undo');
    expect(result.ok).toBe(true);
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
    const nothing = await app.executor.dispatch('undo');
    expect(nothing.ok).toBe(false);
  });
});
