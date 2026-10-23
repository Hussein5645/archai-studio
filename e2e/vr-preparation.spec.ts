import { expect, test } from '@playwright/test';

test('browser Render cannot open the retired ArchAI Render window', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('new-document'); });
  await expect(page.getByTestId('topbar-open-render-studio')).toBeDisabled();
  const pages = context.pages().length;
  const result = await page.evaluate(() => window.__archai!.executor.dispatch('open-render-studio'));
  expect(result.ok).toBe(false);
  expect(context.pages()).toHaveLength(pages);
});
