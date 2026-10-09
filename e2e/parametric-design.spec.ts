import { expect, test } from '@playwright/test';

test('calculation nodes connect to instances, update on Run, and reject cycles', async ({ page }) => {
  await page.goto('/');
  const target = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    const target = (await executor.dispatch('create-rect', { x: 0, y: 0, width: 100, height: 100 })).value as string;
    const id = (await executor.dispatch('create-parametric-component', { x: 0, y: 0 })).value as string;
    const graph = store.getState().doc.elements[id]!.meta!['parametricGraph'] as { nodes: Record<string, unknown>[] };
    await executor.dispatch('set-parametric-graph', { id, graph: { ...graph, nodes: [...graph.nodes, { id: 'target', kind: 'element', elementId: target, label: 'Panel instance', x: 40, y: 40 }] } });
    return target;
  });
  const editor = page.getByTestId('parametric-editor');
  await editor.getByRole('button', { name: 'Calculation', exact: true }).click();
  const math = editor.locator('article[data-kind="math"]');
  await math.getByLabel('Calculation operation').selectOption('multiply');
  await math.getByLabel('Calculation A', { exact: true }).fill('600');
  await math.getByLabel('Calculation B', { exact: true }).fill('2');
  await math.getByLabel('Calculation B', { exact: true }).press('Tab');
  await expect(math.getByLabel('Calculation result')).toHaveText('Result: 1200');
  await math.locator('[data-node-output]').click();
  await editor.locator('[data-node-id="target"][data-socket="width"]').click();
  await editor.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]?.width, target)).toBe(1200);
  await math.getByLabel('Calculation B', { exact: true }).fill('3');
  await math.getByLabel('Calculation B', { exact: true }).press('Tab');
  await editor.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]?.width, target)).toBe(1800);
  await math.locator('[data-node-output]').click();
  await math.getByLabel('Calculation input A', { exact: true }).click();
  await expect(editor).toContainText('This connection would create a cycle');
  await editor.getByRole('button', { name: 'Arrange nodes', exact: true }).click();
  await editor.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(math).toBeInViewport();
  await expect(editor.locator('article[data-kind="output"]')).toBeInViewport();
  const before = (await math.boundingBox())!;
  await page.mouse.move(before.x + 60, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 90, before.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await math.boundingBox())!.x - before.x)).toBe(30);
  await expect.poll(async () => Math.round((await math.boundingBox())!.y - before.y)).toBe(40);
  await expect.poll(() => editor.evaluate((editor) => {
    const path = editor.querySelector('[data-testid="graph-wires"] path') as SVGPathElement;
    const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
    const socket = editor.querySelector('article[data-kind="math"] [data-node-output]')!.getBoundingClientRect();
    return Math.hypot(point.x - socket.x - socket.width / 2, point.y - socket.y - socket.height / 2);
  })).toBeLessThan(1);
  await editor.locator('[data-reference-fields]').evaluate((fields) => { fields.scrollTop = 0; });
  await expect.poll(() => editor.evaluate((editor) => {
    const path = editor.querySelector('[data-testid="graph-wires"] path') as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
    const socket = editor.querySelector('[data-node-id="target"][data-socket="width"]')!.getBoundingClientRect();
    const fields = editor.querySelector('[data-reference-fields]')!.getBoundingClientRect();
    return Math.hypot(point.x - socket.x - socket.width / 2, point.y - Math.max(fields.top, Math.min(fields.bottom, socket.y + socket.height / 2)));
  })).toBeLessThan(1);
  await editor.screenshot({ path: 'test-results/parametric-design.png' });
});
