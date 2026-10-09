import { hasEndpointHandles, resizeRuleFor } from '@/assets/arch-meta';
import { describe, expect, it } from 'vitest';
import { childrenOf, type InstanceElement, type LineElement, type RectElement, type TextElement } from '@/document';
import { findEnclosure, worldBounds } from '@/geometry';
import { createTestApp, run, runAsync } from '@/test/harness';
import { parseDocument, serializeDocument } from '@/persistence/serialize';

const near = (value: number, expected: number, eps = 1e-6) => expect(Math.abs(value - expected)).toBeLessThan(eps);

describe('transform commands', () => {
  it('stores elevation as a per-instance transform for every element kind', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const column = run<string>(app, 'create-arch-element', { tool: 'column', x: 1000, y: 0 });
    run(app, 'set-instance-elevation', { ids: [rect, column], elevation: 1250 });

    expect(app.store.getState().doc.elements[rect]!.meta?.['instanceElevation']).toBe(1250);
    expect(app.store.getState().doc.elements[column]!.meta?.['instanceElevation']).toBe(1250);
    expect((app.store.getState().doc.elements[column]!.meta?.['arch'] as Record<string, unknown>)['parameters']).toMatchObject({ elevation: 0 });
  });

  it('moves the selection in world space, even inside a rotated group', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const groupId = run<string>(app, 'group-selection', {});
    run(app, 'set-transform', { id: groupId, rotation: 90 });
    run(app, 'select', { ids: [groupId] });
    const before = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[a]!);
    run(app, 'move-selection', { dx: 10, dy: 20 });
    const after = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[a]!);
    near(after.x - before.x, 10);
    near(after.y - before.y, 20);
  });

  it('keeps an attached measurement fixed to its parent while free measurements can move', () => {
    const app = createTestApp();
    const wall = run<string>(app, 'create-line', { points: [[100, 100], [1100, 100]], name: 'Wall' });
    const attached = run<string>(app, 'create-line', {
      points: [[0, 0], [500, 0]],
      parentId: wall,
      name: 'Measure',
      meta: { measure: { distance: 500 } },
    });
    const free = run<string>(app, 'create-line', {
      points: [[0, 300], [500, 300]],
      name: 'Measure',
      meta: { measure: { distance: 500 } },
    });

    run(app, 'select', { ids: [attached] });
    expect(app.executor.dispatchSync('move-selection', { dx: 20, dy: 30 }).ok).toBe(false);
    run(app, 'select', { ids: [free] });
    run(app, 'move-selection', { dx: 20, dy: 30 });
    expect(app.store.getState().doc.elements[free]).toMatchObject({ x: 20, y: 330 });

    const before = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[attached]!);
    run(app, 'select', { ids: [wall] });
    run(app, 'move-selection', { dx: 40, dy: 50 });
    const after = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[attached]!);
    near(after.x - before.x, 40);
    near(after.y - before.y, 50);
  });

  it('refuses to move locked elements', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'lock-selection', {});
    const result = app.executor.dispatchSync('move-selection', { dx: 1, dy: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rejected');
  });

  it('rotates about the centre when setting rotation through set-transform', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 200, height: 100 });
    run(app, 'set-transform', { id, rotation: 90 });
    const el = app.store.getState().doc.elements[id]!;
    const bounds = worldBounds(app.store.getState().doc.elements, el);
    near(bounds.x + bounds.width / 2, 100);
    near(bounds.y + bounds.height / 2, 50);
    near(bounds.width, 100);
    near(bounds.height, 200);
  });

  it('resizes a multi-selection by scaling world bounds', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const b = run<string>(app, 'create-rect', { x: 200, y: 0, width: 100, height: 100 });
    run(app, 'select', { ids: [a, b] });
    run(app, 'resize-selection', {
      from: { x: 0, y: 0, width: 300, height: 100 },
      to: { x: 0, y: 0, width: 600, height: 100 },
    });
    const doc = app.store.getState().doc;
    expect(doc.elements[a]).toMatchObject({ x: 0, width: 200, height: 100 });
    expect(doc.elements[b]).toMatchObject({ x: 400, width: 200, height: 100 });
  });

  it('scales line points when resized through set-transform', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-line', { points: [[0, 0], [100, 50]] });
    run(app, 'set-transform', { id, width: 200, height: 100 });
    const line = app.store.getState().doc.elements[id] as LineElement;
    expect(line.points).toEqual([[0, 0], [200, 100]]);
  });

  it('rotates a selection about its centre', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const b = run<string>(app, 'create-rect', { x: 200, y: 0, width: 100, height: 100 });
    run(app, 'select', { ids: [a, b] });
    run(app, 'rotate-selection', { degrees: 180 });
    const doc = app.store.getState().doc;
    const boundsA = worldBounds(doc.elements, doc.elements[a]!);
    const boundsB = worldBounds(doc.elements, doc.elements[b]!);
    near(boundsA.x, 200);
    near(boundsB.x, 0);
    near(doc.elements[a]!.rotation, 180);
  });

  it('nudges with arrow-key commands', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'nudge-right');
    run(app, 'nudge-down-big');
    expect(app.store.getState().doc.elements[id]).toMatchObject({ x: 10, y: 100 });
  });

  it('never scales doors directly', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-arch-element', { tool: 'door', x: 0, y: 0 });
    const setSize = app.executor.dispatchSync('set-transform', { id, width: 1200 });
    const uniform = app.executor.dispatchSync('set-uniform-asset-scale', { id, percent: 150 });
    expect(setSize.ok).toBe(false);
    expect(uniform.ok).toBe(false);
    expect(app.store.getState().doc.elements[id]).toMatchObject({ width: 900, height: 900 });
  });
});

