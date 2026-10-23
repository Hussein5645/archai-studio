import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UnrealBake } from '../dist-electron/electron/unrealBake.js';
const root = path.resolve(process.argv[2]);
const previous = JSON.parse(await fs.readFile(path.join(root, 'verification.json'), 'utf8'));
const workspace = path.dirname(previous.output);
const sources = path.join(root, 'Installed Worker', 'unreal-worker');
await fs.cp('unreal', sources, { recursive: true, filter: (file) => !/[\\/](Binaries|Intermediate|Saved|__pycache__)([\\/]|$)/.test(file) });
const worker = new UnrealBake('F:/ur5.5/new/UE_5.8', sources);
await worker.resume(workspace);
let last = '';
while (worker.status?.state === 'running') {
  if (worker.status.stage !== last) { last = worker.status.stage; console.log(last); }
  await delay(1500);
}
if (worker.status?.state !== 'ready') throw new Error(JSON.stringify(worker.status));
const verification = JSON.parse(await fs.readFile(path.join(workspace, 'bake-verification.json'), 'utf8'));
if (!verification.success) throw new Error('Missing baked lightmaps');
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ installedPathWithSpaces: true, resumedLatestSources: true, ...worker.status, lightmaps: verification }, null, 2));
console.log('Latest baked lighting and player verified.');
