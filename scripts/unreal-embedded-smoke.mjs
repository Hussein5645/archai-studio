import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
function option(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0) { if (required) throw new Error(`Provide ${name}`); return null; }
  return path.resolve(process.argv[index + 1]);
}
const output = option('--output');
const installed = option('--app', false);
await fs.mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'),
  args: [...(installed ? [] : [process.cwd()]), `--user-data-dir=${path.join(output, 'profile')}`],
  env: { ...process.env, ARCHAI_RENDER_RUNTIME: option('--runtime'), ARCHAI_RENDER_CACHE: path.join(output, 'sessions'),
    ARCHAI_UNREAL_ENGINE: process.argv.includes('--bake') ? 'F:/ur5.5/new/UE_5.8' : 'Z:/No-Editor-Installed' }, timeout: 60_000 });
let player;
try {
  const board = await app.firstWindow();
  await board.waitForFunction(() => Boolean(window.__archai));
  await board.evaluate(async () => {
    await window.__archai.executor.dispatch('new-document', { name: 'Unreal embedded viewport' });
    await window.__archai.executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    await window.__archai.executor.dispatch('create-arch-element', { tool: 'column', x: 4000, y: 0 });
  });
  await board.evaluate(async () => { const id = window.__archai.store.getState().ui.selection[0]; if (id) await window.__archai.executor.dispatch('select', { ids: [] }); });
  await app.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${output}/unreal-render.png` });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [output] });
  }, output);
  await board.getByTestId('topbar-open-render-studio').click();
  await board.evaluate(async () => { const id = window.__archai.store.getState().ui.view3d.portalId; await window.__archai.executor.dispatch('set-view3d-settings', { id, style: 'realistic' }); });
  await expect(board.getByTestId('unreal-status')).toContainText('Unreal connected', { timeout: 180_000 });
  const initial = await board.evaluate(() => window.__archai.platform.unreal.status());
  assert.equal(initial.embedded, true);
  assert.equal(app.windows().length, 1);
  if (process.argv.includes('--menus')) {
    await board.getByTestId('tool-render-light').click();
    await expect(board.getByRole('menuitem', { name: 'Point light', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const directories = await fs.readdir(path.join(output, 'sessions'));
      for (const directory of directories) {
        const layout = await fs.readFile(path.join(output, 'sessions', directory, 'viewport.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (layout) return layout.visible;
      }
      return true;
    }).toBe(false);
    await board.getByRole('menuitem', { name: 'Point light', exact: true }).click();
    await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.customLights)), { timeout: 30_000 }).toBe(1);
    await board.getByRole('button', { name: 'Remove light', exact: true }).click();
    await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.customLights)), { timeout: 30_000 }).toBe(0);
  }
  await board.getByRole('button', { name: 'Lighting controls', exact: true }).click();
  for (const [index, kind] of ['point', 'spot', 'area'].entries()) {
    await board.getByLabel('Light type', { exact: true }).selectOption(kind);
    await board.getByTestId('add-render-light').click();
    await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.customLights)), { timeout: 30_000 }).toBe(index + 1);
  }
  await board.getByLabel('Light name', { exact: true }).fill('Ceiling area');
  await board.getByLabel('Light Height', { exact: true }).fill('4');
  await board.getByTestId('unreal-render-image').click();
  await expect.poll(() => fs.stat(path.join(output, 'unreal-render.png')).then((s) => s.size).catch(() => 0), { timeout: 60_000 }).toBeGreaterThan(1000);
  await board.getByRole('slider', { name: 'Exposure', exact: true }).press('ArrowRight');
  await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.revision)), { timeout: 30_000 }).toBeGreaterThan(initial.revision);
  await board.evaluate(async () => { await window.__archai.executor.dispatch('create-arch-element', { tool: 'column', x: 8000, y: 0 }); });
  await expect(board.getByTestId('unreal-status')).toContainText('3 meshes', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
  await expect(board.getByTestId('unreal-render-image')).toBeEnabled();
  await board.getByTestId('unreal-export-scene').click();
  await expect(board.getByText(/Interactive scene saved:/)).toBeVisible({ timeout: 120_000 });
  const exported = path.join(output, (await fs.readdir(output)).find((file) => file.startsWith('Archai-Experience-')));
  await fs.access(path.join(exported, 'Open Scene.cmd'));
  const ticket = JSON.parse(await fs.readFile(path.join(exported, 'Scene/session.json'), 'utf8'));
  assert.equal(ticket.settings.lights.find((light) => light.name === 'Ceiling area').position[1], 4);
  const capture = path.join(output, 'exported-player.png');
  player = spawn(path.join(exported, 'Runtime/ArchaiRender/Binaries/Win64', path.basename(option('--runtime'))),
    [`-ArchaiSession=${path.join(exported, 'Scene')}`, `-ArchaiToken=${ticket.token}`, `-ArchaiCapture=${capture}`, '-RenderOffscreen', '-NoHMD'],
    { stdio: 'ignore', windowsHide: true });
  await expect.poll(() => fs.stat(capture).then((s) => s.size).catch(() => 0), { timeout: 120_000 }).toBeGreaterThan(1000);
  const exportedStatus = JSON.parse(await fs.readFile(path.join(exported, 'Scene/status.json'), 'utf8'));
  assert.equal(exportedStatus.customLights, 3);
  assert.equal(exportedStatus.meshActors, 3);
  player.kill(); player = null;
  if (process.argv.includes('--bake')) {
    await board.getByRole('button', { name: 'Bake scene', exact: true }).click();
    await expect(board.getByText('Bake ready. Choose Baked scene or export a VR link.', { exact: true })).toBeVisible({ timeout: 1_800_000 });
    const bake = await board.evaluate(() => { const s = window.__archai.store.getState(); return s.doc.elements[s.ui.view3d.portalId].meta.view3d.bake; });
    const verified = JSON.parse(await fs.readFile(path.join(path.dirname(bake.output), 'bake-verification.json'), 'utf8'));
    assert.equal(verified.success, true);
    await fs.writeFile(path.join(output, 'bake-verification.json'), JSON.stringify({ bake, verified }, null, 2));
    await board.getByTestId('unreal-workspace').getByLabel('View renderer', { exact: true }).selectOption('baked');
    await expect(board.getByTestId('unreal-status')).toContainText('Unreal connected', { timeout: 90_000 });
    await expect(board.getByTestId('unreal-render-image')).toBeEnabled();
    await board.getByTestId('unreal-render-image').click();
    await board.getByTestId('unreal-workspace').getByLabel('View renderer', { exact: true }).selectOption('unreal');
  }
  if (process.argv.includes('--styles')) {
    for (const style of ['shaded', 'consistent', 'wireframe', 'hidden-line', 'realistic']) {
      const previous = await board.evaluate(() => window.__archai.platform.unreal.status());
      await board.getByTestId('unreal-workspace').getByLabel('View style', { exact: true }).selectOption(style);
      await expect.poll(() => board.evaluate(async () => { const s = await window.__archai.platform.unreal.status(); return s.state === 'ready' ? s.revision : 0; }), { timeout: 60_000 }).toBeGreaterThan(previous.revision);
      const png = await board.evaluate(async () => Array.from(await window.__archai.platform.unreal.image()));
      await fs.writeFile(path.join(output, 'style-' + style + '.png'), new Uint8Array(png));
    }
  }
  if (process.argv.includes('--placement')) {
    await board.evaluate(async () => { await window.__archai.executor.dispatch('set-tool', { tool: 'arch:column' }); });
    await fs.writeFile(path.join(output, 'ready-for-placement'), 'ready');
    await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.meshActors)), { timeout: 180_000 }).toBe(4);
    await board.evaluate(async () => { await window.__archai.executor.dispatch('set-tool', { tool: 'select' }); });
    await fs.writeFile(path.join(output, 'placement-verified'), '4 meshes');
  }
  await fs.writeFile(path.join(output, 'ready-for-visual-check'), 'ready');
  if (process.argv.includes('--hold')) {
    const end = Date.now() + 180_000;
    while (Date.now() < end && !await fs.stat(path.join(output, 'continue')).catch(() => null)) await delay(500);
  }
  await board.getByRole('button', { name: 'Back to Board' }).click();
  await expect(board.getByTestId('unreal-workspace')).toHaveCount(0);
  await expect.poll(() => fs.readdir(path.join(output, 'sessions')), { timeout: 15_000 }).toEqual([]);
  const preview = board.getByAltText('Saved view preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('..').locator('canvas')).toHaveCount(0);
  await board.getByTestId('topbar-open-render-studio').click();
  await board.getByRole('button', { name: 'Lighting controls', exact: true }).click();
  await expect(board.getByLabel('Selected light', { exact: true }).locator('option')).toHaveCount(3);
  await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.customLights)), { timeout: 60_000 }).toBe(3);
  await board.getByRole('button', { name: 'Remove light', exact: true }).click();
  await expect.poll(() => board.evaluate(() => window.__archai.platform.unreal.status().then((s) => s.customLights)), { timeout: 30_000 }).toBe(2);
  await board.getByRole('button', { name: 'Back to Board' }).click();
  await expect.poll(() => fs.readdir(path.join(output, 'sessions')), { timeout: 15_000 }).toEqual([]);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ success: true, version: '0.3.0.6', embedded: true,
    noEditorRequired: true, oneArchaiWindow: true, imageCapture: true, liveGeometryAndLighting: true,
    nativeMenus: process.argv.includes('--menus'), directUnrealPlacement: process.argv.includes('--placement'), presentationStyles: process.argv.includes('--styles'), exportedPlayerCaptured: true, pointSpotAreaLights: true, savedLightsReloaded: true, lightRemoval: true,
    exportedLights: exportedStatus.customLights, cleanup: true, initial, exported }, null, 2));
  console.log('Embedded Unreal viewport, PNG, live sync, portable player export and cleanup passed.');
} finally { player?.kill(); await app.close(); }
