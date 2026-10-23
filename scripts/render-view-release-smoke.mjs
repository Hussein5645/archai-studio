import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output = path.resolve(process.argv[2] || 'F:/Archai-Releases/0.3.0.8/native-check');
const installed = process.env.ARCHAI_VERIFY_APP;
const runtime = installed ? path.join(path.dirname(installed), 'resources/unreal/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe') : 'F:/Archai-Releases/0.3.0.2/runtime-build/Packaged/Windows/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe';
await fs.mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(installed ? [] : [process.cwd()]), `--user-data-dir=${path.join(output, 'profile')}`],
  env: { ...process.env, ARCHAI_RENDER_RUNTIME: runtime, ARCHAI_RENDER_CACHE: path.join(output, 'sessions') }, timeout: 60_000 });
try {
  const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.__archai));
  await app.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: pathName(directory) }); function pathName(p) { return p + '/render.png'; } dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, output);
  const ids = await page.evaluate(async () => {
    const api = window.__archai;
    api.executor.describe();
    const viewport=api.platform.unreal.viewport;api.platform.unreal.viewport=layout=>{window.__releaseViewport=layout;return viewport(layout);};
    const run = async (command, input) => { const result = await api.executor.dispatch(command, input); if (!result.ok) throw Error(result.error.message); return result.value; };
    await run('new-document', { name: 'Render view release' });
    const first = await run('create-arch-element', { tool: 'column', x: 0, y: 0 });
    await run('rename', { id: first, name: 'First column' });
    await run('create-arch-element', { tool: 'column', x: 4000, y: 0 });
    await run('create-light', { kind: 'point', x: 1000, y: 1000 });
    await run('create-light', { kind: 'spot', x: 2000, y: 0, target: [0, 0] });
    await run('create-light', { kind: 'area', x: 3000, y: 1000 });
    await run('open-render-studio');
    const view = api.store.getState().ui.view3d.portalId;
    await run('set-view3d-settings', { id: view, style: 'realistic' });
    return { first, view };
  });
  await expect.poll(() => page.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.state === 'ready' && s.meshActors >= 2 && s.customLights === 3)), { timeout: 180_000 }).toBe(true);
  for (const style of ['hidden-line', 'consistent', 'shaded', 'wireframe', 'realistic']) {
    const previous = await page.evaluate(() => window.__archai.platform.unreal.status());
    await page.evaluate(async ({ id, style }) => { const result = await window.__archai.executor.dispatch('set-view3d-settings', { id, style }); if (!result.ok) throw Error(result.error.message); }, { id: ids.view, style });
    await expect.poll(async () => { const status = await page.evaluate(() => window.__archai.platform.unreal.status()); await fs.writeFile(path.join(output, 'last-status.json'), JSON.stringify({ style, ...status }, null, 2)); return status.state === 'ready' ? status.revision : 0; }, { timeout: 60000 }).toBeGreaterThan(previous.revision);
    const bytes = await page.evaluate(async () => Array.from(await window.__archai.platform.unreal.image()));
    await fs.writeFile(path.join(output, 'style-' + style + '.png'), new Uint8Array(bytes));
  }
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await expect(page.getByTestId('view-output-actions').getByRole('button')).toHaveCount(4);
  await expect(page.getByRole('radio', { name: 'Lighting', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('unreal-workspace').getByRole('button', { name: 'VR', exact: true })).toHaveCount(0);
  const bounds = await page.getByTestId('unreal-viewport').evaluate((element) => { const r = element.getBoundingClientRect(), main = element.closest('main').getBoundingClientRect(); return { width: r.width, height: r.height, mainWidth: main.width, mainHeight: main.height }; });
  assert.equal(bounds.width, bounds.mainWidth); assert.equal(bounds.height, bounds.mainHeight);
  if (process.argv.includes('--hold')) {
    await fs.writeFile(path.join(output, 'visual-ready'), 'ready');
    const limit = Date.now() + 180000;
    while (Date.now() < limit && !await fs.access(path.join(output, 'visual-done')).then(() => true).catch(() => false)) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await expect.poll(async () => {
    return page.evaluate(()=>window.__releaseViewport?.exclusions.length??0);
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(4);
  await page.getByTestId('view-output-actions').getByRole('button', { name: 'Render image', exact: true }).click();
  await page.getByLabel('Render resolution').selectOption('1280x720');
  await page.getByRole('dialog', { name: 'Render image' }).getByRole('button', { name: 'Render image', exact: true }).click();
  await expect.poll(() => fs.stat(path.join(output, 'render.png')).then((s) => s.size).catch(() => 0), { timeout: 90_000 }).toBeGreaterThan(1000);
  const png = await fs.readFile(path.join(output, 'render.png'));
  assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
  await page.getByLabel('Close export settings').click();
  await page.getByRole('button', { name: 'Export to VR', exact: true }).click();
  await expect(page.getByLabel('Interactive destination')).toHaveValue('link');
  await expect(page.getByLabel('Interactive lighting')).toHaveValue('realtime');
  await page.getByLabel('Close export settings').click();
  await page.getByRole('button', { name: 'Export interactive', exact: true }).click();
  await page.getByLabel('Export scope').selectOption('selected');
  await page.getByRole('dialog').getByLabel('First column', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Export interactive scene', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/Interactive scene saved:/)).toBeVisible({ timeout: 120_000 });
  const exported = path.join(output, (await fs.readdir(output)).find((name) => name.startsWith('Archai-Experience-')));
  const files = await fs.readdir(path.join(exported, 'Scene')); const glb = await fs.readFile(path.join(exported, 'Scene', files.find((name) => name.endsWith('.glb'))));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8').trim());
  const objectIds = [...new Set(json.nodes.map((node) => node.extras?.archai?.id).filter(Boolean))];
  assert.deepEqual(objectIds, [ids.first]);
  await page.getByLabel('Close export settings').click();
  await page.getByRole('button', { name: 'Back to Board' }).click();
  await page.evaluate(async()=>{await window.__archai.platform.unreal.stop();});
  await expect.poll(async () => (await fs.readdir(path.join(output, 'sessions'))).filter(name=>name.startsWith('session-')), { timeout: 20_000 }).toEqual([]);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ success: true, fullViewport: bounds, panelExclusions: true, fourViewActions: true, noLightingTab: true, highResolutionImage: [1280, 720], unbakedWebXrOption: true, selectedInteractiveExport: objectIds, embedded: true, threeLightTypes: true, cleanup: true }, null, 2));
  console.log('Unreal viewport, light sync, image resolution, VR gate, selected export and cleanup passed.');
} finally { await app.close(); }
