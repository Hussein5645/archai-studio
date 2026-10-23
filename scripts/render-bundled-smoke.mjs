import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const executable = option('--app');
const fixture = option('--project');
const output = option('--output');
await fs.mkdir(output);
const cache = path.join(output, 'sessions');
const env = { ...process.env, ARCHAI_RENDER_CACHE: cache };
delete env.ARCHAI_RENDER_RUNTIME;
const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60_000 });
async function report(revision) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const directory = path.join(cache, (await fs.readdir(cache)).find((name) => name.startsWith('session-')));
      const data = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
      if (data.state === 'error') throw new Error(data.error);
      if (data.state === 'ready' && data.revision >= revision) return { ...data, token: undefined };
    } catch (error) {
      if (error?.message && !['ENOENT', 'ERR_INVALID_ARG_TYPE'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    await delay(200);
  }
  throw new Error(`No ready report for revision ${revision}`);
}
try {
  await app.evaluate(({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  }, fixture);
  await app.evaluate(({ dialog }, image) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: image }); }, path.join(output, 'unreal-render.png'));
  const board = await app.firstWindow();
  await board.getByTestId('open-project-btn').click();
  await expect(board.getByTestId('topbar-open-render-studio')).toBeVisible({ timeout: 30_000 });
  const opened = app.waitForEvent('window');
  await board.getByTestId('topbar-open-render-studio').click();
  const render = await opened;
  await expect(render.getByTestId('open-unreal-preview')).toBeEnabled({ timeout: 60_000 });
  await render.getByTestId('open-unreal-preview').click();
  await expect(render.getByTestId('unreal-status')).toContainText('Unreal connected', { timeout: 180_000 });
  const initial = await report(1);
  assert.ok(initial.meshActors > 0);
  await expect(render.locator('canvas')).toHaveCount(0);
  await expect(render.getByRole('button', { name: 'Rendered preview', exact: true })).toHaveCount(0);
  await render.getByRole('button', { name: 'Render image', exact: true }).click();
  await expect.poll(async () => fs.stat(path.join(output, 'unreal-render.png')).then((file) => file.size).catch(() => 0), { timeout: 60_000 }).toBeGreaterThan(1000);
  await render.getByRole('slider', { name: /^Exposure/ }).focus();
  await render.getByRole('slider', { name: /^Exposure/ }).press('ArrowRight');
  const relit = await report(initial.revision + 1);
  assert.equal(relit.sceneImports, initial.sceneImports);
  assert.deepEqual(relit.camera, initial.camera);
  await expect(render.getByTestId('unreal-status')).toContainText('Unreal connected', { timeout: 15_000 });
  await render.screenshot({ path: path.join(output, 'connected.png') });
  await render.getByRole('button', { name: 'Close Unreal', exact: true }).click();
  await expect(render.getByTestId('unreal-status')).toHaveText('Unreal is ready to open', { timeout: 15_000 });
  assert.deepEqual(await fs.readdir(cache), []);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ version: '0.3.0.3', unrealOnly: true, renderedImage: true, initial, relit, closedAndCleaned: true }, null, 2));
  console.log('Bundled desktop-to-Unreal launch, live lighting update, camera preservation and shutdown passed.');
} finally { await app.close(); }
