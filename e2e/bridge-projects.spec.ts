import { expect, test } from '@playwright/test';
import type { LiveRequestKind } from '../shared/ipc';

declare global {
  interface Window {
    bridgeRequest: (kind: LiveRequestKind, payload: Record<string, unknown>) => Promise<unknown>;
    bridgeChoice: Promise<{ document: { id: string; name: string } }>;
  }
}

test('choose or create a destination, sync in the background, then reuse an earlier link', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    const modulePath = '/src/live/board.ts';
    const { startLiveLink } = await import(modulePath);
    startLiveLink({ ...app.platform, live: { serve: (handler: Window['bridgeRequest']) => { window.bridgeRequest = handler; return () => {}; } } },
      app.store, app.executor, app.catalog, app.toasts, app.persistence);
    window.bridgeChoice = window.bridgeRequest('bind', { key: 'picker-test', app: 'Test plugin', name: 'Source model', choose: true }) as Window['bridgeChoice'];
  });
  const picker = page.getByTestId('bridge-project-picker');
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: 'New project name' }).fill('Linked destination');
  await picker.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(picker).not.toBeVisible();
  const destination = await page.evaluate(async () => (await window.bridgeChoice).document.id);
  const results = await page.evaluate(async destination => {
    const app = window.__archai!;
    const model = { archaiRevit: 1, walls: [{ id: 'wall', points: [[0, 0], [1000, 0]], base: 0, height: 3000, layers: [{ name: 'Core', role: 'core', thickness: 200 }] }] };
    await window.bridgeRequest('push', { key: 'picker-test', project: destination, protocol: 2, model, changeId: 'first' });
    const ids = Object.keys(app.store.getState().doc.bridge!.elements);
    await app.persistence.flush();
    await app.executor.dispatch('new-document', { name: 'Working elsewhere' });
    const other = app.store.getState().doc.id;
    model.walls[0]!.points[1] = [2000, 0];
    await window.bridgeRequest('push', { key: 'picker-test', project: destination, protocol: 2, model, changeId: 'background' });
    const stored = await app.persistence.loadStored(destination);
    const same = JSON.stringify(Object.keys(stored!.bridge!.elements)) === JSON.stringify(ids);
    return { other, displayed: app.store.getState().doc.id, same };
  }, destination);
  expect(results.displayed).toBe(results.other);
  expect(results.same).toBe(true);
  await page.evaluate(() => { window.bridgeChoice = window.bridgeRequest('bind', { key: 'picker-test', app: 'Test plugin', name: 'Source model', choose: true }) as Window['bridgeChoice']; });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Linked destination/ }).click();
  expect(await page.evaluate(async () => (await window.bridgeChoice).document.id)).toBe(destination);
  await expect(page.getByTestId('bridge-project-picker')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/bridge-linked-project.png' });
});
