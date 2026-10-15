import { expect, test } from '@playwright/test';

test('double-click enters nested groups, limits layers and selection, and breadcrumbs restore the board', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const run = async (name: string, input?: unknown) => {
      const result = await executor.dispatch(name, input);
      if (!result.ok) throw new Error(result.error.message);
      return String(result.value);
    };
    await run('new-document');
    const a = await run('create-rect', { x: 0, y: 0, width: 120, height: 100, name: 'Chair', style: { fill: '#2f6fed' } });
    const b = await run('create-rect', { x: 170, y: 0, width: 120, height: 100, name: 'Table', style: { fill: '#ffaa00' } });
    const inner = await run('group-selection', { ids: [a], name: 'Furniture' });
    const outer = await run('group-selection', { ids: [inner, b], name: 'Room' });
    const outside = await run('create-rect', { x: 340, y: 0, width: 100, height: 100, name: 'Outside', style: { fill: '#cc3333' } });
    await run('select', { ids: [] });
    store.setState({ ui: { ...store.getState().ui, viewport: { x: 410, y: 220, zoom: 1 } } });
    return { a, b, inner, outer, outside };
  });
  const board = page.getByTestId('workboard');
  const box = (await board.boundingBox())!;
  const chair = { x: box.x + 450, y: box.y + 260 };
  const table = { x: box.x + 620, y: box.y + 260 };
  const layers = page.getByRole('tree', { name: 'Layers', exact: true });
  await page.mouse.dblclick(chair.x, chair.y);
  await expect(page.getByTestId('group-edit-bar')).toContainText('Room');
  await expect(layers.locator(`[data-layer-id="${ids.outside}"]`)).toHaveCount(0);
  await expect(layers.locator(`[data-layer-id="${ids.inner}"]`)).toBeVisible();
  await page.mouse.click(table.x, table.y);
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual([ids.b]);
  await page.mouse.dblclick(chair.x, chair.y);
  await expect(page.getByTestId('group-edit-bar')).toContainText('Furniture');
  await expect(layers.locator(`[data-layer-id="${ids.b}"]`)).toHaveCount(0);
  await expect(layers.locator(`[data-layer-id="${ids.a}"]`)).toBeVisible();
  await page.mouse.click(chair.x, chair.y);
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual([ids.a]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.groupEditId)).toBe(ids.outer);
  await page.getByTestId('group-edit-bar').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByTestId('group-edit-bar')).toHaveCount(0);
  await expect(layers.locator(`[data-layer-id="${ids.outside}"]`)).toBeVisible();
});

test('3D double-click enters a group and picks the member mesh using its original owner', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const run = async (name: string, input?: unknown) => {
      const result = await executor.dispatch(name, input);
      if (!result.ok) throw new Error(result.error.message);
      return String(result.value);
    };
    await run('new-document');
    const a = await run('create-rect', { x: 0, y: 0, width: 500, height: 500, meta: { solid: { height: 3000 } } });
    const b = await run('create-rect', { x: 2500, y: 0, width: 500, height: 500, meta: { solid: { height: 3000 } } });
    const group = await run('group-selection', { ids: [a, b], name: '3D group' });
    const portal = await run('create-view3d', { x: 10000, y: 10000 });
    await run('select', { ids: [] });
    await run('open-view3d', { id: portal });
    return { a, b, group, portal };
  });
  await page.waitForFunction(async ({ portal, group }) => {
    const url = '/src/view3d/SceneView.ts';
    const { mountedViews } = await import(url);
    const view = mountedViews.get(portal);
    return view?.renderer.domElement.clientWidth > 600 && view?.built.some((item: { id: string }) => item.id === group);
  }, ids);
  const points = await page.evaluate(async (portal) => {
    const url = '/src/view3d/SceneView.ts', threeUrl = '/node_modules/three/build/three.module.js';
    const { mountedViews } = await import(url);
    const { Vector3 } = await import(threeUrl);
    const view = mountedViews.get(portal);
    view.setCamera({ position: [1500, 1800, 8000], target: [1500, 1500, 0] });
    view.camera.updateMatrixWorld(); view.scene.updateMatrixWorld(true);
    const rect = view.renderer.domElement.getBoundingClientRect();
    return [250, 2750].map((x) => {
      const v = new Vector3(x, 1500, 250).project(view.camera);
      return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
    });
  }, ids.portal);
  await page.mouse.dblclick(points[0]!.x, points[0]!.y);
  await expect(page.getByTestId('group-edit-bar')).toContainText('3D group');
  await page.mouse.click(points[1]!.x, points[1]!.y);
  expect(await page.evaluate(() => window.__archai!.store.getState().ui.selection)).toEqual([ids.b]);
  expect(await page.evaluate(async ({ portal, b }) => {
    const url = '/src/view3d/SceneView.ts';
    const { mountedViews } = await import(url);
    let selected = false;
    mountedViews.get(portal).content.traverse((child: { userData: Record<string, unknown> }) => {
      if (child.userData['ownerId'] === b && child.userData['selectedMaterial']) selected = true;
    });
    return selected;
  }, ids)).toBe(true);
});
