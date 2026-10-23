import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readRenderPackage } from '../dist-electron/electron/renderPackage.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
};
const executable = option('--runtime');
const output = option('--output');
const scene = await readRenderPackage(new Uint8Array(await fs.readFile(option('--package'))));
await fs.mkdir(output);
const token = randomUUID();
const modelFile = `scene-${scene.modelHash}.glb`;
await fs.writeFile(path.join(output, modelFile), scene.model);
await fs.writeFile(path.join(output, 'session.json'), JSON.stringify({ ...scene, model: undefined,
  version: 1, token, revision: 1, modelFile }));
const render = args.includes('--render');
const capture = path.join(output, 'unreal.png');
const child = spawn(executable, [`-ArchaiSession=${output}`, `-ArchaiToken=${token}`, '-ArchaiSmoke',
  '-unattended', '-nosplash', `-abslog=${path.join(output, 'runtime.log')}`,
  ...(render ? ['-windowed', '-ResX=1280', '-ResY=800', `-ArchaiCapture=${capture}`] : ['-RenderOffscreen', '-ResX=640', '-ResY=400'])],
  { shell: false, windowsHide: !render, stdio: 'ignore' });
let exitCode = null;
child.once('exit', (code) => { exitCode = code ?? -1; });
let launchError;
child.once('error', (error) => { launchError = error; });
try {
  const deadline = Date.now() + 300_000;
  let report;
  let verified = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { report = JSON.parse(await fs.readFile(path.join(output, 'status.json'), 'utf8')); } catch { /* Still starting. */ }
    if (report?.token === token && report.state === 'error') throw new Error(report.error);
    if (report?.token === token && report.state === 'ready' && report.meshActors > 0 && report.identityMappedActors === report.meshActors) {
      if (!render || await fs.stat(capture).then((value) => value.size > 0).catch(() => false)) {
        const result = { ...report, token: undefined, renderedCapture: render ? capture : null, testedExecutable: executable };
        await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
        verified = true;
        break;
      }
    }
    if (exitCode !== null) throw new Error(`Renderer exited before verification (${exitCode}); see runtime.log`);
    await delay(500);
  }
  if (!verified) throw new Error('Renderer verification timed out');
} finally { if (exitCode === null) child.kill(); }
