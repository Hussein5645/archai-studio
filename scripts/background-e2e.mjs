// Run after npm run build. Uses a disposable desktop profile and its own bridge port.
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'archai-background-'));
const port = 47903;
let desktop;
try {
  desktop = await electron.launch({
    cwd: repo,
    ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}),
    args: [...(process.argv[2] ? [] : ['.']), `--user-data-dir=${profile}`],
    env: { ...process.env, ARCHAI_DEV_URL: '', ARCHAI_LIVE_PORT: String(port) },
  });
  const page = await desktop.firstWindow();
  // Playwright itself disables some Chromium throttling. Check the real window
  // preference too, so its test defaults cannot mask a regression in our setup.
  assert.equal(await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()), false);
  await page.waitForFunction(() => Boolean(window.__archai), { timeout: 60_000 });
  await page.waitForLoadState('load');
  // Let the startup-only three-second window reveal fallback finish first.
  await new Promise(resolve => setTimeout(resolve, 3500));
  await desktop.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const win = BrowserWindow.getAllWindows()[0];
    win.once('minimize', () => resolve(undefined));
    win.minimize();
  }));
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/live/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-ArchAI-Live': '1', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const key = 'background-regression';
  const bound = await request('bind', { key, app: 'Background test', newName: 'Background project' });
  assert.ok(bound.document?.id, JSON.stringify(bound));
  await page.evaluate(async (id) => {
    const app = window.__archai;
    const created = await app.executor.dispatch('new-document', { name: 'Another project' });
    if (!created.ok) throw new Error('Could not create another project');
    if (!await app.persistence.openStored(id)) throw new Error('Background project opening failed');
  }, bound.document.id);
  const result = await request('push', {
    key, project: bound.document.id, protocol: 2, changeId: 'background-wall',
    model: { archaiRevit: 1, walls: [{ id: 'wall', points: [[0, 0], [1000, 0]], base: 0, height: 3000,
      layers: [{ name: 'Core', role: 'core', thickness: 200 }] }] },
  });
  assert.ok(!result.refused && !result.error, JSON.stringify(result));
  assert.ok(await page.evaluate(() => Object.keys(window.__archai.store.getState().doc.bridge?.elements ?? {}).length > 0));
  // Exports and other UI work can yield to animation frames: those must run too.
  await page.evaluate(() => Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Background frames stalled')), 5000)),
  ]));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
  console.log('PASS: project creation, linked geometry and animation frames complete while minimized.');
} finally {
  await desktop?.close();
  assert.equal(dirname(profile), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith('archai-background-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