describe('architectural boundaries', () => {
  it('creates individual joined wall segments', () => {
    const app = createTestApp();
    const ids = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0], [3000, 2000]] });
    expect(ids).toHaveLength(2);
    const doc = app.store.getState().doc;
    expect(doc.elements[ids[0]!]!.meta?.['arch']).toMatchObject({ type: 'wall', joints: { end: { enabled: true } } });
    expect(doc.elements[ids[1]!]!.meta?.['arch']).toMatchObject({ type: 'wall', joints: { start: { enabled: true } } });
  });

  it('moves any vertex of a multi-segment railing', () => {
    const app = createTestApp();
    const railing = run<string>(app, 'create-arch-element', {
      tool: 'railing',
      points: [[0, 0], [1000, 0], [1000, 1000], [2000, 1000]],
    });

    run(app, 'move-line-endpoint', { id: railing, endpoint: 'point:2', x: 1400, y: 1200 });

    const element = app.store.getState().doc.elements[railing] as LineElement;
    expect(element.points).toEqual([[0, 0], [1000, 0], [1400, 1200], [2000, 1000]]);
  });

  it('detects a wall/divider enclosure and creates a room with a text label', () => {
    const app = createTestApp();
    run(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000], [0, 3000], [0, 0]] });
    const enclosure = findEnclosure(app.store.getState().doc, { x: 1000, y: 1000 });
    expect(enclosure).not.toBeNull();
    const roomId = run<string>(app, 'create-room-enclosure', { points: enclosure!.map((point) => [point.x, point.y]) });
    const doc = app.store.getState().doc;
    expect(doc.elements[roomId]!.meta?.['arch']).toMatchObject({ type: 'room', area: 12_000_000 });
    const label = Object.values(doc.elements).find((element) => element.kind === 'text' && element.meta?.['arch'] && typeof element.meta['arch'] === 'object' && !Array.isArray(element.meta['arch']) && element.meta['arch']['type'] === 'room-label');
    expect(label).toMatchObject({ kind: 'text', text: 'Room\n12.00 m²' });
  });

  it('creates floor and ceiling slabs from an enclosure with useful 3D defaults', () => {
    const app = createTestApp();
    const points = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];
    const floor = run<string>(app, 'create-slab-enclosure', { points, type: 'floor' });
    const ceiling = run<string>(app, 'create-slab-enclosure', { points, type: 'ceiling' });
    const doc = app.store.getState().doc;

    expect(doc.elements[floor]).toMatchObject({
      kind: 'line', closed: true, name: 'Floor',
      meta: { arch: { type: 'floor', area: 12_000_000 }, solid: { height: 200, elevation: 0 } },
    });
    expect(doc.elements[ceiling]).toMatchObject({
      kind: 'line', closed: true, name: 'Ceiling',
      meta: { arch: { type: 'ceiling', area: 12_000_000 }, solid: { height: 100, elevation: 2700 } },
    });

    run(app, 'set-system-configuration', {
      id: floor,
      assetId: null,
      parameters: { thickness: 350, elevation: 150, material: 'timber' },
    });
    expect(app.store.getState().doc.elements[floor]!.meta).toMatchObject({
      arch: { type: 'floor', parameters: { thickness: 350, elevation: 0, material: 'timber' } },
      solid: { height: 350, elevation: 0 },
    });
  });

  it('places new rooms, floors, and ceilings at the bottom of Layers', () => {
    const app = createTestApp();
    const drawing = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const points = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];
    const room = run<string>(app, 'create-room-enclosure', { points });
    const floor = run<string>(app, 'create-slab-enclosure', { points, type: 'floor' });
    const ceiling = run<string>(app, 'create-slab-enclosure', { points, type: 'ceiling' });
    const order = childrenOf(app.store.getState().doc.elements, null).map((element) => element.id);

    expect(order.indexOf(ceiling)).toBeLessThan(order.indexOf(floor));
    expect(order.indexOf(floor)).toBeLessThan(order.indexOf(room));
    expect(order.indexOf(room)).toBeLessThan(order.indexOf(drawing));
  });

  it('updates an existing room face, area, and label when its enclosure changes', () => {
    const app = createTestApp();
    const walls = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000], [0, 3000], [0, 0]] });
    const enclosure = findEnclosure(app.store.getState().doc, { x: 1000, y: 1000 })!;
    const roomId = run<string>(app, 'create-room-enclosure', { points: enclosure.map((point) => [point.x, point.y]), seed: [1000, 1000] });

    run(app, 'move-line-endpoint', { id: walls[1], endpoint: 'start', x: 5000, y: 0 });
    run(app, 'move-line-endpoint', { id: walls[1], endpoint: 'end', x: 5000, y: 3000 });

    const doc = app.store.getState().doc;
    expect(doc.elements[roomId]!.meta?.['arch']).toMatchObject({ type: 'room', area: 15_000_000 });
    const label = Object.values(doc.elements).find((element) => element.kind === 'text' && (element.meta?.['arch'] as { roomId?: string } | undefined)?.roomId === roomId);
    expect(label).toMatchObject({ kind: 'text', text: 'Room\n15.00 m²' });
  });

  it('uses room dividers as enclosure edges without rendering them as walls', () => {
    const app = createTestApp();
    run(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000], [0, 3000], [0, 0]] });
    run(app, 'create-arch-element', { tool: 'room-divider', points: [[2000, 0], [2000, 3000]] });
    const left = findEnclosure(app.store.getState().doc, { x: 1000, y: 1500 });
    const right = findEnclosure(app.store.getState().doc, { x: 3000, y: 1500 });
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left).not.toEqual(right);
  });
});

