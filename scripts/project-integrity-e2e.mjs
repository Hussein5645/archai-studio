// npm run build && node scripts/project-integrity-e2e.mjs
// Exercises packaged file:// windows with an isolated profile.
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const repo = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'archai-integrity-'));
let desktop;
try {
  desktop = await electron.launch({ cwd: repo, ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}), args: [...(process.argv[2] ? [] : ['.']), `--user-data-dir=${profile}`],
    env: { ...process.env, ARCHAI_DEV_URL: '', ARCHAI_LIVE_PORT: '47904' } });
  const board = await desktop.firstWindow();
  await board.waitForFunction(() => Boolean(window.__archai));
  const projectId = await board.evaluate(async () => {
    const app = window.__archai;
    await app.executor.dispatch('new-document', { name: 'CAI integrity test' });
    await app.persistence.saveNow();
    return app.store.getState().doc.id;
  });
  const opened = desktop.waitForEvent('window');
  await board.evaluate(projectId => window.__archai.platform.window.openModeling({ assetId: 'integrity-model', name: 'Integrity model', projectId }), projectId);
  const modeler = await opened;
  await modeler.waitForFunction(() => Boolean(window.__modeling));
  assert.equal(new URLSearchParams(new URL(modeler.url()).hash.split('?')[1]).get('project'), projectId);
  const png = await board.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const bytes = zipSync({
    'metadata.json': strToU8(JSON.stringify({ caiVersion: 1, id: 'integrity-model', name: 'Integrity model', category: 'Furnish/Seating', kind: 'asset', size: { width: 500, height: 500 } })),
    'mapping.json': strToU8(JSON.stringify({ version: 1, views: { top: 'views/top.png' }, models: { glb: 'models/model.glb' } })),
    'views/top.png': new Uint8Array(png),
    'models/model.glb': strToU8('test-model-payload'),
  });
  await board.waitForFunction(() => window.__archai.store.getState().ui.screen === 'project');
  for (let i = 0; i < 2; i++) {
    const ack = await modeler.evaluate(({ projectId, bytes, requestId }) => new Promise((resolve, reject) => {
      const channel = new BroadcastChannel('archai-project-sync');
      const timer = setTimeout(() => { channel.close(); reject(new Error('No project acknowledgement')); }, 15_000);
      channel.onmessage = event => {
        if (event.data?.type !== 'ASSET_INSERTED_ACK' || event.data.requestId !== requestId) return;
        clearTimeout(timer); channel.close(); resolve(event.data);
      };
      channel.postMessage({ type: 'INSERT_MODELED_ASSET', projectId, assetId: 'integrity-model', name: 'Integrity model', requestId,
        caiBytes: new Uint8Array(bytes), position: { x: 100, y: 200, elevation: 900 } });
    }), { projectId, bytes: Array.from(bytes), requestId: `send-${i}` });
    assert.equal(ack.success, true, ack.message);
  }
  const state = await board.evaluate(async projectId => {
    const doc = await window.__archai.persistence.loadStored(projectId);
    return Object.values(doc.elements).filter(e => e.kind === 'instance');
  }, projectId);
  assert.equal(state.length, 1);
  assert.equal(state[0].meta.solid.elevation, 900);
  // Close immediately after an edit, before the autosave debounce can fire.
  await modeler.evaluate(() => window.__modeling.store.getState().setMetadata({ name: 'Saved on close' }));
  const closed = modeler.waitForEvent('close');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/modeling?')).close());
  await closed;
  const reopened = desktop.waitForEvent('window');
  await board.evaluate(projectId => window.__archai.platform.window.openModeling({ assetId: 'integrity-model', name: 'Integrity model', projectId }), projectId);
  const restored = await reopened;
  await restored.waitForFunction(() => window.__modeling?.store.getState().metadata.name === 'Saved on close');
  const persistedName = await restored.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('archai-modeling', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('assets', 'readonly');
      const asset = tx.objectStore('assets').get('integrity-model');
      tx.oncomplete = () => { db.close(); resolve(asset.result.metadata.name); };
    };
  }));
  assert.equal(persistedName, 'Saved on close', 'Opening a linked model must not overwrite it with pre-load state');
  await restored.close();
  await board.evaluate(() => window.__archai.executor.dispatch('create-location', { x: 0, y: 0 }));
  await board.getByRole('button', { name: 'Open site concept editor', exact: true }).click();
  const editor = board.getByRole('dialog', { name: 'Site concept editor', exact: true });
  await editor.waitFor();
  await editor.getByRole('button', { name: 'Close site concept editor', exact: true }).click();
  assert.equal(await editor.count(), 0);
  console.log('PASS: native modeler receives project id; CAI delivery is acknowledged, saved and duplicate-free.');
  console.log('PASS: native concept editor returns to project using its close control.');
  console.log('PASS: immediate model close commits edits; reopening preserves its saved state.');
} finally {
  await desktop?.close();
  assert.equal(dirname(profile), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith('archai-integrity-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
