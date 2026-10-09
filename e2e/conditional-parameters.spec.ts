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

test('wall placement changes with geometry and appears once, locked in the type panel', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const id = ((await executor.dispatch('create-wall-segments', { points: [[0, 0], [3000, 0]] })).value as string[])[0];
    await executor.dispatch('select', { ids: [id] });
  });
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByLabel('Wall path geometry', { exact: true })).toHaveCount(1);
  await expect(inspector.getByLabel('X', { exact: true })).toHaveCount(0);
  await expect(inspector.getByLabel('Handle count', { exact: true })).toHaveCount(0);
  await inspector.getByLabel('Wall path geometry', { exact: true }).selectOption('bezier');
  await inspector.getByLabel('Handle count', { exact: true }).fill('4');
  await inspector.getByLabel('Handle count', { exact: true }).press('Enter');
  await expect(inspector.getByLabel('Handle 4 X', { exact: true })).toBeVisible();
  await inspector.getByLabel('Handle 1 X', { exact: true }).fill('-900');
  await inspector.getByLabel('Handle 1 X', { exact: true }).press('Enter');
  await inspector.getByLabel('End point Y', { exact: true }).fill('300');
  await inspector.getByLabel('End point Y', { exact: true }).press('Enter');
  await page.getByTestId('system-configuration').getByRole('button').click();
  const dialog = page.getByTestId('system-config-dialog');
  await expect(dialog.getByLabel('Wall path geometry', { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel('Wall path geometry', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Handle count', { exact: true })).toHaveValue('4');
  await expect(dialog.getByLabel('Handle 1 X', { exact: true })).toHaveValue('-900.00');
  await expect(dialog.getByLabel('Handle 1 X', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('End point Y', { exact: true })).toHaveValue('300.00');
  await expect(dialog.getByLabel('Pinned', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await inspector.getByLabel('Wall path geometry', { exact: true }).selectOption('arc');
  await expect(inspector.getByLabel('Handle count', { exact: true })).toHaveCount(0);
  await expect(inspector.getByLabel('Arc bend', { exact: true })).toBeVisible();
  await inspector.getByLabel('Wall path geometry', { exact: true }).selectOption('straight');
  await expect(inspector.getByLabel('Arc bend', { exact: true })).toHaveCount(0);
});

test('door operation controls and plan preview follow the current instance', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const id = (await executor.dispatch('create-arch-element', { tool: 'door', x: 0, y: 0 })).value as string;
    await executor.dispatch('set-system-configuration', { id, assetId: null, parameters: {}, instanceEditable: ['operation', 'handing', 'openingSide'] });
  });
  await page.getByTestId('system-configuration').getByRole('button').click();
  const dialog = page.getByTestId('system-config-dialog');
  const inspector = page.getByTestId('inspector');
  const before = await dialog.getByAltText('Top view').getAttribute('src');
  await expect(dialog.getByLabel('Handing', { exact: true })).toBeDisabled();
  await inspector.getByLabel('Operation', { exact: true }).selectOption('revolving');
  await expect(inspector.getByLabel('Handing', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Handing', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Opens towards', { exact: true })).toHaveCount(0);
  await expect(dialog.getByAltText('Top view')).not.toHaveAttribute('src', before!);
  await inspector.getByLabel('Operation', { exact: true }).selectOption('sliding');
  await expect(inspector.getByLabel('Handing', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Handing', { exact: true })).toBeDisabled();
});

test('level references and instance display settings are mirrored read-only', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const levelId = (await executor.dispatch('create-level', { x: 0, y: 0, width: 5000, height: 3000, elevation: 3000, name: 'Level 2' })).value as string;
    const id = (await executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 })).value as string;
    await executor.dispatch('set-element-level-link', { id, levelId, offset: 250 });
  });
  await page.getByTestId('system-configuration').getByRole('button').click();
  const dialog = page.getByTestId('system-config-dialog');
  await expect(dialog.getByLabel('Linked level', { exact: true })).toHaveValue('Level 2');
  await expect(dialog.getByLabel('Level offset', { exact: true })).toHaveValue('250.00');
  await expect(dialog.getByLabel('Level offset', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Visible', { exact: true })).toBeDisabled();
});