describe('arrange commands', () => {
  it('groups and ungroups without moving anything', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 100, y: 100, width: 100, height: 100, rotation: 30 });
    const b = run<string>(app, 'create-rect', { x: 400, y: 100, width: 100, height: 100 });
    run(app, 'select', { ids: [a, b] });
    const before = [a, b].map((id) => worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[id]!));

    const groupId = run<string>(app, 'group-selection', {});
    let doc = app.store.getState().doc;
    expect(doc.elements[groupId]!.kind).toBe('group');
    expect(doc.elements[a]!.parentId).toBe(groupId);
    expect(app.store.getState().ui.selection).toEqual([groupId]);
    const grouped = [a, b].map((id) => worldBounds(doc.elements, doc.elements[id]!));
    grouped.forEach((bounds, i) => {
      near(bounds.x, before[i]!.x);
      near(bounds.y, before[i]!.y);
    });

    run(app, 'set-transform', { id: groupId, rotation: 45 });
    const rotated = [a, b].map((id) => worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[id]!));

    run(app, 'ungroup-selection', {});
    doc = app.store.getState().doc;
    expect(doc.elements[groupId]).toBeUndefined();
    expect(doc.elements[a]!.parentId).toBeNull();
    expect(new Set(app.store.getState().ui.selection)).toEqual(new Set([a, b]));
    [a, b].forEach((id, i) => {
      const bounds = worldBounds(doc.elements, doc.elements[id]!);
      near(bounds.x, rotated[i]!.x, 1e-6);
      near(bounds.y, rotated[i]!.y, 1e-6);
    });
  });

  it('reorders siblings', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const b = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const c = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const order = () => childrenOf(app.store.getState().doc.elements, null).map((e) => e.id);
    expect(order()).toEqual([a, b, c]);

    run(app, 'select', { ids: [a] });
    run(app, 'bring-forward');
    expect(order()).toEqual([b, a, c]);
    run(app, 'bring-to-front');
    expect(order()).toEqual([b, c, a]);
    run(app, 'send-backward');
    expect(order()).toEqual([b, a, c]);
    run(app, 'send-to-back');
    expect(order()).toEqual([a, b, c]);

    run(app, 'select', { ids: [a, b] });
    run(app, 'bring-to-front');
    expect(order()).toEqual([c, a, b]);
  });

  it('places dragged layers relative to siblings and lifts children to the root without moving them', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 100, y: 120, width: 100, height: 100 });
    const b = run<string>(app, 'create-rect', { x: 300, y: 120, width: 100, height: 100 });
    const c = run<string>(app, 'create-rect', { x: 500, y: 120, width: 100, height: 100 });
    const order = () => childrenOf(app.store.getState().doc.elements, null).map((element) => element.id);

    run(app, 'reparent-element', { id: a, parentId: null, targetId: b, placement: 'front' });
    expect(order()).toEqual([b, a, c]);
    run(app, 'reparent-element', { id: a, parentId: null, targetId: b, placement: 'behind' });
    expect(order()).toEqual([a, b, c]);

    run(app, 'select', { ids: [a, b] });
    const group = run<string>(app, 'group-selection', {});
    const before = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[a]!);
    run(app, 'reparent-element', { id: a, parentId: null, targetId: c, placement: 'front' });
    const doc = app.store.getState().doc;
    const after = worldBounds(doc.elements, doc.elements[a]!);
    expect(doc.elements[a]!.parentId).toBeNull();
    expect(order()).toEqual([group, c, a]);
    near(after.x, before.x);
    near(after.y, before.y);
  });

  it('allows an ordinary layer to contain another layer without changing world position', () => {
    const app = createTestApp();
    const parent = run<string>(app, 'create-rect', { x: 100, y: 200, width: 500, height: 400 });
    const child = run<string>(app, 'create-line', { points: [[350, 450], [550, 450]] });
    const before = worldBounds(app.store.getState().doc.elements, app.store.getState().doc.elements[child]!);

    run(app, 'reparent-element', { id: child, parentId: parent });

    const doc = app.store.getState().doc;
    const after = worldBounds(doc.elements, doc.elements[child]!);
    expect(doc.elements[child]!.parentId).toBe(parent);
    expect(childrenOf(doc.elements, parent).map((element) => element.id)).toEqual([child]);
    near(after.x, before.x);
    near(after.y, before.y);
  });

  it('duplicates subtrees with fresh ids and an offset', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'create-rect', { x: 500, y: 0 });
    run(app, 'select-all');
    const groupId = run<string>(app, 'group-selection', {});
    const [clone] = run<string[]>(app, 'duplicate-selection', {});
    const doc = app.store.getState().doc;
    expect(clone).not.toBe(groupId);
    expect(doc.elements[clone!]).toMatchObject({ kind: 'group', x: 200, y: 200 });
    expect(childrenOf(doc.elements, clone!)).toHaveLength(2);
    expect(Object.keys(doc.elements)).toHaveLength(6);
    expect(app.store.getState().ui.selection).toEqual([clone]);
  });

  it('deletes subtrees and toggles lock and visibility', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'select-all');
    run(app, 'group-selection', {});
    run(app, 'toggle-visibility');
    expect(Object.values(app.store.getState().doc.elements).filter((e) => e.kind === 'group')[0]!.visible).toBe(false);
    run(app, 'toggle-lock');
    expect(app.executor.isAvailable('move-selection')).toBe(true);
    const moved = app.executor.dispatchSync('move-selection', { dx: 1, dy: 1 });
    expect(moved.ok).toBe(false);
    run(app, 'toggle-lock');
    run(app, 'delete-selection', {});
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
  });

  it('sets properties per kind and rejects inapplicable keys', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0 });
    const text = run<string>(app, 'create-text', { x: 0, y: 0, text: 'Hello', width: 1000, fontSize: 100 });
    run(app, 'select', { ids: [rect, text] });
    run(app, 'set-property', { key: 'name', value: 'Both' });
    run(app, 'set-property', { key: 'fill', value: '#ff0000' });
    const doc = app.store.getState().doc;
    expect(doc.elements[rect]).toMatchObject({ name: 'Both', style: { fill: '#ff0000' } });
    expect(doc.elements[text]!.name).toBe('Both');

    const bad = app.executor.dispatchSync('set-property', { ids: [text], key: 'radius', value: 5 });
    expect(bad.ok).toBe(false);
    const invalid = app.executor.dispatchSync('set-property', { ids: [rect], key: 'fill', value: 'red' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-input');
  });

  it('re-wraps text height when text or font size changes', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-text', { x: 0, y: 0, text: 'one two three four', width: 600, fontSize: 100 });
    const textEl = () => app.store.getState().doc.elements[id] as TextElement;
    const height1 = textEl().height;
    run(app, 'set-text', { id, text: 'one' });
    const height2 = textEl().height;
    expect(height2).toBeLessThan(height1);
    run(app, 'set-property', { ids: [id], key: 'fontSize', value: 200 });
    expect(textEl().height).toBeGreaterThan(height2);
  });
});

