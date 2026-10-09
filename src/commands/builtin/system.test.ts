import { describe, expect, it } from 'vitest';
import { sharedInstanceParameterDefinitions } from '@/assets/system-assets';
import { childrenOf, type GroupElement, type InstanceElement, type LineElement, type RectElement } from '@/document';
import { createTestApp, run } from '@/test/harness';

const near = (value: number, expected: number, eps = 1e-6) => expect(Math.abs(value - expected)).toBeLessThan(eps);
const arch = (element: { meta?: Record<string, unknown> } | undefined) => (element?.meta?.['arch'] ?? {}) as Record<string, unknown>;

describe('walls', () => {
  it('derive their thickness from layers and rebuild hosted windows when layers change', () => {
    const app = createTestApp();
    const [wallId] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [5000, 0]] });
    const wall = () => app.store.getState().doc.elements[wallId!] as LineElement;
    expect(wall().style.strokeWidth).toBe(200);
    expect(arch(wall())['parameters']).toMatchObject({ layers: [{ role: 'core', thickness: 200 }], locationLine: 'centre' });

    const windowId = run<string>(app, 'create-arch-element', {
      tool: 'window',
      x: 1000,
      y: -100,
      meta: { arch: { opening: { wallId, segment: 0, start: 1000, end: 2200 } } },
    });
    const window = () => app.store.getState().doc.elements[windowId] as InstanceElement;
    expect(window().height).toBe(200);
    expect(arch(window())['wallMountOffset']).toBe(100);

    run(app, 'set-system-parameters', {
      id: wallId,
      parameters: {
        layers: [
          { name: 'Render', role: 'finish', thickness: 20 },
          { name: 'Block', role: 'core', thickness: 140 },
          { name: 'Plaster', role: 'finish', thickness: 13 },
        ],
      },
    });
    expect(wall().style.strokeWidth).toBe(173);
    expect(arch(wall())['thickness']).toBe(173);
    expect(window().height).toBe(173);
    // The window stays centred on the wall line.
    near(window().y + (arch(window())['wallMountOffset'] as number), 0);
  });

  it('offset the traced line when the location line is a face', () => {
    const app = createTestApp();
    const ids = run<string[]>(app, 'create-wall-segments', {
      points: [[0, 0], [4000, 0]],
      parameters: { locationLine: 'inside', layers: [{ name: 'Core', role: 'core', thickness: 300 }] },
    });
    const wall = app.store.getState().doc.elements[ids[0]!] as LineElement;
    // Drawing left→right, "inside" is the right-hand side (+y), so the centre line sits 150 above.
    near(wall.y, -150);
    expect(wall.style.strokeWidth).toBe(300);
  });

  it('reject hand scaling and move joined endpoints together', () => {
    const app = createTestApp();
    const ids = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0], [3000, 2000]] });
    const scaled = app.executor.dispatchSync('set-transform', { id: ids[0], width: 5000 });
    expect(scaled.ok).toBe(false);
    run(app, 'move-line-endpoint', { id: ids[0], endpoint: 'end', x: 3500, y: 100 });
    const doc = app.store.getState().doc;
    const first = doc.elements[ids[0]!] as LineElement;
    const second = doc.elements[ids[1]!] as LineElement;
    near(first.x + first.points[1]![0], 3500);
    near(first.y + first.points[1]![1], 100);
    near(second.x + second.points[0]![0], 3500);
    near(second.y + second.points[0]![1], 100);
  });
});

describe('hosting', () => {
  it('moves hosted elements with their host and supports explicit hosts from Layers', () => {
    const app = createTestApp();
    const [wallId] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [5000, 0]] });
    const doorId = run<string>(app, 'create-arch-element', { tool: 'door', x: 1000, y: 0, meta: { arch: { opening: { wallId, segment: 0, start: 1000, end: 1900 } } } });
    const rectId = run<string>(app, 'create-rect', { x: 100, y: 100, width: 50, height: 50 });
    run(app, 'set-host', { id: rectId, hostId: doorId });
    run(app, 'select', { ids: [wallId] });
    run(app, 'move-selection', { ids: [wallId], dx: 100, dy: 200 });
    const doc = app.store.getState().doc;
    expect(doc.elements[doorId]).toMatchObject({ x: 1100, y: 200 });
    expect(doc.elements[rectId]).toMatchObject({ x: 200, y: 300 });
    const cycle = app.executor.dispatchSync('set-host', { id: doorId, hostId: rectId });
    expect(cycle.ok).toBe(false);
  });
});

