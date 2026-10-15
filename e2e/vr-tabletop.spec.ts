import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';

test('raw scene keeps element IDs and shared VR supports tabletop, live edits and three versions', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(resolve('../SJP-VR/node_modules/three')), 'Requires the sibling SJP-VR checkout with npm install');
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const bytes = await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document');
    await app.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    await app.executor.dispatch('create-arch-element', { tool: 'column', x: 1000, y: 1000 });
    await app.executor.dispatch('open-view3d', {});
    const url = '/src/view3d/vrExport.ts';
    const { exportVrModel } = await import(url);
    return Array.from(new Uint8Array(await exportVrModel(app.store.getState().doc, app.catalog)));
  });
  const model = Buffer.from(bytes);
  const gltf = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString());
  expect(gltf.nodes.filter((n: { extras?: { archai?: { id: string } } }) => n.extras?.archai?.id).length).toBeGreaterThanOrEqual(2);
  await page.locator('summary').filter({ hasText: 'VR' }).click();
  const menu = page.getByRole('button', { name: 'Export Raw VR Link', exact: true }).locator('..');
  await expect(menu.getByRole('button')).toHaveCount(2);
  await expect(menu.getByRole('button', { name: 'Prepare VR Scene', exact: true })).toBeVisible();
  await expect(menu.getByText('Import D5 project folder…')).toHaveCount(0);

  const root = resolve('../SJP-VR');
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
      const data = await readFile(path);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' } as Record<string, string>)[extname(path)] || 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const versions = [1, 2, 3].map((slot) => ({ slot, snapshot: null as unknown }));
  await context.route('https://archai-vr-share.mklkoklpp.workers.dev/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (path.endsWith('tour.json')) await route.fulfill({ json: { format: 'archai-vr', model: 'model.glb', mode: 'raw', lighting: 'live', spaces: [], name: 'Tabletop test' }, headers });
    else if (path.endsWith('model.glb')) await route.fulfill({ body: model, contentType: 'model/gltf-binary', headers });
    else if (/versions\/[123]$/.test(path)) {
      const slot = Number(path.slice(-1)); versions[slot - 1]!.snapshot = route.request().postDataJSON();
      await route.fulfill({ json: versions[slot - 1], headers });
    } else await route.fulfill({ json: { versions }, headers });
  });
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const url = new URL(route.request().url());
    const suffix = url.pathname.split('/three@0.170.0/')[1];
    const path = suffix ? resolve(root, 'node_modules/three', suffix) : resolve('node_modules/three-mesh-bvh/build/index.module.js');
    await route.fulfill({ body: await readFile(path), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  const viewer = await context.newPage();
  const errors: string[] = [];
  viewer.on('pageerror', (e) => errors.push(e.message));
  try {
    await viewer.goto(`http://127.0.0.1:${address.port}/?tour=${encodeURIComponent('https://archai-vr-share.mklkoklpp.workers.dev/tours/abcd/tour.json')}`);
    await expect(viewer.locator('#go')).toBeEnabled({ timeout: 60_000 });
    await viewer.locator('#go').click();
    await expect(viewer.getByRole('button', { name: 'Move elements', exact: true })).toBeVisible();
    expect(await viewer.evaluate('window.tour.tabletop.active')).toBe(true);
    await viewer.getByRole('button', { name: '+ Scale', exact: true }).click();
    await viewer.evaluate(`{
      const t = window.tour.tabletop;
      t.token = 'test-session';
      const node = [...t.nodes.values()][0];
      node.position.x += 1000;
    }`);
    await viewer.getByRole('button', { name: 'Save 1', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Replace 1', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Original', exact: true }).click();
    await viewer.getByRole('button', { name: 'Load 1', exact: true }).click();
    expect(await viewer.evaluate('window.tour.tabletop.transforms()[0].position[0] - window.tour.tabletop.original[0].position[0]')).toBeCloseTo(1000);
    await viewer.evaluate(`{
      const t = window.tour.tabletop;
      const point = t.root.localToWorld(new t.T.Vector3(0, 0, 0));
      window.tour.teleportToFloor(point);
    }`);
    await expect.poll(() => viewer.evaluate('window.tour.tabletop.active')).toBe(false);
    await expect.poll(() => viewer.evaluate('window.tour.busy')).toBe(false);
    await viewer.getByRole('button', { name: 'Tabletop', exact: true }).click();
    await viewer.screenshot({ path: testInfo.outputPath('tabletop.png') });
    expect(errors).toEqual([]);
  } finally { await viewer.close(); server.close(); }
});