describe('clipboard', () => {
  it('copies and pastes through the platform clipboard with cascading offsets', async () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    await runAsync(app, 'copy-selection');
    expect(app.platform.clipboardText).toContain('archai/elements');
    const [first] = await runAsync<string[]>(app, 'paste');
    const [second] = await runAsync<string[]>(app, 'paste');
    const doc = app.store.getState().doc;
    expect(doc.elements[first!]).toMatchObject({ x: 200, y: 200 });
    expect(doc.elements[second!]).toMatchObject({ x: 400, y: 400 });
    expect(Object.keys(doc.elements)).toHaveLength(3);
  });

  it('cuts as one copy + delete and pastes with definitions intact', async () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    run(app, 'create-asset-definition', { name: 'Box' });
    await runAsync(app, 'cut-selection');
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
    const [pasted] = await runAsync<string[]>(app, 'paste');
    const doc = app.store.getState().doc;
    expect(doc.elements[pasted!]!.kind).toBe('instance');
    expect(Object.keys(doc.definitions)).toHaveLength(1);
  });
});

describe('assets', () => {
  it('scales asset instances uniformly around their centre', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 100, y: 200, width: 600, height: 300 });
    const { instanceId } = run<{ instanceId: string }>(app, 'create-asset-definition', { name: 'Bench' });
    run(app, 'set-uniform-asset-scale', { id: instanceId, percent: 200 });
    expect(app.store.getState().doc.elements[instanceId]).toMatchObject({ x: -200, y: 50, width: 1200, height: 600 });
  });

  it('turns a selection into a definition + instance and detaches it back', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 1000, y: 1000, width: 300, height: 200 });
    const b = run<string>(app, 'create-line', { points: [[1000, 1200], [1300, 1200]] });
    run(app, 'select', { ids: [a, b] });
    const { definitionId, instanceId } = run<{ definitionId: string; instanceId: string }>(app, 'create-asset-definition', { name: 'Table' });
    let doc = app.store.getState().doc;
    const definition = doc.definitions[definitionId]!;
    expect(definition.kind).toBe('template');
    if (definition.kind === 'template') {
      expect(Object.keys(definition.elements)).toHaveLength(2);
      expect(Object.values(definition.elements).every((e) => e.parentId === null && e.x >= 0 && e.y >= 0)).toBe(true);
    }
    expect(doc.elements[a]).toBeUndefined();
    // Bounds include half the line's 12 mm stroke, so the asset origin sits 6 mm left of the rect.
    expect(doc.elements[instanceId]).toMatchObject({ kind: 'instance', x: 994, y: 1000, definitionId });

    const placed = run<string>(app, 'create-asset-instance', { definitionId, x: 5000, y: 5000, width: 600, height: 400 });
    run(app, 'select', { ids: [placed] });
    const [groupId] = run<string[]>(app, 'detach-instance', {});
    doc = app.store.getState().doc;
    expect(doc.elements[groupId!]).toMatchObject({ kind: 'group', x: 5000, y: 5000 });
    const children = childrenOf(doc.elements, groupId!);
    expect(children).toHaveLength(2);
    const rect = children.find((c) => c.kind === 'rect') as RectElement;
    near(rect.width, 300 * (600 / definition.width)); // scaled to the instance size
  });

  it('creates built-in architecture elements as plain primitives with metadata', () => {
    const app = createTestApp();
    const wall = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 0], [3000, 2000]] });
    const door = run<string>(app, 'create-arch-element', { tool: 'door', x: 500, y: 0 });
    const door2 = run<string>(app, 'create-arch-element', { tool: 'door', x: 1500, y: 0 });
    const doc = app.store.getState().doc;
    expect(doc.elements[wall]).toMatchObject({ kind: 'line', meta: { arch: { type: 'wall', thickness: 200 } } });
    expect((doc.elements[wall] as LineElement).style.strokeWidth).toBe(200);
    expect(doc.elements[door]!.kind).toBe('instance');
    expect(Object.keys(doc.definitions)).toHaveLength(1); // both doors share the built-in definition
    expect(doc.elements[door2]).toMatchObject({ kind: 'instance', meta: { arch: { type: 'door', width: 900 } } });
    const bad = app.executor.dispatchSync('create-arch-element', { tool: 'spaceship', x: 0, y: 0 });
    expect(bad.ok).toBe(false);
  });

  it('places catalog assets as image definitions shared between instances', async () => {
    const app = createTestApp();
    const sofa = (await app.catalog.load()).folders[0]!.folders[0]!.assets[0]!;
    const first = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', { asset: sofa, x: 0, y: 0 });
    const second = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', { asset: sofa, x: 3000, y: 0, centered: true });
    const doc = app.store.getState().doc;
    expect(first.definitionId).toBe(second.definitionId);
    expect(Object.keys(doc.blobs)).toHaveLength(1);
    expect(doc.definitions[first.definitionId]).toMatchObject({ kind: 'image', origin: 'catalog', catalog: { path: 'Furnish/Seating/sofa' } });
    expect(doc.elements[second.instanceId]).toMatchObject({ x: 2000, y: -450, width: 2000, height: 900 });
    expect(app.store.getState().history.past).toHaveLength(2);
    app.executor.undo();
    expect(app.store.getState().doc.elements[second.instanceId]).toBeUndefined();
  });

  it('updates every placed instance when a linked catalog asset is packaged again', async () => {
    const app = createTestApp();
    const sofa = (await app.catalog.load()).folders[0]!.folders[0]!.assets[0]!;
    const first = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', { asset: sofa, x: 0, y: 0 });
    const second = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', { asset: sofa, x: 3000, y: 0 });
    const elementCount = Object.keys(app.store.getState().doc.elements).length;
    const updated = await runAsync<number>(app, 'update-placed-catalog-asset', { asset: sofa });
    const doc = app.store.getState().doc;
    expect(updated).toBe(2);
    expect(Object.keys(doc.elements)).toHaveLength(elementCount);
    const nextDefinition = (doc.elements[first.instanceId] as InstanceElement).definitionId;
    expect(nextDefinition).not.toBe(first.definitionId);
    expect((doc.elements[second.instanceId] as InstanceElement).definitionId).toBe(nextDefinition);
  });

  it('selects an R2 door appearance without changing the document', async () => {
    const app = createTestApp();
    const base = (await app.catalog.load()).folders[0]!.folders[0]!.assets[0]!;
    const door = { ...base, id: 'door-oak', name: 'Oak door', kind: 'system' as const, systemType: 'door' as const };
    run(app, 'select-system-asset', { systemType: 'door', asset: door });
    expect(app.store.getState().ui.systemAssets.door).toMatchObject({ id: 'door-oak', systemType: 'door' });
    expect(app.store.getState().ui.tool).toBe('arch:door');
    expect(app.store.getState().history.past).toHaveLength(0);

    const bad = app.executor.dispatchSync('select-system-asset', { systemType: 'window', asset: door });
    expect(bad.ok).toBe(false);
  });
});

