import { expect, test } from '@playwright/test';

for (const outcome of ['ready', 'error'] as const) {
  test(`bake loading bar restores a running job and clears on ${outcome}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__archai));
    await page.evaluate(async () => {
      const app = window.__archai!;
      await app.executor.dispatch('new-document', { name: 'Bake progress' });
      const view = await app.executor.dispatch('create-view3d', { x: 0, y: 4000 });
      if (!view.ok) throw new Error('View fixture failed');
      let revision = 0;
      const status = () => ({
        available: true, state: 'ready' as const, embedded: true,
        bakeAvailable: true, revision, meshActors: 1, error: null,
        projectId: app.store.getState().doc.id,
      });
      localStorage.setItem('test-bake-stage', 'Compiling the Unreal bake worker');
      localStorage.setItem('test-bake-state', 'running');
      app.platform.unreal = {
        status: async () => status(),
        update: async () => { revision++; return status(); },
        viewport: async () => {}, command: async () => {},
        image: async () => null, exportScene: async () => null, stop: async () => {},
        bakeStatus: async () => ({
          id: 'progress-job',
          state: localStorage.getItem('test-bake-state') as 'running' | 'ready' | 'error',
          stage: localStorage.getItem('test-bake-stage')!,
          output: 'C:/Bake/Experience', error: 'Bake worker stopped',
        }),
      };
      await app.platform.storage.set(`view-bake-job:${app.store.getState().doc.id}:${view.value}`, JSON.stringify({
        jobId: 'progress-job', signature: 'test-signature', cacheId: 'test-cache',
        vertices: 3, triangles: 1, lightScale: 1,
      }));
      await app.executor.dispatch('set-view3d-settings', { id: view.value, renderer: 'unreal' });
      await app.executor.dispatch('open-view3d', { id: view.value });
    });
    const bar = page.getByRole('progressbar', { name: 'Scene baking' });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-valuetext', 'Compiling the Unreal bake worker');
    await expect(bar).not.toHaveAttribute('aria-valuenow');
    await page.evaluate(() => localStorage.setItem('test-bake-stage', 'Preparing the WebXR version · 42%'));
    await expect(bar).toHaveAttribute('aria-valuenow', '42');
    await page.evaluate(() => localStorage.setItem('test-bake-stage', 'Baking static lighting with Unreal Lightmass'));
    await expect(bar).toHaveAttribute('aria-valuetext', 'Baking static lighting with Unreal Lightmass');
    await expect(bar).not.toHaveAttribute('aria-valuenow');
    await page.screenshot({ path: `test-results/bake-progress-${outcome}.png` });
    await page.evaluate((state) => localStorage.setItem('test-bake-state', state), outcome);
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('unreal-status')).toContainText(
      outcome === 'ready' ? 'Bake ready.' : 'Bake worker stopped',
    );
  });
}
