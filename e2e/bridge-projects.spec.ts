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

test('first bridge poll opens linking, then offers keep, cancel or replace for another model from the same app', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const status = await page.evaluate(async () => {
    const app = window.__archai!;
    const modulePath = '/src/live/board.ts';
    const { startLiveLink } = await import(modulePath);
    startLiveLink({ ...app.platform, live: { serve: (handler: Window['bridgeRequest']) => { window.bridgeRequest = handler; return () => {}; } } },
      app.store, app.executor, app.catalog, app.toasts, app.persistence);
    return window.bridgeRequest('status', { key: 'revit:first', app: 'Revit', name: 'First model', protocol: 1 });
  });
  expect(status).toMatchObject({ needsLink: true, document: null });
  const picker = page.getByTestId('bridge-project-picker');
  await expect(picker).toBeVisible();
  // A newer plugin's explicit request joins the picker already opened by its first poll.
  await page.evaluate(() => { window.bridgeChoice = window.bridgeRequest('bind', { key: 'revit:first', app: 'Revit', name: 'First model', choose: true }) as Window['bridgeChoice']; });
  await picker.getByRole('textbox', { name: 'New project name' }).fill('Multiple Revit models');
  await picker.getByRole('button', { name: 'New project', exact: true }).click();
  const destination = await page.evaluate(async () => (await window.bridgeChoice).document.id);
  await page.evaluate(async (project) => {
    await window.bridgeRequest('push', { key: 'revit:first', app: 'Revit', name: 'First model', project,
      model: { archaiRevit: 1, walls: [{ id: 'wall', points: [[0, 0], [1000, 0]], base: 0, height: 3000, layers: [{ name: 'Core', role: 'core', thickness: 200 }] }] } });
  }, destination);
  const oldIds = await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.elements));
  const sourcePicker = page.getByTestId('bridge-source-picker');

  // Cancel leaves the original geometry and destination untouched.
  await page.evaluate((project) => { window.bridgeChoice = window.bridgeRequest('bind', { key: 'revit:cancelled', app: 'Revit', name: 'Cancelled model', project }) as Window['bridgeChoice']; }, destination);
  await expect(sourcePicker).toBeVisible();
  await sourcePicker.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(async () => window.bridgeChoice)).toMatchObject({ cancelled: true });
  expect(await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.elements))).toEqual(oldIds);

  await page.evaluate((project) => { window.bridgeChoice = window.bridgeRequest('bind', { key: 'revit:second', app: 'Revit', name: 'Second model', project }) as Window['bridgeChoice']; }, destination);
  await expect(sourcePicker).toBeVisible();
  await sourcePicker.getByRole('button', { name: 'Create new link', exact: true }).click();
  await page.evaluate(async () => window.bridgeChoice);
  expect(await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.sources))).toEqual(['revit:first', 'revit:second']);
  expect(await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.elements))).toEqual(oldIds);

  // Rebinding the same model reuses it without asking to replace its sibling.
  await page.evaluate(async (project) => { await window.bridgeRequest('bind', { key: 'revit:second', app: 'Revit', name: 'Second model', project }); }, destination);
  await expect(sourcePicker).not.toBeVisible();

  await page.evaluate((project) => { window.bridgeChoice = window.bridgeRequest('bind', { key: 'revit:third', app: 'Revit', name: 'Third model', project }) as Window['bridgeChoice']; }, destination);
  await sourcePicker.getByRole('button', { name: 'Replace First model', exact: true }).click();
  await page.evaluate(async () => window.bridgeChoice);
  expect(await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.sources))).toEqual(['revit:second', 'revit:third']);
  expect(await page.evaluate((ids) => ids.some((id) => Boolean(window.__archai!.store.getState().doc.elements[id])), oldIds)).toBe(false);
  expect(await page.evaluate((project) => window.bridgeRequest('push', { key: 'revit:first', app: 'Revit', project }), destination)).toMatchObject({ refused: 'disconnected' });
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('undo'); });
  expect(await page.evaluate(() => Object.keys(window.__archai!.store.getState().doc.bridge!.elements))).toEqual(oldIds);
});