describe('document commands', () => {
  it('opens a document from the platform and resets history', async () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    const saved = await runAsync<{ path: string | null }>(app, 'save-document-as');
    expect(saved.path).toBe('/fake/saved.AIR');
    expect(app.store.getState().session).toMatchObject({ dirty: false, filePath: '/fake/saved.AIR' });

    run(app, 'new-document');
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
    expect(app.store.getState().history.past).toHaveLength(0);

    app.platform.nextOpenDocument = { path: '/fake/saved.AIR', name: 'saved', text: app.platform.savedFiles[0]!.text };
    const opened = await runAsync<{ id: string }>(app, 'open-document');
    expect(opened.id).toBe('doc_1');
    expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(1);
    expect(app.store.getState().session.filePath).toBe('/fake/saved.AIR');

    run(app, 'create-rect', { x: 0, y: 0 });
    await runAsync(app, 'save-document');
    expect(app.platform.savedFiles).toHaveLength(2);
    expect(app.platform.savedFiles[1]!.path).toBe('/fake/saved.AIR');
  });

  it('rejects invalid files with a readable error', async () => {
    const app = createTestApp();
    app.platform.nextOpenDocument = { path: null, name: 'junk.json', text: '{"hello": true}' };
    const result = await app.executor.dispatch('open-document');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('junk.json');
  });
});

