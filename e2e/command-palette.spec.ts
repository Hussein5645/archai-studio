import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('new-document');
  });
  await page.getByTestId('open-palette').click();
});

test('keyboard navigation wraps past unavailable commands and restores focus', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Search commands' });
  const enabled = page.locator('[role="option"]:not(:disabled)');
  await expect(input).toBeFocused();
  await expect(page.locator('[role="option"]:disabled').first()).toBeVisible();
  const lastId = await enabled.last().getAttribute('id');
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', lastId!);
  await expect(enabled.last()).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(enabled.first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('open-palette')).toBeFocused();
});

test('search tolerates surrounding spaces and executes the selected command', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Search commands' });
  await input.fill('  Rectangle  ');
  await expect(page.getByTestId('palette-item-tool-rect')).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.tool)).toBe('rect');
});

test('empty search results recover and tab focus stays inside the dialog', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Search commands' });
  await input.fill('zzzzzzzzzzzzzzzzzz');
  await expect(page.getByRole('status')).toContainText('0 available');
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.press('Tab');
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await input.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close command palette', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
});

