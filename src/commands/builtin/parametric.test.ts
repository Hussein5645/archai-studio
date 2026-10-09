import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { parametricGraphOf } from './parametric';

describe('parametric components', () => {
  it('places a persistent graph on the board and opens its editor', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-parametric-component', { x: 1200, y: 800, name: 'Facade rig' });
    const state = app.store.getState();
    const component = state.doc.elements[id]!;
    const graph = parametricGraphOf(component.meta?.['parametricGraph']);

    expect(component).toMatchObject({ kind: 'group', x: 1200, y: 800, name: 'Facade rig' });
    expect(graph?.nodes).toEqual([expect.objectContaining({ kind: 'output', label: 'Geometry output' })]);
    expect(state.ui.parametricEditor).toEqual({ open: true, elementId: id });
    expect(state.ui.selection).toEqual([id]);
  });

  it('protects the graph origin from board deletion while its editor is open', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-parametric-component', { x: 1200, y: 800 });

    expect(app.store.getState().ui.selection).toEqual([id]);
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(false);
    expect(app.store.getState().doc.elements[id]).toBeDefined();

    expect(app.executor.dispatchSync('close-parametric-editor').ok).toBe(true);
    expect(app.executor.dispatchSync('delete-selection', {}).ok).toBe(true);
    expect(app.store.getState().doc.elements[id]).toBeUndefined();
  });

  it('stores variables and stable board-element/CAI-ready references', () => {
    const app = createTestApp();
    const sourceId = run<string>(app, 'create-rect', { x: 0, y: 0, width: 500, height: 300, name: 'Driving panel' });
    const id = run<string>(app, 'create-parametric-component', { x: 1000, y: 1000 });
    const initial = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', {
      id,
      graph: {
        ...initial,
        variables: [{ id: 'width', name: 'Width', type: 'length', value: 1200, instanceEditable: true }],
        nodes: [...initial.nodes, { id: 'variable', kind: 'variable', x: 20, y: 100, label: 'Width', variableId: 'width' }, { id: 'source', kind: 'element', x: 300, y: 100, label: 'Driving panel', elementId: sourceId }],
        links: [{ id: 'link', fromNode: 'variable', fromSocket: 'value', toNode: 'source', toSocket: 'input:x' }],
      },
    });

    const saved = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    expect(saved.variables[0]).toMatchObject({ name: 'Width', value: 1200, instanceEditable: true });
    expect(saved.nodes.find((node) => node.id === 'source')?.elementId).toBe(sourceId);
    expect(saved.links).toHaveLength(1);
    run(app, 'run-parametric-graph', { id });
    expect(app.store.getState().doc.elements[sourceId]!.x).toBe(1200);
  });

  it('preserves referenced system presets and enforces exposed typed inputs', () => {
    const app = createTestApp();
    const columnId = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    run(app, 'set-system-configuration', {
      id: columnId,
      assetId: null,
      applyTo: 'instance',
      instanceEditable: ['material'],
      parameters: { shape: 'rectangle', width: 500, depth: 500, height: 3000, elevation: 0, material: 'concrete' },
    });
    const componentId = run<string>(app, 'create-parametric-component', { x: 1000, y: 1000 });
    run(app, 'mark-parametric-reference', { componentId, elementId: columnId });
    const initial = parametricGraphOf(app.store.getState().doc.elements[componentId]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', {
      id: componentId,
      graph: {
        ...initial,
        variables: [{ id: 'material', name: 'Material', type: 'dropdown', value: 'steel', instanceEditable: true }],
        nodes: [...initial.nodes, { id: 'variable', kind: 'variable', x: 20, y: 100, label: 'Material', variableId: 'material' }, { id: 'column', kind: 'element', x: 300, y: 100, label: 'Column', elementId: columnId }],
        links: [{ id: 'link', fromNode: 'variable', fromSocket: 'value', toNode: 'column', toSocket: 'input:parameter:material' }],
      },
    });

    run(app, 'run-parametric-graph', { id: componentId });
    const arch = app.store.getState().doc.elements[columnId]!.meta?.['arch'] as Record<string, unknown>;
    expect(arch['systemAssetName']).not.toBe('Graph');
    expect(arch['graphPreset']).toBeUndefined();
    expect(arch['parameters']).toMatchObject({ material: 'steel' });

    const graph = parametricGraphOf(app.store.getState().doc.elements[componentId]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', { id: componentId, graph: { ...graph, variables: [{ ...graph.variables[0]!, type: 'boolean', value: true }] } });
    expect(app.executor.dispatchSync('run-parametric-graph', { id: componentId }).ok).toBe(false);
  });

  it('reads live instance parameters and propagates later changes through element outputs', () => {
    const app = createTestApp();
    const sourceId = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const targetId = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    const parameters = { shape: 'rectangle', width: 500, depth: 500, height: 3000, elevation: 0, material: 'concrete' };
    for (const id of [sourceId, targetId]) {
      run(app, 'set-system-configuration', { id, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters });
    }
    const componentId = run<string>(app, 'create-parametric-component', { x: 1000, y: 1000 });
    const initial = parametricGraphOf(app.store.getState().doc.elements[componentId]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', {
      id: componentId,
      graph: {
        ...initial,
        nodes: [
          ...initial.nodes,
          { id: 'source', kind: 'element', x: 100, y: 100, label: 'Source', elementId: sourceId },
          { id: 'target', kind: 'element', x: 400, y: 100, label: 'Target', elementId: targetId },
        ],
        executionOrder: ['source', 'target'],
        links: [{ id: 'width-link', fromNode: 'source', fromSocket: 'output:parameter:width', toNode: 'target', toSocket: 'input:parameter:width' }],
      },
    });

    run(app, 'set-system-parameter', { id: sourceId, key: 'width', value: 720 });
    run(app, 'run-parametric-graph', { id: componentId });
    expect(app.store.getState().doc.elements[targetId]).toMatchObject({ width: 720 });

    run(app, 'set-system-parameter', { id: sourceId, key: 'width', value: 960 });
    run(app, 'run-parametric-graph', { id: componentId });
    expect(app.store.getState().doc.elements[targetId]).toMatchObject({ width: 960 });
  });

  it('runs element outputs in explicit order regardless of layout and can create an offset copy result', () => {
    const app = createTestApp();
    const sourceId = run<string>(app, 'create-rect', { x: 100, y: 100, width: 700, height: 300, name: 'Source' });
    const targetId = run<string>(app, 'create-rect', { x: 1200, y: 100, width: 400, height: 300, name: 'Target' });
    const componentId = run<string>(app, 'create-parametric-component', { x: 0, y: 0 });
    const initial = parametricGraphOf(app.store.getState().doc.elements[componentId]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', {
      id: componentId,
      graph: {
        ...initial,
        executionMode: 'copy',
        executionOrder: ['source', 'target'],
        copyOffset: { x: 2000, y: 500 },
        nodes: [...initial.nodes, { id: 'source', kind: 'element', x: 700, y: 100, label: 'Source', elementId: sourceId, inputValues: { width: 900 } }, { id: 'target', kind: 'element', x: 100, y: 100, label: 'Target', elementId: targetId }],
        links: [{ id: 'width-link', fromNode: 'source', fromSocket: 'output:width', toNode: 'target', toSocket: 'input:width' }],
      },
    });

    run(app, 'run-parametric-graph', { id: componentId });
    const selected = app.store.getState().ui.selection.map((id) => app.store.getState().doc.elements[id]!);
    expect(app.store.getState().doc.elements[targetId]).toMatchObject({ x: 1200, width: 400 });
    expect(app.store.getState().doc.elements[sourceId]).toMatchObject({ width: 700 });
    expect(selected).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Source', x: 2100, width: 900 }), expect.objectContaining({ name: 'Target', x: 3200, width: 900 })]));
  });

  it('rejects backward data dependencies atomically', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 500, height: 300 });
    const b = run<string>(app, 'create-rect', { x: 1000, y: 0, width: 200, height: 300 });
    const id = run<string>(app, 'create-parametric-component', { x: 0, y: 0 });
    const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', { id, graph: { ...graph, executionMode: 'copy', executionOrder: ['b', 'a'], nodes: [...graph.nodes, { id: 'a', kind: 'element', elementId: a, label: 'A', x: 0, y: 0 }, { id: 'b', kind: 'element', elementId: b, label: 'B', x: 100, y: 0 }], links: [{ id: 'link', fromNode: 'a', fromSocket: 'output:width', toNode: 'b', toSocket: 'input:width' }] } });
    const before = app.store.getState().doc;
    expect(app.executor.dispatchSync('run-parametric-graph', { id }).ok).toBe(false);
    expect(app.store.getState().doc).toEqual(before);
  });

  it('evaluates nested copy inputs before applying the board offset', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-parametric-component', { x: 1000, y: 2000 });
    const source = run<string>(app, 'create-rect', { x: 50, y: 70, width: 200, height: 100, parentId: id });
    const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    run(app, 'set-parametric-graph', { id, graph: { ...graph, executionMode: 'copy', copyOffset: { x: 300, y: 400 }, nodes: [...graph.nodes, { id: 'source', kind: 'element', elementId: source, label: 'Source', x: 100, y: 0, inputValues: { x: 80, width: 450 } }] } });
    run(app, 'run-parametric-graph', { id });
    const state = app.store.getState();
    expect(state.doc.elements[source]).toMatchObject({ x: 50, width: 200, parentId: id });
    expect(state.doc.elements[state.ui.selection[0]!]).toMatchObject({ x: 1380, y: 2470, width: 450, parentId: null });
  });
});
