import { expect, test } from '@playwright/test';

test('large board picks correctly after navigation and an edit', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    await executor.dispatch('toggle-left-panel');
    await executor.dispatch('toggle-inspector');
    const result = await executor.dispatch('create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const state = store.getState();
    const source = state.doc.elements[String(result.value)]!;
    const elements = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => {
      const id = `performance-${i}`;
      return [id, { ...source, id, x: i % 100 * 200, y: Math.floor(i / 100) * 200 }];
    }));
    store.setState({ doc: { ...state.doc, elements }, ui: { ...state.ui, selection: [], viewport: { x: 120, y: 120, zoom: 1 } } });
  });
  const board = page.getByTestId('workboard');
  const bounds = (await board.boundingBox())!;
  await expect(board.locator('[data-element-id]')).toHaveCount(1000);
  await page.mouse.click(bounds.x + 170, bounds.y + 170);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual(['performance-0']);
  await page.evaluate(() => {
    const { store } = window.__archai!;
    store.setState({ ui: { ...store.getState().ui, viewport: { x: 220, y: 150, zoom: 0.5 } } });
  });
  await expect(board.locator('g[transform="matrix(0.5 0 0 0.5 220 150)"]')).toHaveCount(1);
  await page.mouse.click(bounds.x + 245, bounds.y + 175);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual(['performance-0']);
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('move-selection', { ids: ['performance-0'], dx: -200, dy: 0 });
    await window.__archai!.executor.dispatch('select', { ids: [] });
  });
  await expect(board.locator('[data-element-id="performance-0"]')).toHaveAttribute('transform', 'matrix(1 0 0 1 -200 0)');
  await page.mouse.click(bounds.x + 145, bounds.y + 175);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual(['performance-0']);
});
