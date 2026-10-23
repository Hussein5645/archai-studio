import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('Render stays inside Archai and synchronizes the project with the bundled Unreal viewport', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    let revision = 0;
    const calls: number[] = [];
    Object.assign(window, { __unrealCalls: calls });
    const status = () => ({ available: true, state: revision ? 'ready' as const : 'idle' as const,
      embedded: revision > 0, bakeAvailable: false, projectId: 'sample', revision, meshActors: revision, error: null });
    app.platform.unreal = { status: async () => status(), update: async (bytes: Uint8Array) => {
      calls.push(bytes.length); revision++; return status();
    }, viewport: async () => {}, command: async () => {}, image: async () => new Uint8Array(), exportScene: async () => null, stop: async () => {} };
    await app.executor.dispatch('new-document', { name: 'Unreal viewport sample' });
    await app.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
  });
  const pages = context.pages().length;
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('open-render-studio'); });
  await expect(page.getByTestId('unreal-workspace')).toBeVisible();
  await expect(page.getByTestId('unreal-status')).toContainText('Unreal connected', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __unrealCalls: number[] }).__unrealCalls.length)).toBe(1);
  await writeFile(testInfo.outputPath('scene.AIR'), JSON.stringify(await page.evaluate(() => window.__archai!.store.getState().doc)));
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('create-arch-element', { tool: 'column', x: 4000, y: 0 }); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __unrealCalls: number[] }).__unrealCalls.length), { timeout: 60_000 }).toBe(2);
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Render image', exact: true }).click();
  await page.getByRole('slider', { name: 'Render exposure', exact: true }).press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __unrealCalls: number[] }).__unrealCalls.length), { timeout: 60_000 }).toBe(3);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Render image', exact: true })).toBeEnabled();
  await page.getByLabel('Close export settings').click();
  await expect(page.getByRole('button', { name: 'Export interactive', exact: true })).toBeEnabled();
  expect(context.pages()).toHaveLength(pages);
  await page.getByRole('button', { name: 'Back to Board' }).click();
  await expect(page.getByTestId('unreal-workspace')).toHaveCount(0);
});
