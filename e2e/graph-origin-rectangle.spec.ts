import { expect, test } from '@playwright/test';

test('graph origin is drawn, moved and resized independently of component contents', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    if (store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    await executor.dispatch('set-viewport', { x: 200, y: 80, zoom: 0.2 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
    await executor.dispatch('set-tool', { tool: 'parametric' });
  });
  const board = page.getByTestId('workboard');
  const box = (await board.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 180);
  await page.mouse.down();
  await expect(page.getByTestId('parametric-editor')).toHaveCount(0);
  await page.mouse.move(box.x + 700, box.y + 420, { steps: 8 });
  await page.mouse.up();
  const ids = await page.evaluate(async () => {
    const { store, executor } = window.__archai!;
    const originId = store.getState().ui.selection[0]!;
    const origin = store.getState().doc.elements[originId]!;
    const child = (await executor.dispatch('create-rect', { x: 6000, y: 0, width: 100, height: 100 })).value as string;
    await executor.dispatch('reparent-element', { id: child, parentId: origin.parentId });
    await executor.dispatch('select', { ids: [originId] });
    return { originId, child, parent: origin.parentId, origin };
  });
  expect(ids.origin).toMatchObject({ x: 0, y: 0, width: 2000, height: 1200, locked: false, meta: { parametricMarker: true } });
  await expect(page.getByTestId('parametric-editor')).toHaveCount(0);
  const fixed = await page.evaluate(({ parent, child }) => {
    const elements = window.__archai!.store.getState().doc.elements;
    return { parent: elements[parent!], child: elements[child] };
  }, ids);
  await page.mouse.move(box.x + 450, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 530, box.y + 240, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate((id) => {
    const element = window.__archai!.store.getState().doc.elements[id]!;
    return [Math.round(element.x), Math.round(element.y)];
  }, ids.originId)).toEqual([400, 200]);
  const handle = (await page.getByTestId('resize-se').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const resized = await page.evaluate((id) => window.__archai!.store.getState().doc.elements[id], ids.originId);
  expect(resized!.width).toBeGreaterThan(2300);
  expect(resized!.height).toBeGreaterThan(1350);
  expect(await page.evaluate(({ parent, child }) => {
    const elements = window.__archai!.store.getState().doc.elements;
    return { parent: elements[parent!], child: elements[child] };
  }, ids)).toEqual(fixed);
  await board.dblclick({ position: { x: 530, y: 240 } });
  await expect(page.getByTestId('parametric-editor')).toBeVisible();
});
