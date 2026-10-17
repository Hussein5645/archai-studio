import { expect, test } from '@playwright/test';

test('project card paints a blocking loader before reading and reveals the prepared board', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const id = await page.evaluate(async () => {
    const { executor, persistence, platform, store } = window.__archai!;
    await executor.dispatch('new-document', { name: 'Loading test' });
    const result = await executor.dispatch('create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const state = store.getState();
    const source = state.doc.elements[String(result.value)]!;
    const doc = { ...state.doc, elements: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`load-${i}`, { ...source, id: `load-${i}`, x: i % 100 * 200, y: Math.floor(i / 100) * 200 }])) };
    await persistence.storeDocument(doc);
    await executor.dispatch('go-home');
    const original = platform.storage.get.bind(platform.storage);
    const hooks = window as unknown as { releaseProjectRead: () => void; projectReadCount: number };
    hooks.projectReadCount = 0;
    const gate = new Promise<void>((resolve) => { hooks.releaseProjectRead = resolve; });
    platform.storage.get = async (key: string) => {
      if (key === `doc:${doc.id}`) { hooks.projectReadCount++; await gate; }
      return original(key);
    };
    return doc.id;
  });
  await page.getByTestId(`project-card-${id}`).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('project-loading')).toBeVisible();
  await expect(page.getByTestId('project-loading')).toContainText('Loading test');
  await expect(page.getByTestId('home-screen').locator('..')).toHaveAttribute('inert', '');
  await page.keyboard.press('r');
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.tool)).toBe('select');
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.screen)).toBe('home');
  await expect.poll(() => page.evaluate(() => (window as unknown as { projectReadCount: number }).projectReadCount)).toBe(1);
  await page.screenshot({ path: 'test-results/project-loading-screen.png' });
  await page.evaluate(() => (window as unknown as { releaseProjectRead: () => void }).releaseProjectRead());
  await expect(page.getByTestId('project-loading')).toHaveCount(0);
  await expect(page.getByTestId('workboard').locator('[data-element-id]')).toHaveCount(1000);
  expect(await page.evaluate(() => window.__archai!.store.getState().doc.id)).toBe(id);
});

test('a broken project dismisses loading and keeps Home available', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const id = await page.evaluate(async () => {
    const { executor, persistence, platform, store } = window.__archai!;
    await executor.dispatch('new-document', { name: 'Broken project' });
    const doc = store.getState().doc;
    await persistence.storeDocument(doc);
    await executor.dispatch('go-home');
    await platform.storage.set(`doc:${doc.id}`, '{}');
    return doc.id;
  });
  await page.getByTestId(`project-card-${id}`).click();
  await expect(page.getByTestId('project-loading')).toHaveCount(0);
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByText('Could not open project "Broken project"', { exact: true })).toBeVisible();
});