describe('columns', () => {
  it('updates a shared instance parameter as one undoable multi-selection edit', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    const base = { shape: 'rectangle', depth: 500, height: 3000, elevation: 0, material: 'concrete' };
    run(app, 'set-system-configuration', { id: a, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters: { ...base, width: 600 } });
    run(app, 'set-system-configuration', { id: b, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters: { ...base, width: 900 } });

    run(app, 'set-system-parameter-batch', { ids: [a, b], key: 'width', value: 800 });
    expect(app.store.getState().doc.elements[a]).toMatchObject({ width: 800 });
    expect(app.store.getState().doc.elements[b]).toMatchObject({ width: 800 });
    expect(app.store.getState().history.past.at(-1)?.commandId).toBe('set-system-parameter-batch');

    expect(app.executor.undo()).toBe(true);
    expect(app.store.getState().doc.elements[a]).toMatchObject({ width: 600 });
    expect(app.store.getState().doc.elements[b]).toMatchObject({ width: 900 });
    expect(app.executor.dispatchSync('set-system-parameter-batch', { ids: [a, b], key: 'material', value: 'steel' }).ok).toBe(false);
  });

  it('intersects compatible instance parameter definitions across selected types', () => {
    const shared = sharedInstanceParameterDefinitions([
      { type: 'column', parameters: { shape: 'rectangle', width: 500, height: 3000 }, instanceEditable: ['width', 'height', 'material'] },
      { type: 'door', parameters: { width: 900, height: 2100 }, instanceEditable: ['width', 'height', 'material'] },
    ]);
    expect(shared.map((definition) => definition.key)).toEqual(['width', 'height']);
  });

  it('applies type configuration globally while preserving flagged instance overrides', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    run(app, 'set-system-configuration', { id: a, assetId: null, instanceEditable: ['width'], parameters: { shape: 'rectangle', width: 700, depth: 600, height: 3000, elevation: 0, material: 'concrete' } });
    run(app, 'set-system-parameter', { id: b, key: 'width', value: 950 });
    run(app, 'set-system-configuration', { id: a, assetId: null, instanceEditable: ['width'], parameters: { shape: 'rectangle', width: 800, depth: 650, height: 3200, elevation: 0, material: 'steel' } });

    const doc = app.store.getState().doc;
    expect(doc.elements[a]).toMatchObject({ width: 500, height: 650 });
    expect(doc.elements[b]).toMatchObject({ width: 950, height: 650 });
    expect(arch(doc.elements[b])['instanceOverrides']).toMatchObject({ width: 950 });
  });

  it('can apply a configuration preset to only one instance', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });

    run(app, 'set-system-configuration', {
      id: a,
      assetId: 'preset-wide-column',
      assetName: 'Wide column',
      applyTo: 'instance',
      parameters: { shape: 'rectangle', width: 900, depth: 700, height: 3000, elevation: 0, material: 'concrete' },
    });

    const doc = app.store.getState().doc;
    expect(doc.elements[a]).toMatchObject({ width: 900, height: 700 });
    expect(arch(doc.elements[a])['systemAssetName']).toBe('Wide column');
    expect(doc.elements[b]).toMatchObject({ width: 500, height: 500 });
    expect(arch(doc.elements[b])['systemAssetName']).toBeUndefined();
  });

  it('applies type edits only to instances using the same preset and remembers editable preset values', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    const other = run<string>(app, 'create-arch-element', { tool: 'column', x: 4000, y: 0 });
    const preset = { shape: 'rectangle', width: 700, depth: 600, height: 3000, elevation: 0, material: 'concrete' };
    for (const id of [a, b]) {
      run(app, 'set-system-configuration', { id, assetId: 'preset-a', assetName: 'Preset A', applyTo: 'instance', instanceEditable: ['width'], parameters: preset });
    }
    run(app, 'set-system-configuration', { id: other, assetId: 'preset-b', assetName: 'Preset B', applyTo: 'instance', instanceEditable: ['width'], parameters: { ...preset, width: 1100 } });
    run(app, 'set-system-parameter', { id: b, key: 'width', value: 950 });

    run(app, 'set-system-configuration', { id: a, assetId: 'preset-a', assetName: 'Preset A', instanceEditable: ['width'], parameters: { ...preset, width: 800, depth: 650 } });

    const doc = app.store.getState().doc;
    expect(doc.elements[a]).toMatchObject({ width: 700, height: 650 });
    expect(doc.elements[b]).toMatchObject({ width: 950, height: 650 });
    expect(doc.elements[other]).toMatchObject({ width: 1100, height: 600 });

    run(app, 'set-system-configuration', { id: b, assetId: 'preset-b', assetName: 'Preset B', applyTo: 'instance', instanceEditable: ['width'], parameters: { ...preset, width: 1100 } });
    expect(app.store.getState().doc.elements[b]).toMatchObject({ width: 1100, height: 600 });
    expect(arch(app.store.getState().doc.elements[b])['instanceOverrides']).toEqual({ elevation: 0 });
  });

  it('are rects centred on the click whose parameters follow hand resizes', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-arch-element', { tool: 'column', x: 1000, y: 1000 });
    const column = () => app.store.getState().doc.elements[id] as RectElement;
    expect(column()).toMatchObject({ kind: 'rect', x: 750, y: 750, width: 500, height: 500, radius: 0 });
    // Type-owned sizes cannot be changed by hand on the board.
    expect(app.executor.dispatchSync('set-transform', { id, width: 300, height: 600 }).ok).toBe(false);
    expect(app.executor.dispatchSync('resize-selection', { ids: [id], from: { x: 750, y: 750, width: 500, height: 500 }, to: { x: 750, y: 750, width: 600, height: 500 } }).ok).toBe(false);
    run(app, 'set-system-configuration', { id, assetId: null, applyTo: 'instance', instanceEditable: ['width', 'depth'], parameters: arch(column())['parameters'] });
    run(app, 'set-transform', { id, width: 300, height: 600 });
    expect(arch(column())['parameters']).toMatchObject({ shape: 'rectangle', width: 300, depth: 600 });
    run(app, 'set-system-parameter', { id, key: 'shape', value: 'circle' });
    expect(column().radius).toBe(column().width / 2);
    expect(column().width).toBe(column().height);
    run(app, 'set-system-parameter', { id, key: 'material', value: 'timber' });
    expect(column().style.fill).toBe('#e8d9c2');
  });
});

