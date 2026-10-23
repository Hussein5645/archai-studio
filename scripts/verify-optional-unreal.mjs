import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';

const [exe, pack, output] = process.argv.slice(2).map(value => path.resolve(value));
await fs.mkdir(output, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(pack, 'manifest.json'), 'utf8'));
const requests = [];
const fixture = { token: 'isolated-release-fixture', user: { id: 'fixture', email: 'fixture@example.invalid', name: 'Release verification' }, libraryToken: 'fixture' };
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${fixture.token}`) { res.writeHead(401); res.end(); return; }
  requests.push(req.url);
  if (req.url === '/me') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixture)); }
  else if (req.url.endsWith('/manifest')) res.end(JSON.stringify(manifest));
  else if (req.url.endsWith('/package')) { res.setHeader('Content-Length', manifest.bytes); createReadStream(path.join(pack, 'runtime.zip')).pipe(res); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(output, 'profile');
let app;
try {
  app = await electron.launch({ executablePath: exe, args: ['--user-data-dir=' + profile], timeout: 60000 });
  await app.evaluate((_electron, url) => {
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const value = String(input);
      return real(value.startsWith('https://archai-cloud.mklkoklpp.workers.dev/') ? value.replace('https://archai-cloud.mklkoklpp.workers.dev', url) : input, init);
    };
  }, address);
  const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.__archai));
  await page.route('https://archai-cloud.mklkoklpp.workers.dev/**', route => route.fulfill({ json: fixture }));
  const resources = path.join(path.dirname(exe), 'resources');
  for (const name of ['unreal', 'unreal-native', 'unreal-worker']) assert.equal(await fs.access(path.join(resources, name)).then(() => true, () => false), false);
  const initial = await page.evaluate(async () => {
    const api = window.__archai, blocked = [];
    for (const action of [() => api.platform.unreal.status(), () => api.platform.unreal.command('frame'), () => api.platform.unreal.downloadInstall(), () => api.platform.unreal.exportScene(new Uint8Array())]) {
      try { await action(); blocked.push(false); } catch (error) { blocked.push(String(error).includes('Sign in')); }
    }
    const run = async (id, input) => { const result = await api.executor.dispatch(id, input); if (!result.ok) throw Error(result.error.message); return result.value; };
    await run('new-document', { name: 'Optional Unreal release fixture' });
    for (let i = 0; i < 10; i++) await run('create-arch-element', { tool: 'column', x: i * 2000, y: 0 });
    await run('create-light', { kind: 'point', x: 0, y: 0 });
    const view = await run('create-view3d'); await run('set-view3d-settings', { id: view, renderer: 'unreal', style: 'realistic' });
    await run('open-view3d', { id: view });
    return { blocked, view, project: api.store.getState().doc.id };
  });
  assert.ok(initial.blocked.every(Boolean));
  await expect(page.getByRole('dialog', { name: 'Unreal rendering' })).toContainText('Sign in');
  assert.equal(requests.length, 0, 'Guest startup must not download Unreal');
  assert.equal(await fs.access(path.join(profile, 'runtimes')).then(() => true, () => false), false);
  await page.evaluate(async fixture => { await window.__archai.account.signIn(fixture.user.email, 'fixture-only'); }, fixture);
  await expect(page.getByRole('button', { name: 'Download Unreal', exact: true })).toBeEnabled();
  const started = Date.now(); await page.getByRole('button', { name: 'Download Unreal', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Unreal download' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('dialog', { name: 'Unreal rendering' })).toHaveCount(0, { timeout: 180000 });
  const status = () => page.evaluate(() => window.__archai.platform.unreal.status());
  await expect.poll(async () => { const value = await status(); if (value.state === 'error') throw Error(value.error); return value.state === 'ready' && value.meshActors >= 10; }, { timeout: 180000 }).toBe(true);
  const state = await status(); assert.equal(state.liveBridge, true); assert.equal(state.embedded, true); assert.equal(state.customLights, 1);
  const image = await page.evaluate(async () => Array.from(await window.__archai.platform.unreal.image({ width: 1280, height: 720, quality: 'high' })));
  const png = Buffer.from(image); assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
  await fs.writeFile(path.join(output, 'optional-native-render.png'), png);
  const modules = await app.evaluate(() => process.report.getReport().sharedObjects);
  const dll = modules.find(value => /ArchaiEmbedded\.dll$/i.test(value)); assert.ok(dll?.startsWith(path.join(profile, 'runtimes')));
  const packRequests = () => requests.filter(value => value.endsWith('/package')).length;
  assert.equal(packRequests(), 1);
  await page.evaluate(async () => { await window.__archai.account.signOut(); });
  await expect(page.getByRole('dialog', { name: 'Unreal rendering' })).toContainText('Sign in');
  await page.evaluate(async () => { try { await window.__archai.platform.unreal.status(); throw Error('allowed'); } catch (error) { if (!String(error).includes('Sign in')) throw error; } });
  await page.evaluate(async fixture => { await window.__archai.account.signIn(fixture.user.email, 'fixture-only'); }, fixture);
  await expect.poll(async () => (await status()).state, { timeout: 60000 }).toBe('ready');
  assert.equal(packRequests(), 1);
  const preserved = await page.evaluate(() => ({ id: window.__archai.store.getState().doc.id, count: Object.keys(window.__archai.store.getState().doc.elements).length }));
  assert.equal(preserved.id, initial.project); assert.ok(preserved.count >= 12);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ success: true, installerContainsNoUnreal: true, guestNeverDownloads: true,
    hostRejectsGuest: true, authenticatedExplicitDownload: true, progress: true, downloadAndRenderMs: Date.now() - started,
    optionalLibrary: dll, realNativeRender: true, signoutBlocks: true, signInReusesInstalledPack: true, projectsPreserved: true }, null, 2));
  console.log('Base app, guest restrictions, explicit pack download, real native render, signout and reuse passed.');
} finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
