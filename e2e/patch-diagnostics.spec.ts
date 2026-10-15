import { expect, test } from '@playwright/test';

test('live log retains command results and imported normal repair is undoable from the inspector', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const id = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('new-document');
    const result = await executor.dispatch('create-rect', { x: 0, y: 0, width: 100, height: 100, meta: { mesh: { blobId: 'test-mesh', height: 100 } } });
    if (!result.ok) throw new Error(result.error.message);
    await executor.dispatch('set-selection', { ids: [result.value] });
    return String(result.value);
  });
  await page.getByTestId('open-live-log').click();
  const log = page.getByTestId('live-log');
  await expect(log).toBeVisible();
  await expect(log.getByRole('log')).toContainText('done');
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('rename-document', { name: 'Live log check' }); });
  await expect(log.getByRole('log')).toContainText('Rename');
  await log.getByRole('button', { name: 'Close live log' }).click();
  await expect(log).toHaveCount(0);
  await page.getByLabel('Model normals', { exact: true }).selectOption('recompute-flip');
  expect(await page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]?.meta?.['normalMode'], id)).toBe('recompute-flip');
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('undo'); });
  await expect(page.getByLabel('Model normals', { exact: true })).toHaveValue('source');
});