describe('unified system parameters', () => {
  it('keeps elevation instance-only and changes wall geometry with its path type', () => {
    const app = createTestApp();
    const column = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    run(app, 'set-system-configuration', { id: column, assetId: null, instanceEditable: [], parameters: { shape: 'rectangle', width: 500, depth: 500, height: 3000, elevation: 0, material: 'concrete' } });
    const columnArch = app.store.getState().doc.elements[column]!.meta?.['arch'] as Record<string, unknown>;
    expect(columnArch['instanceEditable']).toContain('elevation');

    const [wall] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]] });
    run(app, 'set-system-parameter', { id: wall, key: 'pathType', value: 'bezier' });
    const curved = app.store.getState().doc.elements[wall!]!;
    expect(curved.kind === 'line' && curved.path?.segments[0]).toMatchObject({ kind: 'bezier' });
    run(app, 'set-system-parameter', { id: wall, key: 'pathType', value: 'straight' });
    expect(app.store.getState().doc.elements[wall!]!).not.toHaveProperty('path');
  });
});

describe('facade elements', () => {
  it('rebuild their plan depth and remain seated on their wall face', () => {
    const app = createTestApp();
    const [wallId] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [5000, 0]] });
    const id = run<string>(app, 'create-arch-element', {
      tool: 'facade-element',
      x: 1000,
      y: 100,
      meta: { arch: { wallMountOffset: -100, opening: { wallId, segment: 0, start: 1000, end: 2200 } } },
    });
    const facade = () => app.store.getState().doc.elements[id] as InstanceElement;
    expect(facade()).toMatchObject({ width: 1200, height: 200 });
    run(app, 'set-system-parameter', { id, key: 'depth', value: 2000 });
    expect(facade()).toMatchObject({ width: 1200, height: 2000 });
    expect(arch(facade())['wallMountOffset']).toBe(-100);
    run(app, 'set-system-parameter', { id, key: 'width', value: 1800 });
    expect(facade().width).toBe(1800);
    expect(arch(facade())['opening']).toMatchObject({ start: 700, end: 2500 });
    run(app, 'flip-facade-side', { id });
    expect(arch(facade())['wallMountOffset']).toBe(2100);
    const array = run<string[]>(app, 'array-facade-along-wall', { id });
    expect(array).toHaveLength(2);
    expect(array.every((facadeId) => (arch(app.store.getState().doc.elements[facadeId])['opening'] as { wallId?: string }).wallId === wallId)).toBe(true);
    expect(app.store.getState().doc.elements[array[1]!]!.meta?.['facadeArraySource']).toBe(id);
  });
});

