import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UnrealBake } from '../dist-electron/electron/unrealBake.js';
const root = path.resolve(process.argv[2] || 'F:/Archai-Releases/0.3.0.8/bake-check');
const sources = path.join(root, 'Installed Worker', 'unreal-worker');
await fs.mkdir(path.dirname(sources), { recursive: true });
await fs.cp('unreal', sources, { recursive: true, filter: (file) => !/[\\/](Binaries|Intermediate|Saved|__pycache__)([\\/]|$)/.test(file) });
const worker = new UnrealBake('F:/ur5.5/new/UE_5.8', sources.replaceAll('/', '\\'));
const bytes = new Uint8Array(await fs.readFile(process.argv[3] || 'F:/Archai-Releases/view-bakes/001bc25e-f5f3-4afa-8475-71c2f7e2e468/Input/scene-package.zip'));
const workspace = path.join(root, 'job-' + Date.now());
await worker.start(bytes, workspace);
let last = '';
while (worker.status?.state === 'running') { if (worker.status.stage !== last) { last = worker.status.stage; console.log(last); } await delay(1500); }
if (worker.status?.state !== 'ready') throw new Error(JSON.stringify(worker.status));
const verification = JSON.parse(await fs.readFile(path.join(workspace, 'bake-verification.json'), 'utf8'));
if (!verification.success) throw new Error('Missing Unreal lightmaps');
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ installedPathWithSpaces: true, backslashes: true, ...worker.status, lightmaps: verification }, null, 2));
console.log('Installed-path bake and cooked player verified.');
