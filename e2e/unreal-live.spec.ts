import { signInFixture } from './fixtures/account';
import { expect, test } from '@playwright/test';
import type { UnrealLiveScene } from '../shared/unrealLive';

test('live mesh connection reports loading, reuses assets and saves View exposure', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await signInFixture(page);
  await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'Direct Unreal scene' });
    await app.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    const view = await app.executor.dispatch('create-view3d', { x: 0, y: 4000 });
    if (!view.ok) throw new Error('View creation failed');
    localStorage.setItem('live-calls', '[]');
    let revision = 0;
    const status = () => ({ available: true, state: 'ready' as const, revision, embedded: true,
      meshActors: 1, error: null, projectId: app.store.getState().doc.id, liveBridge: true });
    app.platform.unreal = {
      status: async () => status(),
      update: async () => { throw new Error('Live views must not export a GLB'); },
      live: async (scene: UnrealLiveScene) => {
        const calls = JSON.parse(localStorage.getItem('live-calls')!) as unknown[];
        calls.push({ assets: scene.assets.length, exposure: scene.settings.exposure, nodes: scene.nodes.length });
        localStorage.setItem('live-calls', JSON.stringify(calls));
        await new Promise((resolve) => setTimeout(resolve, revision ? 150 : 1800));
        revision++; return status();
      },
      viewport: async () => {}, command: async () => {}, stop: async () => {}, exportScene: async () => null,
      image: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4msAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
      },
    };
    await app.executor.dispatch('set-view3d-settings', { id: view.value, renderer: 'unreal', style: 'shaded' });
    await app.executor.dispatch('open-view3d', { id: view.value });
  });
  await expect(page.getByRole('progressbar', { name: 'Unreal operation' })).toBeVisible();
  await expect(page.getByTestId('unreal-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await page.getByLabel('View exposure').fill('1.5');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('live-calls')!).at(-1))).toMatchObject({ assets: 0, exposure: 1.5 });
  await expect.poll(() => page.evaluate(() => {
    const state = window.__archai!.store.getState();
    return (state.doc.elements[state.ui.view3d.portalId!]!.meta?.['view3d'] as { renderSettings: { exposure: number } }).renderSettings.exposure;
  })).toBe(1.5);
  await page.getByRole('button', { name: 'Render image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Render image' });
  await dialog.getByRole('button', { name: 'Render image', exact: true }).click();
  await expect(dialog.getByRole('progressbar', { name: 'Rendering image' })).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveCount(0, { timeout: 30_000 });
});