describe('doors', () => {
  it('share a definition per parameter set and rebuild when handing or width change', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'door', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'door', x: 2000, y: 0 });
    const doc = () => app.store.getState().doc;
    expect((doc().elements[a] as InstanceElement).definitionId).toBe((doc().elements[b] as InstanceElement).definitionId);
    run(app, 'set-system-parameter', { id: b, key: 'handing', value: 'right' });
    expect((doc().elements[a] as InstanceElement).definitionId).not.toBe((doc().elements[b] as InstanceElement).definitionId);
    run(app, 'set-system-parameter', { id: b, key: 'width', value: 1000 });
    expect(doc().elements[b]).toMatchObject({ width: 1000, height: 1000, meta: { arch: { width: 1000 } } });
    run(app, 'set-system-parameter', { id: b, key: 'openingSide', value: 'outside' });
    expect(arch(doc().elements[b])['wallMountOffset']).toBe(1000);
    // The wall line (mount point) stays where it was: y = 0.
    near((doc().elements[b] as InstanceElement).y + 1000, 0);
    const scaled = app.executor.dispatchSync('resize-selection', { ids: [b], from: { x: 0, y: 0, width: 1000, height: 1000 }, to: { x: 0, y: 0, width: 2000, height: 1000 } });
    expect(scaled.ok).toBe(false);
  });
});

describe('windows', () => {
  it('only resize along the wall and keep the chosen jamb', () => {
    const app = createTestApp();
    const [wallId] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [5000, 0]] });
    const id = run<string>(app, 'create-arch-element', {
      tool: 'window',
      x: 1000,
      y: -100,
      meta: { arch: { opening: { wallId, segment: 0, start: 1000, end: 2200 } } },
    });
    const window = () => app.store.getState().doc.elements[id] as InstanceElement;
    expect(app.executor.dispatchSync('resize-window', { id, width: 1500, anchor: 'start' }).ok).toBe(false);
    run(app, 'set-system-configuration', { id, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters: arch(window())['parameters'] });
    run(app, 'resize-window', { id, width: 1500, anchor: 'start' });
    expect(window().width).toBe(1500);
    expect(window().height).toBe(200);
    near(window().x, 1000);
    expect(arch(window())['opening']).toMatchObject({ start: 1000, end: 2500 });
    run(app, 'set-transform', { id, width: 900 });
    expect(window().width).toBe(900);
    expect(arch(window())['opening']).toMatchObject({ start: 1300, end: 2200 });
    const perpendicular = app.executor.dispatchSync('set-transform', { id, height: 400 });
    expect(perpendicular.ok).toBe(false);
  });
});

