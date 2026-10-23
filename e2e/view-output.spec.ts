import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('default view exports exact image dimensions and exposes four view actions without requiring a bake', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'View outputs' });
    await app.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    const result = await app.executor.dispatch('create-view3d');
    if (result.ok) await app.executor.dispatch('open-view3d', { id: result.value });
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  const actions = page.getByTestId('view-output-actions');
  await expect(actions.getByRole('button')).toHaveCount(4);
  await expect(actions.getByRole('button', { name: 'Bake scene', exact: true })).toBeDisabled();
  await expect(actions.getByRole('button', { name: 'Export to VR', exact: true })).toBeEnabled();
  await expect(page.getByTestId('view3d-toolbar').getByText('VR', { exact: true })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Render image', exact: true }).click();
  await page.getByLabel('Render resolution').selectOption('custom');
  await page.getByLabel('Render width').fill('800');
  await page.getByLabel('Render height').fill('600');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Render image', exact: true }).click();
  const file = await download;
  const output = testInfo.outputPath('default-render.png');
  await file.saveAs(output);
  const png = await readFile(output);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 600]);
});
