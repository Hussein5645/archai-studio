import { expect, test } from '@playwright/test';

test('nested wall updates its own height while dragging with the graph closed, then stops', async ({ page }) => {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    await executor.dispatch('set-viewport', { x: 250, y: 100, zoom: 0.2 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
    if (!store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    const id = (await executor.dispatch('create-parametric-component', { x: 0, y: 0 })).value as string;
    await executor.dispatch('close-parametric-editor');
    const wall = ((await executor.dispatch('create-wall-segments', { points: [[1000, 1000], [3000, 1000]] })).value as string[])[0]!;
    await executor.dispatch('set-system-configuration', { id: wall, assetId: null, parameters: {}, instanceEditable: ['height'] });
    await executor.dispatch('reparent-element', { id: wall, parentId: id });
    const graph = store.getState().doc.elements[id]!.meta!['parametricGraph'] as { nodes: { id: string; elementId?: string }[] };
    const node = graph.nodes.find((node) => node.elementId === wall)!;
    await executor.dispatch('set-parametric-graph', { id, graph: { ...graph, links: [{ id: 'height', fromNode: node.id, fromSocket: 'output:y', toNode: node.id, toSocket: 'input:parameter:height' }] } });
    await executor.dispatch('select', { ids: [id] });
    return { id, wall };
  });
  const inspector = page.getByTestId('inspector');
  await expect(page.getByTestId('parametric-editor')).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Start graph', exact: true }).click();
  await expect(inspector.getByTestId('graph-run-controls')).toContainText('Running');
  // What the board shows: mid-drag that is the gesture's preview, committed on release.
  const height = () => page.evaluate((id) => {
    const state = window.__archai!.store.getState();
    const arch = (state.preview ?? state.doc).elements[id]!.meta!['arch'] as { parameters: { height: number } };
    return arch.parameters.height;
  }, ids.wall);
  await expect.poll(height).toBe(1000);
  const board = (await page.getByTestId('workboard').boundingBox())!;
  await page.mouse.move(board.x + 650, board.y + 300);
  await page.mouse.down();
  await page.mouse.move(board.x + 650, board.y + 380, { steps: 8 });
  await expect.poll(height).toBe(1400);
  await page.mouse.up();
  await expect.poll(height).toBe(1400);
  await expect(page.locator(`[data-graph-origin="${ids.id}"]`)).toContainText('Running');
  await expect(page.locator(`[data-graph-origin="${ids.id}"] [data-element-id="${ids.wall}"]`)).toHaveAttribute('data-selected', 'true');
  await page.getByTestId(`layer-${ids.id}`).getByRole('button', { name: 'Stop graph', exact: true }).click();
  await page.evaluate(async (id) => { await window.__archai!.executor.dispatch('set-transform', { id, y: 1800 }); }, ids.wall);
  await expect.poll(height).toBe(1400);
  await expect(page.locator(`[data-graph-origin="${ids.id}"]`)).toContainText('Stopped');
  await page.getByTestId(`layer-${ids.id}`).getByRole('button', { name: 'Start graph', exact: true }).click();
  await expect.poll(height).toBe(1800);
  await page.evaluate(async (id) => { await window.__archai!.executor.dispatch('open-parametric-editor', { id }); }, ids.id);
  await expect(page.getByTestId('parametric-editor').getByTestId('graph-run-controls')).toContainText('Running');
  await expect(page.locator('article[data-kind="element"]')).toHaveCount(1);
  await expect(page.locator(`article[data-element-id="${ids.wall}"]`)).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('parametric-editor').getByRole('button', { name: 'Stop graph', exact: true }).click();
  await expect(page.getByTestId('parametric-editor').getByTestId('graph-run-controls')).toContainText('Stopped');
  await page.getByTestId('parametric-editor').screenshot({ path: 'test-results/live-graph.png' });
});