describe('cai package commands', () => {
  it('creating a .CAI asset opens the modeling workspace', async () => {
    const app = createTestApp();
    const opened: { assetId: string; name: string }[] = [];
    app.platform.window.openModeling = (params) => {
      opened.push(params);
    };
    // Without a name the prompt opens; with one the window opens and the prompt closes.
    await runAsync(app, 'open-modeling');
    expect(app.store.getState().ui.assetNamePrompt).toBe(true);
    expect(opened).toHaveLength(0);
    await runAsync(app, 'open-modeling', { name: 'Lounge chair' });
    expect(app.store.getState().ui.assetNamePrompt).toBe(false);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ name: 'Lounge chair' });
    expect(opened[0]!.assetId).toMatch(/^asset-/);
  });

  it('imports a .CAI package and makes it available to place', async () => {
    const { createCaiPackage } = await import('@/catalog/builder');
    const app = createTestApp();

    const pkgBytes = createCaiPackage({
      metadata: {
        caiVersion: 1,
        id: 'dining-chair-oak',
        name: 'Oak Dining Chair',
        category: 'Furnish/Seating',
        kind: 'asset',
        size: { width: 500, height: 550 },
      },
      topView: { name: 'chair.png', bytes: Uint8Array.from([1, 2, 3]) },
      modelGlb: { name: 'chair.glb', bytes: Uint8Array.from([4, 5, 6]) },
    });

    const imported = await runAsync<{ id: string; isLocal: boolean }>(app, 'import-cai-package', { bytes: pkgBytes });
    expect(imported.id).toBe('dining-chair-oak');
    expect(imported.isLocal).toBe(true);
    expect(app.store.getState().ui.panels.leftTab).toBe('assets');

    // Place the imported asset
    const placed = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', {
      asset: imported,
      x: 100,
      y: 200,
    });
    expect(placed.definitionId).toBeDefined();
    expect(placed.instanceId).toBeDefined();

    const el = app.store.getState().doc.elements[placed.instanceId]!;
    expect(el).toMatchObject({
      x: 100,
      y: 200,
      width: 500,
      height: 550,
    });
  });
});

