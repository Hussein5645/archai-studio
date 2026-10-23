import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Provide ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const output = option('--output');
await fs.mkdir(output, { recursive: true });
const projects = path.join(output, 'projects');
const app = await electron.launch({ executablePath: option('--app'),
  args: [`--user-data-dir=${path.join(output, 'profile')}`],
  env: { ...process.env, ARCHAI_UNREAL_PROJECTS: projects,
    ARCHAI_UNREAL_DDC: 'F:/Archai-Releases/0.3.0.4/editor-sync-final/DerivedDataCache' }, timeout: 60_000 });
let ownedPid;
let closed = false;
async function report(previous) {
  const end = Date.now() + 300_000;
  while (Date.now() < end) {
    try {
      for (const directory of await fs.readdir(projects)) {
        const file = path.join(projects, directory, 'ArchaiSource', 'status.json');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value.state === 'error') throw new Error(value.error);
        if (value.state === 'ready' && value.revision !== previous) return value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(500);
  }
  throw new Error('Unreal Editor did not finish importing the Board scene');
}
try {
  await app.evaluate(({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  }, option('--project'));
  const board = await app.firstWindow();
  await board.getByTestId('open-project-btn').click();
  await expect(board.getByTestId('topbar-open-render-studio')).toBeEnabled({ timeout: 30_000 });
  await board.getByTestId('topbar-open-render-studio').click();
  const initial = await report();
  ownedPid = initial.pid;
  assert.ok(initial.meshActors > 0);
  assert.equal(app.windows().length, 1, 'Render must not open an ArchAI Render window');
  await board.evaluate(async () => {
    await window.__archai.executor.dispatch('create-arch-element', { tool: 'column', x: 4000, y: 0 });
  });
  const updated = await report(initial.revision);
  assert.equal(updated.pid, initial.pid);
  assert.ok(updated.meshActors > initial.meshActors);
  // Pressing Render again must reuse the same running Editor.
  await board.getByTestId('topbar-open-render-studio').click();
  const reopened = await report(updated.revision);
  assert.equal(reopened.pid, initial.pid);
  const closing = app.close();
  // Playwright can wait on the detached Windows process tree after Electron exits.
  await Promise.race([closing, delay(5000)]); closed = true;
  let electronExited = false;
  try { process.kill(app.process().pid, 0); } catch { electronExited = true; }
  assert.ok(electronExited, 'ArchAI should exit independently of its detached Editor');
  process.kill(ownedPid, 0);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ success: true,
    version: '0.3.0.4', directEditorLaunch: true, noArchaiRenderWindow: true,
    liveModelSync: true, reusesEditor: true, editorSurvivesArchaiClose: true, initial, updated }, null, 2));
  console.log('Packaged Render button, live Editor model update, Editor reuse and independent lifetime passed.');
} finally {
  if (ownedPid) { try { process.kill(ownedPid); } catch { /* Already closed. */ } }
  if (!closed) await app.close();
}
