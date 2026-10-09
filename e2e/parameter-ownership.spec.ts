import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    await executor.dispatch('set-workspace', { unit: 'mm' });
    if (!store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
  });
});

test('type ownership toggles lock fields and instance edits update the open preview', async ({ page }) => {
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
  });
  await page.getByTestId('system-configuration').getByRole('button').click();
  const dialog = page.getByTestId('system-config-dialog');
  const width = dialog.getByRole('textbox', { name: 'Width', exact: true });
  await expect(dialog.getByRole('checkbox', { name: 'Edit Elevation per instance', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: 'Elevation', exact: true })).toBeDisabled();
  await expect(width).toBeEnabled();
  const ownership = dialog.getByRole('checkbox', { name: 'Edit Width per instance', exact: true });
  await ownership.check();
  await expect(width).toBeDisabled();
  await expect(ownership).toBeEnabled();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByRole('textbox', { name: 'Width', exact: true })).toHaveCount(1);
  const oldPreview = await dialog.getByAltText('Top view').getAttribute('src');
  await inspector.getByRole('textbox', { name: 'Width', exact: true }).fill('750');
  await inspector.getByRole('textbox', { name: 'Width', exact: true }).press('Enter');
  await expect(width).toHaveValue('750.00');
  await expect(dialog.getByAltText('Top view')).not.toHaveAttribute('src', oldPreview!);
  await dialog.screenshot({ path: 'test-results/type-parameters.png' });
  await ownership.uncheck();
  await expect(width).toBeEnabled();
  await width.fill('600');
  await width.press('Enter');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(inspector.getByRole('textbox', { name: 'Width', exact: true })).toHaveCount(0);
});

test('wall layers exposed per instance can be edited from the inspector', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const result = await executor.dispatch('create-wall-segments', { points: [[0, 0], [3000, 0]] });
    const id = (result.value as string[])[0]!;
    await executor.dispatch('set-system-configuration', { id, assetId: null, parameters: {}, instanceEditable: ['layers'] });
    await executor.dispatch('select', { ids: [id] });
    return id;
  });
  const layers = page.getByTestId('instance-parameters').getByTestId('wall-layers');
  await layers.getByLabel('Layer 1 thickness').fill('320');
  await layers.getByLabel('Layer 1 thickness').press('Enter');
  await expect.poll(() => page.evaluate((id) => {
    const wall = window.__archai!.store.getState().doc.elements[id];
    return wall?.kind === 'line' ? wall.style.strokeWidth : null;
  }, id)).toBe(320);
});

test('graph shows one canonical dimension and connected instance values update on Run', async ({ page }) => {
  const columnId = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const columnId = (await executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 })).value as string;
    await executor.dispatch('set-system-configuration', { id: columnId, assetId: null, parameters: { shape: 'circle' }, instanceEditable: ['diameter', 'material'] });
    await executor.dispatch('set-system-parameter', { id: columnId, key: 'elevation', value: 200 });
    const componentId = (await executor.dispatch('create-parametric-component', { x: 2000, y: 0 })).value as string;
    const graph = store.getState().doc.elements[componentId]!.meta!['parametricGraph'] as { nodes: Record<string, unknown>[] };
    await executor.dispatch('set-parametric-graph', { id: componentId, graph: {
      ...graph,
      variables: [{ id: 'material', name: 'Material', type: 'dropdown', value: 'steel', instanceEditable: true }],
      nodes: [...graph.nodes, { id: 'variable', kind: 'variable', x: 0, y: 0, label: 'Material', variableId: 'material' }, { id: 'column', kind: 'element', x: 300, y: 0, label: 'Column instance', elementId: columnId, configuration: { assetId: null, parameters: { shape: 'circle', elevation: 999 }, instanceEditable: ['diameter', 'material'] } }],
      links: [{ id: 'material-link', fromNode: 'variable', fromSocket: 'value', toNode: 'column', toSocket: 'input:parameter:material' }],
    } });
    return columnId;
  });
  const node = page.locator('article[data-kind="element"]');
  await expect(node.locator('[data-parameter="width"], [data-parameter="height"]')).toHaveCount(0);
  await expect(node.locator('[data-parameter="parameter:diameter"]')).toHaveCount(1);
  await expect(node.locator('[data-parameter="parameter:height"]')).toHaveAttribute('data-ownership', 'type');
  const material = node.locator('[data-parameter="parameter:material"] select');
  await expect(material).toHaveValue('steel');
  await expect(material).toBeDisabled();
  await expect(node.locator('[data-parameter="elevation"] input')).toHaveValue('200');
  await node.screenshot({ path: 'test-results/instance-graph.png' });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => {
    const arch = window.__archai!.store.getState().doc.elements[id]!.meta!['arch'] as { parameters: { material: string } };
    return arch.parameters.material;
  }, columnId)).toBe('steel');
});
