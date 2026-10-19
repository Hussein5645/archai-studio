import { expect, test } from '@playwright/test';

test('live log minimizes to the latest three entries without blocking the project', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-live-log').click();
  await expect(page.getByTestId('live-log')).toBeVisible();
  await page.getByRole('button', { name: 'Minimize live log', exact: true }).click();
  await expect(page.getByTestId('live-log')).not.toBeVisible();
  const compact = page.getByTestId('compact-live-log');
  await expect(compact).toBeVisible();
  await page.evaluate(() => { for (let i = 0; i < 5; i++) console.warn(`compact-event-${i}`); });
  await expect(compact).toContainText('compact-event-4');
  await expect(compact).not.toContainText('compact-event-1');
  await page.getByRole('button', { name: 'Expand live log', exact: true }).click();
  await expect(page.getByTestId('live-log')).toBeVisible();
  await expect(compact).not.toBeVisible();
});

test('concept editor returns to the project by button and keyboard while drawing', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'Concept exit test' });
    await app.executor.dispatch('create-location', { x: 0, y: 0 });
  });
  const open = page.getByRole('button', { name: 'Open site concept editor', exact: true });
  await open.click();
  const editor = page.getByRole('dialog', { name: 'Site concept editor', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Draw solid', exact: true }).click();
  await editor.getByRole('button', { name: 'Close site concept editor', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await open.click();
  const close = editor.getByRole('button', { name: 'Close site concept editor', exact: true });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(editor).not.toBeVisible();
  await open.click();
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
});
