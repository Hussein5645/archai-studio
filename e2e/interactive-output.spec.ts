import { expect, test } from '@playwright/test';

test('interactive export records the active renderer/style and offers an unbaked WebXR link', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/'); await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const api = window.__archai!;
    await api.executor.dispatch('new-document', { name: 'Interactive outputs' });
    await api.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    const view = await api.executor.dispatch('create-view3d');
    if (!view.ok) throw Error('fixture failed');
    await api.executor.dispatch('set-view3d-settings', { id: view.value, style: 'shaded' });
    await api.executor.dispatch('open-view3d', { id: view.value });
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Export interactive', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export interactive scene' });
  await expect(dialog.getByTestId('interactive-source')).toContainText('Default');
  await expect(dialog.getByTestId('interactive-source')).toContainText('shaded');
  await expect(dialog.getByTestId('interactive-source')).toContainText('not available');
  await page.getByLabel('Interactive destination').selectOption('link');
  await expect(dialog).toContainText('optimized WebXR');
  await expect(dialog).toContainText('Guests can export a Default view');
  await dialog.getByRole('button', { name: 'Sign in to export', exact: true }).click();
  await expect(page.getByTestId('account-email')).toBeVisible();
});