describe('asset scaling', () => {
  it('assets only scale uniformly', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 300, height: 200 });
    run(app, 'select', { ids: [a] });
    const { instanceId } = run<{ instanceId: string }>(app, 'create-asset-definition', { name: 'Table' });
    const sizeOf = () => {
      const element = app.store.getState().doc.elements[instanceId]! as { width: number; height: number };
      return [element.width, element.height];
    };
    expect(resizeRuleFor(app.store.getState().doc.elements[instanceId])).toBe('uniform');
    run(app, 'set-transform', { id: instanceId, width: 600 });
    expect(sizeOf()).toEqual([600, 400]);
    run(app, 'set-transform', { id: instanceId, height: 200 });
    expect(sizeOf()).toEqual([300, 200]);
    const stretched = app.executor.dispatchSync('resize-selection', { ids: [instanceId], from: { x: 0, y: 0, width: 300, height: 200 }, to: { x: 0, y: 0, width: 900, height: 200 } });
    expect(stretched.ok).toBe(false);
    run(app, 'resize-selection', { ids: [instanceId], from: { x: 0, y: 0, width: 300, height: 200 }, to: { x: 0, y: 0, width: 900, height: 600 } });
    expect(sizeOf()).toEqual([900, 600]);
  });
});

describe('camera view and marker commands', () => {
  it('creates a camera view with linked marker and perspective settings', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-camera-view', {
      a: [0, 0],
      b: [1000, 500],
      eyeHeight: 1700,
      targetHeight: 1200,
      fov: 60,
    });

    const portal = app.store.getState().doc.elements[portalId]!;
    expect(portal).toBeDefined();
    const markerId = (portal.meta?.['view3d'] as { cameraId?: string })?.cameraId;
    expect(markerId).toBeDefined();
    const marker = app.store.getState().doc.elements[markerId!]!;

    expect(marker).toBeDefined();
    expect(portal.meta?.['view3d']).toMatchObject({
      cameraMode: true,
      cameraId: markerId,
    });
    expect(marker.meta?.['cameraMarker']).toMatchObject({
      portalId,
      eyeHeight: 1700,
      targetHeight: 1200,
      fov: 60,
    });
  });

  it('updates camera settings and syncs between portal and marker', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-camera-view', {
      a: [0, 0],
      b: [500, 0],
    });
    const markerId = (app.store.getState().doc.elements[portalId]!.meta?.['view3d'] as { cameraId?: string })!.cameraId!;

    run(app, 'set-camera-settings', {
      id: markerId,
      eyeHeight: 2000,
      targetHeight: 1500,
      fov: 75,
    });

    const marker = app.store.getState().doc.elements[markerId]!;
    const portal = app.store.getState().doc.elements[portalId]!;
    expect(marker.meta?.['cameraMarker']).toMatchObject({
      eyeHeight: 2000,
      targetHeight: 1500,
      fov: 75,
    });
    expect((portal.meta?.['view3d'] as { camera?: { fov?: number } }).camera?.fov).toBe(75);
  });

  it('moving or re-aiming the marker on the board moves the portal camera', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-camera-view', { a: [0, 0], b: [1000, 0], eyeHeight: 1600, targetHeight: 1200 });
    const markerId = (app.store.getState().doc.elements[portalId]!.meta?.['view3d'] as { cameraId?: string })!.cameraId!;
    const cameraOf = () => (app.store.getState().doc.elements[portalId]!.meta?.['view3d'] as { camera: { position: number[]; target: number[] } }).camera;

    run(app, 'move-selection', { ids: [markerId], dx: 500, dy: 250 });
    expect(cameraOf().position).toEqual([500, 1600, 250]);
    expect(cameraOf().target).toEqual([1500, 1200, 250]);

    // The aim point is an endpoint handle like a wall end.
    expect(hasEndpointHandles(app.store.getState().doc.elements[markerId])).toBe(true);
    run(app, 'move-line-endpoint', { id: markerId, endpoint: 'end', x: 500, y: 2000 });
    expect(cameraOf().position).toEqual([500, 1600, 250]);
    expect(cameraOf().target).toEqual([500, 1200, 2000]);
  });

  it('duplicated views share their marker, which survives until the last view goes', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-camera-view', { a: [0, 0], b: [2000, 0] });
    const markerId = (app.store.getState().doc.elements[portalId]!.meta?.['view3d'] as { cameraId: string }).cameraId;
    run(app, 'select', { ids: [portalId] });
    const [copyId] = run<string[]>(app, 'duplicate-selection', {});
    const elements = () => app.store.getState().doc.elements;
    expect((elements()[copyId!]!.meta?.['view3d'] as { cameraId: string }).cameraId).toBe(markerId);
    expect(Object.values(elements()).filter((e) => e.meta?.['cameraMarker'])).toHaveLength(1);

    // Re-aiming the marker moves both views.
    run(app, 'move-line-endpoint', { id: markerId, endpoint: 'end', x: 2000, y: 1500 });
    for (const id of [portalId, copyId!]) {
      expect((elements()[id]!.meta?.['view3d'] as { camera: { target: number[] } }).camera.target).toEqual([2000, 1600, 1500]);
    }

    // Deleting one view keeps the shared marker; deleting the last one removes it.
    run(app, 'select', { ids: [copyId!] });
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(true);
    expect(elements()[markerId]).toBeDefined();
    run(app, 'select', { ids: [portalId] });
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(true);
    expect(elements()[markerId]).toBeUndefined();

    // Sections behave the same way with their cut line.
    const sectionId = run<string>(app, 'create-section-view', { a: [0, 0], b: [3000, 0] });
    const lineId = (elements()[sectionId]!.meta?.['view3d'] as { sectionLineId: string }).sectionLineId;
    run(app, 'select', { ids: [sectionId] });
    const [sectionCopy] = run<string[]>(app, 'duplicate-selection', {});
    expect((elements()[sectionCopy!]!.meta?.['view3d'] as { sectionLineId: string }).sectionLineId).toBe(lineId);
    run(app, 'select', { ids: [sectionId] });
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(true);
    expect(elements()[lineId]).toBeDefined();
    run(app, 'select', { ids: [sectionCopy!] });
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(true);
    expect(elements()[lineId]).toBeUndefined();
  });

  it('prevents standalone deletion of section line and camera marker', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-camera-view', {
      a: [0, 0],
      b: [200, 0],
    });
    const markerId = (app.store.getState().doc.elements[portalId]!.meta?.['view3d'] as { cameraId?: string })!.cameraId!;

    run(app, 'select', { ids: [markerId] });
    const deleteMarker = app.executor.dispatchSync('delete-selection', {});
    expect(deleteMarker.ok).toBe(false);
    expect(app.store.getState().doc.elements[markerId]).toBeDefined();

    // Deleting the view portal cascades to delete the marker
    run(app, 'select', { ids: [portalId] });
    const deletePortal = app.executor.dispatchSync('delete-selection', {});
    expect(deletePortal.ok).toBe(true);
    expect(app.store.getState().doc.elements[portalId]).toBeUndefined();
    expect(app.store.getState().doc.elements[markerId]).toBeUndefined();
  });

  it('creates an AI portal and handles chat messages with AI reply', () => {
    const app = createTestApp();
    const portalId = run<string>(app, 'create-ai-portal', { x: 100, y: 200, width: 4000, height: 3000 });
    const element = app.store.getState().doc.elements[portalId];
    expect(element).toBeDefined();
    expect(element?.kind).toBe('rect');
    expect(element?.name).toBe('AI Portal');
    expect(element?.meta?.['aiPortal']).toBeDefined();

    // Send a message
    run(app, 'send-ai-portal-message', { id: portalId, text: 'Can you generate a floor plan?' });
    const updated = app.store.getState().doc.elements[portalId];
    const messages = (updated?.meta?.['aiPortal'] as { messages: Array<{ sender: string; text: string }> }).messages;
    expect(messages.length).toBe(2); // user msg + ai reply
    expect(messages[0]).toMatchObject({ sender: 'user', text: 'Can you generate a floor plan?' });
    expect(messages[1]).toMatchObject({ sender: 'ai', text: 'AI coming soon' });

    // Clear messages
    run(app, 'clear-ai-portal-messages', { id: portalId });
    const cleared = app.store.getState().doc.elements[portalId];
    const clearedMessages = (cleared?.meta?.['aiPortal'] as { messages: unknown[] }).messages;
    expect(clearedMessages).toEqual([]);

    // Document with AI portal round-trips through persistence without schema validation failure
    const serialized = serializeDocument(app.store.getState().doc);
    const parsed = parseDocument(serialized);
    expect(parsed.ok).toBe(true);
  });
});
