import type { Element } from '../src/document';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 1000 } });

test('analysis origins use the drawn rectangle, support reverse drags and undo', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    await executor.dispatch('set-viewport', { x: 100, y: 80, zoom: 0.1 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
  });
  const box = (await page.getByTestId('workboard').boundingBox())!;
  for (const kind of ['sun', 'wind', 'noise']) {
    await page.evaluate((kind) => window.__archai!.executor.dispatch('tool-analysis-' + kind), kind);
    await page.mouse.move(box.x + 600, box.y + 450);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 250, { steps: 6 });
    await page.mouse.up();
    const origin = await page.evaluate(() => {
      const s = window.__archai!.store.getState();
      return s.doc.elements[s.ui.selection[0]!]!;
    });
    expect(origin).toMatchObject({ x: 2000, y: 1700, width: 3000, height: 2000, meta: { analysis: { kind } } });
    await page.evaluate(() => window.__archai!.executor.dispatch('undo'));
    expect(await page.evaluate(() => Object.values<Element>(window.__archai!.store.getState().doc.elements).filter(e => e.meta?.['analysis']).length)).toBe(0);
  }
});

test('open views expose object and board properties and the full editor, with style-aware analysis', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Shader|WebGLProgram/.test(message.text())) errors.push(message.text()); });
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const d = async (id: string, input?: unknown) => { const r = await executor.dispatch(id, input); if (!r.ok) throw Error(r.error.message); return r.value as string; };
    await d('new-document');
    if (store.getState().ui.panels.left) await d('toggle-left-panel');
    const object = await d('create-rect', { x: 0, y: 0, width: 6000, height: 5000, name: 'Test building' });
    await d('set-solid', { ids: [object], height: 4000 });
    const view = await d('create-view3d', { x: 12000, y: 0, width: 6000, height: 5000 });
    const origin = await d('create-analysis-origin', { kind: 'sun' });
    await d('update-analysis', { id: origin, patch: { date: '2026-06-21', time: '10:30', display: 'sun-hours' } });
    await d('link-analysis-view', { id: origin, viewId: view, linked: true });
    await d('run-analysis', { id: origin });
    await d('open-view3d', { id: view });
    await d('select', { ids: [object] });
    return { object, view, origin };
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByRole('radio', { name: 'Properties', exact: true })).toBeChecked();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Test building');
  await inspector.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited inside view');
  await inspector.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  expect(await page.evaluate(id => window.__archai!.store.getState().doc.elements[id]!.name, ids.object)).toBe('Edited inside view');
  await page.getByRole('radio', { name: 'Board', exact: true }).click();
  await expect(inspector.getByRole('combobox', { name: 'Units', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit board', exact: true }).click();
  await expect(page.getByTestId('tool-rect')).toBeVisible();
  await expect(page.getByTestId('workboard')).toHaveAttribute('data-editing-view', 'true');
  await page.evaluate(async () => {
    const a = window.__archai!;
    await a.executor.dispatch('set-viewport', { x: 100, y: 80, zoom: 0.05 });
    await a.executor.dispatch('set-workspace', { snap: { enabled: false } });
  });
  await page.getByTestId('tool-rect').click();
  const box = (await page.getByTestId('workboard').boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 450, box.y + 400, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => Object.values<Element>(window.__archai!.store.getState().doc.elements).filter(e => e.kind === 'rect' && !e.meta?.['view3d'] && !e.meta?.['analysis']).length)).toBe(2);
  await expect(page.getByTestId('view3d-workspace')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('view-board-editor.png') });
  await page.getByRole('button', { name: 'Hide board editor', exact: true }).click();
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  const captures: string[] = [];
  for (const style of ['hidden-line', 'wireframe', 'consistent', 'shaded', 'realistic']) {
    await inspector.getByRole('combobox', { name: 'View style', exact: true }).selectOption(style);
    await expect(page.getByTestId('view3d-updating')).toHaveCount(0, { timeout: 30000 });
    await page.waitForTimeout(700);
    const png = await page.getByTestId('view3d-workspace').screenshot({ path: testInfo.outputPath('analysis-' + style + '.png') });
    captures.push(png.toString('base64'));
  }
  expect(new Set(captures).size).toBe(5);
  expect(errors).toEqual([]);
});


test('analysis rectangle placement works with a finger', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    if (store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    await executor.dispatch('set-viewport', { x: 0, y: 0, zoom: 0.1 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
    await executor.dispatch('tool-analysis-wind');
  });
  const cdp = await context.newCDPSession(page);
  const box = (await page.getByTestId('workboard').boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 300, y: box.y + 200, id: 0 }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 300 + i * 25, y: box.y + 200 + i * 20, id: 0 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const origins = await page.evaluate(() => Object.values<Element>(window.__archai!.store.getState().doc.elements).filter(e => e.meta?.['analysis']));
  expect(origins).toHaveLength(1);
  expect(origins[0]).toMatchObject({ x: 3000, y: 2000, width: 2000, height: 1600, meta: { analysis: { kind: 'wind' } } });
  await context.close();
});
