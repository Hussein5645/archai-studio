import { expect, test } from '@playwright/test';

test('compact controls, top-bar log, and click-to-place Board lights', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('new-document', { name: 'Light hotfix' }); });
  await expect(page.getByTestId('topbar-open-render-studio')).toHaveCount(0);
  await page.getByTestId('open-live-log').click();
  await expect(page.getByTestId('live-log')).toBeVisible();
  await page.getByRole('button', { name: 'Close live log', exact: true }).click();
  await page.getByTestId('tool-render-light').click();
  await page.getByRole('menuitem', { name: 'Spot light', exact: true }).click();
  await page.getByTestId('workboard').click({ position: { x: 650, y: 350 } });
  await page.getByTestId('workboard').click({ position: { x: 780, y: 400 } });
  await expect.poll(() => page.evaluate(() => Object.values(window.__archai!.store.getState().doc.elements).filter((e) => (e as { meta?: Record<string, unknown> }).meta?.['renderLight']).length)).toBe(1);
  await expect(page.getByTestId('light-properties')).toBeVisible();
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('open-view3d'); });
  await expect(page.getByTestId('view3d-toolbar').getByLabel('View renderer')).toHaveCount(0);
  await expect(page.getByTestId('view3d-toolbar').getByLabel('View style')).toHaveCount(0);
});
