import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const workspace = option('--workspace');
const output = option('--output');
const baked = JSON.parse(await fs.readFile(path.join(workspace, 'bake-verification.json'), 'utf8'));
if (!baked.success || baked.meshesWithLightmaps < 1) throw new Error('Baked lightmap verification failed');
await fs.mkdir(output);
const image = path.join(output, 'baked.png');
const log = path.join(output, 'runtime.log');
const executable = path.join(workspace, 'Experience/Windows/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe');
const child = spawn(executable, ['-RenderOffscreen', '-NoHMD', '-unattended', '-nosplash', '-ResX=1280', '-ResY=800',
  `-abslog=${log}`, `-ArchaiCapture=${image}`], { shell: false, windowsHide: true, stdio: 'ignore' });
let failure;
child.once('error', (error) => { failure = error; });
try {
  let captured = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (await fs.stat(image).then((file) => file.size > 1000).catch(() => false)) { captured = true; break; }
    if (child.exitCode !== null) throw new Error(`Baked runtime exited (${child.exitCode})`);
    await delay(250);
  }
  if (!captured) throw new Error('The baked experience did not render a capture');
  const text = await fs.readFile(log, 'utf8').catch(() => '');
  if (text.includes('Interchange start importing source')) throw new Error('The baked map was not used directly');
  if (text.includes('missing usage flag StaticLighting')) throw new Error('Baked materials fell back to the default material');
  const report = { ...baked, standaloneMapLaunch: true, importedAtRuntime: false, renderedImage: image, executable };
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { child.kill(); }
