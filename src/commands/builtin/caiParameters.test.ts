import { describe, expect, it } from 'vitest';
import type { InstanceElement } from '@/document';
import { createCaiPackage, extractCaiPackage } from '@/catalog/builder';
import { footprintFit, instanceValues, parametricInstanceOf, recipeOf, type ParametricRecipe } from '@/catalog/parametric';
import { createTestApp, run, runAsync } from '@/test/harness';
import { pendingFits } from '@/render/useParametricAssets';

/** A 2000 × 600 panel whose width follows `panel`, and a derived `half`. */
function recipe(): ParametricRecipe {
  return {
    version: 1,
    bodies: [{ id: 'b1', name: 'Panel', visible: true, lowLod: false, material: 'm', placement: { position: [0, 0, 0], rotation: [0, 0, 0] }, features: [{ kind: 'primitive', id: 'f1', shape: 'box', size: [2000, 400, 600], placement: { position: [0, 0, 0], rotation: [0, 0, 0] } }] }],
    sketches: [],
    materials: {},
    parameters: [
      { id: 'p1', name: 'panel', type: 'length', value: 2000, min: 500, max: 6000, exposed: true },
      { id: 'p2', name: 'half', type: 'length', value: 0, expression: 'panel / 2', exposed: true },
      { id: 'p3', name: 'hidden', type: 'length', value: 5, exposed: false },
    ],
    bindings: { 'feature/b1/f1/size/0': { expression: 'panel' } },
    bounds: { min: [-1000, 0, -300], max: [1000, 400, 300] },
  };
}

async function placed() {
  const app = createTestApp();
  const sofa = (await app.catalog.load()).folders[0]!.folders[0]!.assets[0]!;
  const { instanceId, definitionId } = await runAsync<{ definitionId: string; instanceId: string }>(app, 'place-catalog-asset', { asset: { ...sofa, size: { width: 2000, height: 600 }, parametric: recipe() }, x: 0, y: 0 });
  const element = () => app.store.getState().doc.elements[instanceId] as InstanceElement;
  return { app, instanceId, definitionId, element };
}

describe('parametric .CAI packages', () => {
  it('round-trips the recipe through the package', () => {
    const bytes = createCaiPackage({
      metadata: { caiVersion: 1, id: 'panel', name: 'Panel', category: 'Facade', kind: 'asset', size: { width: 2000, height: 600 } },
      topView: { name: 'top.png', bytes: Uint8Array.from([1, 2, 3]) },
      modelGlb: { name: 'model.glb', bytes: Uint8Array.from([4, 5, 6]) },
      recipe: { name: 'recipe.json', bytes: new TextEncoder().encode(JSON.stringify(recipe())) },
    });
    const extracted = extractCaiPackage(bytes);
    expect(extracted.mapping.recipe).toBe('models/recipe.json');
    expect(extracted.recipe?.parameters.map((parameter) => parameter.name)).toEqual(['panel', 'half', 'hidden']);
  });
});

describe('placed parametric copies', () => {
  it('keep the recipe on their definition and their own values, clamped and validated', async () => {
    const { app, instanceId, definitionId, element } = await placed();
    expect(recipeOf(app.store.getState().doc.definitions[definitionId])?.bindings).toEqual(recipe().bindings);

    run(app, 'set-cai-parameters', { ids: [instanceId], values: { panel: 9000 } });
    const values = () => instanceValues(recipe(), parametricInstanceOf(element()));
    expect(values()['panel']).toBe(6000);
    expect(values()['half']).toBe(3000);
    expect(() => run(app, 'set-cai-parameters', { ids: [instanceId], values: { hidden: 1 } })).toThrow(/not an editable parameter/);
    expect(() => run(app, 'set-cai-parameters', { ids: [instanceId], values: { half: 1 } })).toThrow(/not an editable parameter/);

    run(app, 'set-cai-parameters', { ids: [instanceId], values: { panel: null } });
    expect(parametricInstanceOf(element()).values).toEqual({});
    app.executor.undo();
    expect(values()['panel']).toBe(6000);
  });

  it('fit their box to a rebuilt model at the same scale, keeping the model origin', async () => {
    const { app, instanceId, element } = await placed();
    const before = element();
    const steps = app.store.getState().history.past.length;
    expect([before.x, before.width]).toEqual([0, 2000]);
    // A model rebuilt 3000 wide grows 500 to each side of its origin.
    run(app, 'fit-parametric-footprint', { id: instanceId, footprint: { minX: -1500, maxX: 1500, minZ: -300, maxZ: 300 } });
    expect([element().x, element().width, element().height]).toEqual([-500, 3000, 600]);
    // Derived from the values: no undo step of its own.
    expect(app.store.getState().history.past).toHaveLength(steps);
    // Back to the defaults: the box follows back.
    expect(pendingFits(app.store.getState().doc)).toEqual([{ id: instanceId, footprint: { minX: -1000, maxX: 1000, minZ: -300, maxZ: 300 } }]);
  });

  it('keep the drawing scale of a resized copy', () => {
    const fit = footprintFit({ width: 1000, height: 300 }, { minX: -1000, maxX: 1000, minZ: -300, maxZ: 300 }, { minX: -1000, maxX: 2000, minZ: -300, maxZ: 300 });
    expect(fit).toEqual({ dx: 0, dy: 0, width: 1500, height: 300, scale: 0.5 });
  });

  it('are driven by parametric graphs through their parameter sockets', async () => {
    const { app, instanceId, element } = await placed();
    const pointId = run<string>(app, 'create-point', { x: 2500, y: 0 });
    const componentId = run<string>(app, 'create-parametric-folder', { ids: [instanceId, pointId] });
    const graph = app.store.getState().doc.elements[componentId]!.meta!['parametricGraph'] as { nodes: { id: string; elementId?: string }[]; links: unknown[] };
    const pointNode = graph.nodes.find((node) => node.elementId === pointId)!;
    const panelNode = graph.nodes.find((node) => node.elementId === instanceId)!;
    // The point's X drives the panel width; the point must run first.
    const executionLinks = [{ fromNode: '@start', toNode: pointNode.id }, { fromNode: pointNode.id, toNode: panelNode.id }, { fromNode: panelNode.id, toNode: (graph.nodes.find((node) => (node as { kind?: string }).kind === 'output')!).id }];
    run(app, 'set-parametric-graph', { id: componentId, graph: { ...graph, links: [{ id: 'l1', fromNode: pointNode.id, fromSocket: 'output:x', toNode: panelNode.id, toSocket: 'input:cai:panel' }], executionLinks } });
    run(app, 'run-parametric-graph', { id: componentId });
    const pointX = (app.store.getState().doc.elements[pointId] as { x: number }).x;
    expect(parametricInstanceOf(element()).values['panel']).toBe(pointX + 150);
  });
});
