import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UnrealBake } from '../dist-electron/electron/unrealBake.js';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const worker = new UnrealBake(option('--engine'), path.resolve('unreal'));
process.once('SIGINT', () => worker.cancel());
const output = option('--output');
if (args.includes('--resume')) await worker.resume(output);
else await worker.start(new Uint8Array(await fs.readFile(option('--package'))), output);
let previous;
while (worker.status?.state === 'running') {
  if (worker.status.stage !== previous) { previous = worker.status.stage; console.log(previous); }
  await delay(2000);
}
console.log(JSON.stringify(worker.status, null, 2));
if (worker.status?.state !== 'ready') process.exitCode = 1;
