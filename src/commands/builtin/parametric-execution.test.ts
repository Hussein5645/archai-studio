import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { worldMatrix } from '@/geometry';
import { executionSteps, GRAPH_START, parametricGraphOf } from './parametric';

function fixture() {
  const app = createTestApp();
  const a = run<string>(app, 'create-rect', { x: 250, y: 350, width: 500, height: 300, name: 'Source' });
  const b = run<string>(app, 'create-rect', { x: 1250, y: 350, width: 100, height: 300, name: 'Target' });
  const id = run<string>(app, 'create-parametric-folder', { ids: [a, b] });
  const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
  const source = graph.nodes.find((node) => node.elementId === a)!;
  const target = graph.nodes.find((node) => node.elementId === b)!;
  const finish = graph.nodes.find((node) => node.kind === 'output')!;
  source.inputValues = { width: 600 };
  graph.executionOrder = [target.id, source.id];
  graph.executionLinks = [{ fromNode: GRAPH_START, toNode: source.id }, { fromNode: source.id, toNode: target.id }, { fromNode: target.id, toNode: finish.id }];
  graph.links = [{ id: 'data', fromNode: source.id, fromSocket: 'output:width', toNode: target.id, toSocket: 'input:width' }];
  return { app, a, b, id, graph, source, target, finish };
}

describe('graph execution pins and component folders', () => {
  it('creates a folder without moving board geometry and registers its instances', async () => {
    const { app, a, b, id, graph } = fixture();
    for (const [elementId, x] of [[a, 250], [b, 1250]] as const) {
      const element = app.store.getState().doc.elements[elementId]!;
      expect(element.parentId).toBe(id);
      expect(worldMatrix(app.store.getState().doc.elements, element).slice(4)).toEqual([x, 350]);
    }
    expect(graph.nodes.filter((node) => node.elementId)).toHaveLength(2);
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[id]).toBeUndefined();
    expect(app.store.getState().doc.elements[a]).toMatchObject({ parentId: null, x: 250, y: 350 });
  });

  it('runs in pin order instead of legacy list order', () => {
    const { app, id, graph, source, target, b } = fixture();
    expect(executionSteps(graph)).toEqual([source.id, target.id]);
    run(app, 'set-parametric-graph', { id, graph });
    run(app, 'run-parametric-graph', { id });
    expect(app.store.getState().doc.elements[b]).toMatchObject({ width: 600 });
  });

  it.each(['break', 'cycle', 'skip', 'branch'] as const)('rejects %s without partial updates', (problem) => {
    const { app, id, graph, source, target, finish, a, b } = fixture();
    if (problem === 'break') graph.executionLinks = [];
    if (problem === 'cycle') graph.executionLinks![2] = { fromNode: target.id, toNode: source.id };
    if (problem === 'skip') graph.executionLinks = [{ fromNode: GRAPH_START, toNode: finish.id }];
    if (problem === 'branch') graph.executionLinks!.push({ fromNode: source.id, toNode: finish.id });
    run(app, 'set-parametric-graph', { id, graph });
    expect(app.executor.dispatchSync('run-parametric-graph', { id }).ok).toBe(false);
    expect(app.store.getState().doc.elements[a]).toMatchObject({ width: 500 });
    expect(app.store.getState().doc.elements[b]).toMatchObject({ width: 100 });
  });
});
