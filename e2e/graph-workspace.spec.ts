import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('new-document'); });
});

test('origin opens a full-screen graph and returns to the same board', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('create-parametric-component', { x: 0, y: 0 });
    await executor.dispatch('close-parametric-editor');
    await executor.dispatch('set-viewport', { x: 400, y: 300, zoom: 0.2 });
  });
  const board = page.getByTestId('workboard');
  await expect(board.locator('[data-graph-origin]')).toContainText('Double-click to open');
  await board.dblclick({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId('parametric-editor');
  await expect(editor).toBeVisible();
  expect(await editor.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
  await editor.getByRole('button', { name: 'Back to board' }).click();
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.viewport)).toEqual({ x: 400, y: 300, zoom: 0.2 });
});

test('right-click adds at the pointer and navigation pans and zooms like the board', async ({ page }) => {
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('set-viewport', { x: 640, y: 320, zoom: 0.5 });
    await window.__archai!.executor.dispatch('create-parametric-component', { x: 0, y: 0 });
  });
  const canvas = page.getByTestId('graph-canvas');
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ button: 'right', position: { x: 450, y: 300 } });
  await page.getByRole('menu', { name: 'Add graph node' }).getByRole('menuitem', { name: 'Variable', exact: true }).click();
  const node = page.locator('article[data-kind="variable"]');
  const initial = (await node.boundingBox())!;
  expect(initial.x).toBeCloseTo(bounds.x + 450, 0);
  expect(initial.y).toBeCloseTo(bounds.y + 300, 0);
  await page.mouse.move(bounds.x + 800, bounds.y + 500);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bounds.x + 850, bounds.y + 520, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => Math.round((await node.boundingBox())!.x - initial.x)).toBe(50);
  const before = (await node.boundingBox())!;
  await page.mouse.move(before.x + 50, before.y + 12);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(before.x + 80, before.y + 32, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(async () => Math.round((await node.boundingBox())!.x - before.x)).toBe(30);
  const at = (await node.boundingBox())!;
  const anchor = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -160);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await node.boundingBox())!.width).toBeGreaterThan(at.width * 1.4);
  const zoomed = (await node.boundingBox())!;
  expect(zoomed.x + zoomed.width / 2).toBeCloseTo(anchor.x, 0);
  expect(zoomed.y + zoomed.height / 2).toBeCloseTo(anchor.y, 0);
  const position = await page.evaluate(() => {
    const state = window.__archai!.store.getState();
    const graph = state.doc.elements[state.ui.parametricEditor.elementId!]!.meta!['parametricGraph'] as { nodes: { kind: string; x: number; y: number }[] };
    return graph.nodes.find((node) => node.kind === 'variable');
  });
  expect(position).toMatchObject({ x: 450, y: 300 });
  await node.locator('header').click();
  const beforeNudge = (await node.boundingBox())!;
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await node.boundingBox())!.x - beforeNudge.x).toBeGreaterThan(10);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.round((await node.boundingBox())!.x - beforeNudge.x)).toBe(0);
  await canvas.click({ button: 'right', position: { x: 200, y: 400 } });
  await page.getByLabel('Search graph nodes').fill('calc');
  await page.getByRole('menuitem', { name: 'Calculation', exact: true }).click();
  await expect(page.locator('article[data-kind="math"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to board' }).click();
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.tool)).toBe('select');
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.viewport)).toEqual({ x: 640, y: 320, zoom: 0.5 });
  await expect(page.locator('[data-graph-origin]')).toContainText('Calculation');
  await page.getByTestId('workboard').screenshot({ path: 'test-results/graph-origin-board.png' });
});

test('execution pins control order and incomplete wiring cannot partially run', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const a = (await executor.dispatch('create-rect', { x: 0, y: 0, width: 500, height: 100, name: 'First panel' })).value as string;
    const b = (await executor.dispatch('create-rect', { x: 1000, y: 0, width: 100, height: 100, name: 'Second panel' })).value as string;
    const id = (await executor.dispatch('create-parametric-folder', { ids: [a, b] })).value as string;
    const graph = store.getState().doc.elements[id]!.meta!['parametricGraph'] as { nodes: { id: string; kind: string; elementId?: string; inputValues?: Record<string, number> }[] };
    const first = graph.nodes.find((node) => node.elementId === a)!;
    const second = graph.nodes.find((node) => node.elementId === b)!;
    const finish = graph.nodes.find((node) => node.kind === 'output')!;
    await executor.dispatch('set-parametric-graph', { id, graph: { ...graph, nodes: graph.nodes.map((node) => node.id === first.id ? { ...node, inputValues: { width: 750 } } : node), executionLinks: [], links: [{ id: 'width', fromNode: first.id, fromSocket: 'output:width', toNode: second.id, toSocket: 'input:width' }] } });
    return { a, b, id, first: first.id, second: second.id, finish: finish.id };
  });
  const editor = page.getByTestId('parametric-editor');
  await editor.getByRole('button', { name: 'Fit', exact: true }).click();
  await editor.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('Execution is incomplete');
  expect(await page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]?.width, ids.a)).toBe(500);
  const output = (id: string) => editor.locator(`[data-node-output="${id}"][data-output-socket="exec"]`);
  const input = (id: string) => editor.locator(`[data-node-id="${id}"][data-socket="exec"]`);
  await output('@start').click();
  await input(ids.first).click();
  await output(ids.first).dragTo(input(ids.second));
  await output(ids.second).click();
  await input(ids.finish).click();
  await editor.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]?.width, ids.b)).toBe(750);
  await expect(editor.locator('[data-execution-wire]')).toHaveCount(3);
  await editor.screenshot({ path: 'test-results/graph-execution-workspace.png' });
});