describe('stairs', () => {
  it('build runs and landings from parameters and rebuild on change', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-stair', {
      flights: [
        { kind: 'run', x: 0, y: 0, angle: 0, treads: 8 },
        { kind: 'landing', x: 2240, y: 0, angle: 0 },
        { kind: 'run', x: 3240, y: 0, angle: 90, treads: 10 },
      ],
      parameters: { totalRise: 3000, riserHeight: 170 },
    });
    const doc = () => app.store.getState().doc;
    const group = doc().elements[id] as GroupElement;
    expect(group.kind).toBe('group');
    expect(arch(group)['parameters']).toMatchObject({ totalRise: 3000, riserHeight: 170, treadDepth: 280 });
    const childrenBefore = childrenOf(doc().elements, id);
    expect(childrenBefore.filter((child) => child.kind === 'rect')).toHaveLength(3);
    expect(childrenBefore.some((child) => child.kind === 'text')).toBe(true);
    run(app, 'set-system-parameter', { id, key: 'width', value: 1500 });
    const childrenAfter = childrenOf(doc().elements, id);
    expect(childrenAfter.filter((child) => child.kind === 'rect').every((child) => (child as RectElement).height === 1500)).toBe(true);
    const reflown = arch(doc().elements[id])['flights'] as Array<Record<string, unknown>>;
    expect(reflown[1]).toMatchObject({ kind: 'landing', x: 2240, y: 0, width: 1500, depth: 1500 });
    expect(reflown[2]).toMatchObject({ kind: 'run', x: 2990, y: 750, angle: 90 });
    expect(childrenBefore[0]!.id).not.toBe(childrenAfter[0]!.id);
    const scaled = app.executor.dispatchSync('set-transform', { id, width: 4000 });
    expect(scaled.ok).toBe(false);
  });

  it('places a straight default stair from the tool', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-arch-element', { tool: 'stairs', x: 100, y: 200 });
    const group = app.store.getState().doc.elements[id] as GroupElement;
    expect(group).toMatchObject({ kind: 'group', x: 100, y: 200 });
    expect(arch(group)['flights']).toEqual([{ kind: 'run', x: 0, y: 0, angle: 90, treads: 18 }]);
    const railing = childrenOf(app.store.getState().doc.elements, id).find((child) => arch(child)['type'] === 'railing') as LineElement;
    expect(railing).toBeDefined();
    expect(railing.name).toBe('Right stair railing');
    expect(railing.points).toHaveLength(2);
    expect(railing.points[0]![0]).toBeCloseTo(-500);
    run(app, 'set-system-parameter', { id, key: 'width', value: 1400 });
    const updated = app.store.getState().doc.elements[railing.id] as LineElement;
    expect(updated.points[0]![0]).toBeCloseTo(-700);
    const left = run<string>(app, 'add-stair-railing', { stairId: id, side: 'left' });
    expect((app.store.getState().doc.elements[left] as LineElement).points[0]![0]).toBeCloseTo(700);
    run(app, 'set-stair-railing-side', { id: left, side: 'right' });
    expect((app.store.getState().doc.elements[left] as LineElement).points[0]![0]).toBeCloseTo(-700);
    expect(childrenOf(app.store.getState().doc.elements, id).filter((child) => arch(child)['type'] === 'railing')).toHaveLength(2);
  });

  it('makes a regular railing follow a stair when nested under it in Layers', () => {
    const app = createTestApp();
    const stair = run<string>(app, 'create-stair', { flights: [{ kind: 'run', x: 0, y: 0, angle: 0, treads: 5 }] });
    const railing = run<string>(app, 'create-arch-element', { tool: 'railing', points: [[4000, 4000], [5000, 4000]] });
    run(app, 'reparent-element', { id: railing, parentId: stair });
    const nested = app.store.getState().doc.elements[railing] as LineElement;
    expect(nested.parentId).toBe(stair);
    expect(nested.points).toEqual([[0, 500], [1400, 500]]);
    run(app, 'set-system-parameter', { id: stair, key: 'treadDepth', value: 320 });
    expect((app.store.getState().doc.elements[railing] as LineElement).points).toEqual([[0, 500], [1600, 500]]);
  });
});

describe('railings', () => {
  it('take their stroke from the thickness parameter', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-arch-element', { tool: 'railing', points: [[0, 0], [2000, 0]], meta: { arch: { parameters: { thickness: 60, pattern: 'glass-panel' } } } });
    const railing = () => app.store.getState().doc.elements[id] as LineElement;
    expect(railing().style.strokeWidth).toBe(60);
    run(app, 'set-system-parameter', { id, key: 'thickness', value: 120 });
    expect(railing().style.strokeWidth).toBe(120);
    expect(arch(railing())['parameters']).toMatchObject({ pattern: 'glass-panel', balusterSpacing: 120 });
  });
});

describe('system types', () => {
  it('seed placements with the chosen type parameters', () => {
    const app = createTestApp();
    run(app, 'select-system-asset', {
      systemType: 'wall',
      asset: {
        id: 'wall-brick',
        path: 'system/wall/wall-brick',
        name: 'Brick cavity',
        kind: 'system',
        systemType: 'wall',
        systemParameters: { layers: [{ name: 'Brick', role: 'core', thickness: 102 }, { name: 'Cavity', role: 'core', thickness: 50 }, { name: 'Block', role: 'core', thickness: 100 }] },
        image: { url: 'blob:section' },
        size: { width: 0, height: 0 },
      },
    });
    expect(app.store.getState().ui.tool).toBe('arch:wall');
    const [id] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [1000, 0]] });
    const wall = app.store.getState().doc.elements[id!] as LineElement;
    expect(wall.style.strokeWidth).toBe(252);
    expect(arch(wall)).toMatchObject({ systemAssetId: 'wall-brick', systemAssetName: 'Brick cavity' });
  });
});
