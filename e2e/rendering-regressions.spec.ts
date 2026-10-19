import { expect, test } from '@playwright/test';

test('project geometry is broadcast only while a modeler has requested it', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const counts = await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'Broadcast test' });
    const id = app.store.getState().doc.id;
    const channel = new BroadcastChannel('archai-project-sync');
    let updates = 0;
    let next: (() => void) | null = null;
    channel.onmessage = event => { if (event.data?.type === 'PROJECT_DOC_UPDATE') { updates++; next?.(); } };
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));
    await app.executor.dispatch('create-rect', { x: 0, y: 0 });
    await settle();
    const idle = updates;
    const requested = new Promise<void>(resolve => { next = resolve; });
    channel.postMessage({ type: 'REQUEST_PROJECT_DOC', projectId: id });
    channel.postMessage({ type: 'MODELING_SESSION_ANNOUNCE', projectId: id, assetId: 'test', name: 'Test' });
    await requested;
    const connected = updates;
    const edited = new Promise<void>(resolve => { next = resolve; });
    await app.executor.dispatch('create-rect', { x: 1000, y: 0 });
    await edited;
    const editing = updates;
    channel.postMessage({ type: 'MODELING_SESSION_CLOSED', projectId: id, assetId: 'test' });
    await settle();
    await app.executor.dispatch('create-rect', { x: 2000, y: 0 });
    await settle();
    channel.close();
    return { idle, connected, editing, closed: updates };
  });
  expect(counts.idle).toBe(0);
  expect(counts.connected).toBeGreaterThan(0);
  expect(counts.editing).toBeGreaterThan(counts.connected);
  expect(counts.closed).toBe(counts.editing);
});

test('moving the map frame leaves the visible pin at the same board position', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const id = await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'Map frame test' });
    const map = await app.executor.dispatch('create-location', { x: 0, y: 0 });
    await app.executor.dispatch('set-viewport', { x: 30, y: 30, zoom: 0.002 });
    return map.ok ? String(map.value) : '';
  });
  const pin = page.getByTestId(`map-pin-${id}`);
  await expect(pin).toBeVisible();
  const before = await pin.boundingBox();
  await page.evaluate(id => window.__archai!.executor.dispatch('move-selection', { ids: [id], dx: 20000, dy: 10000 }), id);
  await expect.poll(async () => (await pin.boundingBox())?.x).toBeCloseTo(before!.x, 1);
  expect((await pin.boundingBox())!.y).toBeCloseTo(before!.y, 1);
});

test('dense plans rasterize once with transparent padding and bounded image size', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/render/meshPlanPreview.ts';
    const { rasterMeshPlan } = await import(modulePath);
    const edges = Array.from({ length: 30000 }, (_, i) => [i % 500 * 20, Math.floor(i / 500) * 100, i % 500 * 20 + 5, Math.floor(i / 500) * 100 + 5]).flat();
    const plan = { edges, cut: [0, 0, 10000, 0] };
    const first = rasterMeshPlan(plan, 10000, 7000, '#885533');
    const second = rasterMeshPlan(plan, 10000, 7000, '#885533');
    const image = new Image(); image.src = first.href; await image.decode();
    return { reused: first === second, width: image.width, height: image.height, padding: first.x < 0 && first.y < 0 };
  });
  expect(result.reused).toBe(true);
  expect(result.width).toBeLessThanOrEqual(1028);
  expect(result.height).toBeLessThanOrEqual(1028);
  expect(result.padding).toBe(true);
});

test('natural materials open with the revised lighting and other view styles still render', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'Natural architectural view' });
    await app.executor.dispatch('set-workspace', { viewStyle: 'realistic' });
    for (const [x, y, width, height, rise, color] of [[0, 0, 18000, 14000, 120, '#b9b3a7'], [1000, 1000, 6000, 5000, 3500, '#c7a27b'], [8000, 2000, 6000, 9000, 7000, '#a0b2a7']]) {
      await app.executor.dispatch('create-rect', { x, y, width, height, style: { fill: color }, meta: { solid: { height: rise } } });
    }
    await app.executor.dispatch('select', { ids: [] });
    await app.executor.dispatch('open-view3d');
  });
  const workspace = page.getByTestId('view3d-workspace');
  await expect(workspace).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  await expect(workspace.locator('canvas')).toBeVisible();
  await workspace.screenshot({ path: 'test-results/natural-materials.png' });
  for (const style of ['shaded', 'hidden-line', 'consistent', 'wireframe']) {
    await page.evaluate(style => window.__archai!.executor.dispatch('set-workspace', { viewStyle: style }), style);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByTestId('view3d-updating')).not.toBeVisible({ timeout: 30000 });
  }
});
