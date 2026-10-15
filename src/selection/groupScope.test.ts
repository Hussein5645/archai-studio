import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { hitTest, elementsInArea, applyToPoint, worldMatrix } from '@/geometry';
import { selectableTarget } from './index';
import { groupPath } from './groupScope';

function fixture() {
  const app = createTestApp();
  const a = run<string>(app, 'create-rect', { x: 100, y: 100, width: 100, height: 100, style: { fill: '#ff0000' } });
  const b = run<string>(app, 'create-rect', { x: 300, y: 100, width: 100, height: 100 });
  const inner = run<string>(app, 'group-selection', { ids: [a], name: 'Inner' });
  const outer = run<string>(app, 'group-selection', { ids: [inner, b], name: 'Outer' });
  const outside = run<string>(app, 'create-rect', { x: 500, y: 100, width: 100, height: 100 });
  return { app, a, b, inner, outer, outside };
}

describe('group editing context', () => {
  it('enters nested contexts without changing document history and selects within the active level', () => {
    const { app, a, b, inner, outer, outside } = fixture();
    const history = app.store.getState().history;
    run(app, 'enter-group', { id: outer });
    run(app, 'select', { ids: [outside] });
    expect(app.store.getState().ui.selection).toEqual([]);
    run(app, 'select-all');
    expect(new Set(app.store.getState().ui.selection)).toEqual(new Set([inner, b]));
    const doc = app.store.getState().doc;
    const hit = hitTest(doc, { x: 150, y: 150 }, { tolerance: 0, scopeId: outer })!;
    expect(hit.id).toBe(a);
    expect(selectableTarget(doc.elements, hit, false, outer).id).toBe(inner);
    expect(elementsInArea(doc, { x: 0, y: 0, width: 1000, height: 1000 }, 'contain', { scopeId: outer }).map((e) => e.id)).not.toContain(outside);
    run(app, 'enter-group', { id: inner });
    expect(groupPath(doc.elements, inner).map((e) => e.id)).toEqual([outer, inner]);
    expect(selectableTarget(doc.elements, hit, false, inner).id).toBe(a);
    run(app, 'clear-selection');
    expect(app.store.getState().ui.groupEditId).toBe(outer);
    expect(app.store.getState().ui.selection).toEqual([inner]);
    run(app, 'exit-group');
    expect(app.store.getState().ui.groupEditId).toBeNull();
    expect(app.store.getState().ui.selection).toEqual([outer]);
    expect(app.store.getState().history).toBe(history);
  });

  it('creates inside a rotated group while preserving the requested world position and supports undo', async () => {
    const { app, outer } = fixture();
    run(app, 'rotate-selection', { ids: [outer], degrees: 30 });
    run(app, 'enter-group', { id: outer });
    const id = run<string>(app, 'create-rect', { x: 800, y: 500, width: 100, height: 100 });
    const doc = app.store.getState().doc;
    expect(doc.elements[id]!.parentId).toBe(outer);
    const origin = applyToPoint(worldMatrix(doc.elements, doc.elements[id]!), { x: 0, y: 0 });
    expect(origin.x).toBeCloseTo(800);
    expect(origin.y).toBeCloseTo(500);
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[id]).toBeUndefined();
    expect(app.store.getState().ui.groupEditId).toBe(outer);
  });

  it('rejects locked groups and clears a deleted context and document switches', async () => {
    const { app, a, outer } = fixture();
    run(app, 'set-property', { ids: [outer], key: 'locked', value: true });
    expect(app.executor.dispatchSync('enter-group', { id: outer }).ok).toBe(false);
    run(app, 'set-property', { ids: [outer], key: 'locked', value: false });
    run(app, 'enter-group', { id: outer });
    run(app, 'select', { ids: [a] });
    run(app, 'delete-selection', { ids: [outer] });
    expect(app.store.getState().ui.groupEditId).toBeNull();
    await app.executor.dispatch('undo');
    run(app, 'enter-group', { id: outer });
    await app.executor.dispatch('new-document');
    expect(app.store.getState().ui.groupEditId).toBeNull();
  });

  it('copies and pastes a member inside its group without losing its world placement', async () => {
    const { app, a, inner } = fixture();
    run(app, 'enter-group', { id: inner });
    run(app, 'select', { ids: [a] });
    const before = app.store.getState().doc;
    const origin = applyToPoint(worldMatrix(before.elements, before.elements[a]!), { x: 0, y: 0 });
    await app.executor.dispatch('copy-selection');
    const result = await app.executor.dispatch('paste', { offset: { x: 50, y: 60 } });
    expect(result.ok).toBe(true);
    const doc = app.store.getState().doc;
    const id = app.store.getState().ui.selection[0]!;
    expect(id).not.toBe(a);
    expect(doc.elements[id]!.parentId).toBe(inner);
    const pasted = applyToPoint(worldMatrix(doc.elements, doc.elements[id]!), { x: 0, y: 0 });
    expect(pasted.x).toBeCloseTo(origin.x + 50);
    expect(pasted.y).toBeCloseTo(origin.y + 60);
  });
});
