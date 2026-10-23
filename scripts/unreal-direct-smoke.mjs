import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve(process.argv[2] || 'F:/Archai-Releases/0.3.0.9/direct-check');
const installed = process.env.ARCHAI_VERIFY_APP;
const runtime = installed ? path.join(path.dirname(installed), 'resources/unreal/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe')
  : 'F:/Archai-Releases/0.3.0.2/runtime-build/Packaged/Windows/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe';
await fs.mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'),
  args: [...(installed ? [] : [process.cwd()]), `--user-data-dir=${path.join(output, 'profile')}`],
  env: { ...process.env, ARCHAI_RENDER_RUNTIME: runtime, ARCHAI_RENDER_CACHE: path.join(output, 'sessions') }, timeout: 60_000 });
try {
  const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const api = window.__archai;
    const run = async (id, input) => { const r = await api.executor.dispatch(id, input); if (!r.ok) throw Error(r.error.message); return r.value; };
    await run('new-document', { name: 'Direct Unreal bridge' });
    const columns = [];
    for (let i = 0; i < 200; i++) columns.push(await run('create-arch-element', { tool: 'column', x: (i % 20) * 2000, y: Math.floor(i / 20) * 2000 }));
    await run('create-light', { kind: 'point', x: 0, y: 0 });
    await run('create-light', { kind: 'spot', x: 2000, y: 0, target: [0,0] });
    await run('create-light', { kind: 'area', x: 4000, y: 0 });
    await run('open-render-studio');
    const view = api.store.getState().ui.view3d.portalId;
    await run('set-view3d-settings', { id: view, style: 'realistic' });
    return { columns, view };
  });
  const start = Date.now();
  const status = () => page.evaluate(() => window.__archai.platform.unreal.status());
  const wait = async (predicate) => {
    await expect.poll(async () => { const s = await status(); await fs.writeFile(path.join(output, 'last-status.json'), JSON.stringify(s, null, 2));
      if (s.state === 'error') throw Error(s.error); return predicate(s); }, { timeout: 180_000 }).toBe(true);
  };
  await wait((s) => s.state === 'ready' && s.embedded && s.meshActors >= 200 && s.liveBridge);
  const firstLoadMs = Date.now() - start, first = await status();
  assert.equal(first.sceneImports, 0); assert.ok(first.meshesBuilt < 10, 'Repeated columns must share mesh assets');
  const partsPerColumn = first.meshActors / 200;
  const directory = (await fs.readdir(path.join(output, 'sessions'))).find(name => name.startsWith('session-')); const session = path.join(output, 'sessions', directory);
  assert.equal((await fs.readdir(session)).some((name) => name.endsWith('.glb')), false);
  await fs.writeFile(path.join(output, 'initial.png'), new Uint8Array(await page.evaluate(async () => Array.from(await window.__archai.platform.unreal.image()))));
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await page.getByLabel('View exposure').fill('1.5');
  await wait((s) => s.state === 'ready' && s.exposure === 1.5 && s.revision > first.revision);
  const exposure = await status(); assert.equal(exposure.meshesBuilt, first.meshesBuilt); assert.equal(exposure.sceneImports, 0);
  await page.evaluate(async (id) => {
    const api = window.__archai; await api.executor.dispatch('select', { ids: [id] });
    const r = await api.executor.dispatch('move-selection', { ids: [id], dx: 500, dy: 0 }); if (!r.ok) throw Error(r.error.message);
  }, ids.columns[0]);
  await wait((s) => s.state === 'ready' && s.revision > exposure.revision);
  const moved = await status(); assert.equal(moved.meshesBuilt, first.meshesBuilt);
  const delta = JSON.parse(await fs.readFile(path.join(session, 'session.json'), 'utf8'));
  assert.equal(delta.upsert.length, partsPerColumn); assert.equal(delta.remove.length, 0);
  assert.deepEqual([...new Set(delta.upsert.map((node) => node.elementId))], [ids.columns[0]]);
  await page.evaluate(async (id) => { const api = window.__archai; await api.executor.dispatch('select', { ids: [id] }); await api.executor.dispatch('delete-selection'); }, ids.columns[1]);
  await wait((s) => s.state === 'ready' && s.meshActors === first.meshActors - partsPerColumn);
  const removed = JSON.parse(await fs.readFile(path.join(session, 'session.json'), 'utf8'));
  assert.equal(removed.remove.length, partsPerColumn); assert.equal(removed.upsert.length, 0);
  const bytes = await page.evaluate(async () => Array.from(await window.__archai.platform.unreal.image({ width: 1280, height: 720, quality: 'high' })));
  await fs.writeFile(path.join(output, 'render.png'), new Uint8Array(bytes));
  await page.getByRole('button', { name: 'Back to Board' }).click();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(session,'viewport.json'),'utf8')).visible).toBe(false);
  const retained = await status();
  const reopenStart = Date.now();
  await page.evaluate(async id => { await window.__archai.executor.dispatch('open-view3d',{id}); }, ids.view);
  await wait(s => s.state==='ready' && s.meshActors===first.meshActors-partsPerColumn);
  const reopened = await status(), reopenMs = Date.now()-reopenStart;
  assert.equal(reopened.meshesBuilt,retained.meshesBuilt);
  assert.equal((await fs.readdir(path.join(output,'sessions'))).filter(name=>name.startsWith('session-')).length,1);
  await page.evaluate(async () => { await window.__archai.platform.unreal.stop(); });
  assert.equal((await fs.readdir(path.join(output,'sessions'))).filter(name=>name.startsWith('session-')).length,0);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ success: true, firstLoadMs, columns: 200,
    uniqueMeshesBuilt: first.meshesBuilt, gltfImports: first.sceneImports, exposureWithoutMeshRebuild: true,
    movedElementUpdates: delta.upsert.length, removedElementUpdates: removed.remove.length, lights: first.customLights, warmReopenMs:reopenMs, retainedScene:true, cleanup: true }, null, 2));
  console.log('Direct mesh reuse, exposure, one-element updates, deletion, image and cleanup passed.');
} finally { await app.close(); }
