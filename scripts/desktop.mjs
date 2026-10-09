// Starts the Vite dev server, compiles the Electron main/preload scripts, then launches
// Electron against the dev server. Works the same on Windows, macOS and Linux without
// shell-specific env syntax.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const DEV_URL = 'http://localhost:5173';

const viteBin = require.resolve('vite/bin/vite.js');
const tscBin = require.resolve('typescript/bin/tsc');
const electronBin = require('electron');

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', ...opts });
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Dev server did not come up at ${url}`);
}

const vite = run(process.execPath, [viteBin, '--clearScreen', 'false']);
try {
  const tscCode = await waitForExit(run(process.execPath, [tscBin, '-p', 'electron/tsconfig.json']));
  if (tscCode !== 0) throw new Error('Electron TypeScript build failed');
  await waitForServer(DEV_URL);
  const electron = run(electronBin, ['.'], { env: { ...process.env, ARCHAI_DEV_URL: DEV_URL } });
  await waitForExit(electron);
} finally {
  vite.kill();
}
