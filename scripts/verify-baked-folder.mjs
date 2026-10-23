import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { exportUnrealExperience } from '../dist-electron/electron/unrealExperience.js';
import { readRenderPackage } from '../dist-electron/electron/renderPackage.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(process.argv[2]);
const report = JSON.parse(await fs.readFile(path.join(root, 'verification.json'), 'utf8'));
const workspace = path.dirname(report.output);
const bytes = new Uint8Array(await fs.readFile(path.join(workspace, 'Input/scene-package.zip')));
const scene = await readRenderPackage(bytes);
const glb = Buffer.from(scene.model);
const gltf = JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString('utf8').trim());
const selected = gltf.nodes.map(node => node.extras?.archai?.id).find(Boolean);
assert.ok(selected);
const destination = path.join(root, 'folder-export'); await fs.mkdir(destination, { recursive: true });
const output = await exportUnrealExperience('unused-for-cooked-export', bytes, destination,
  { delivery: 'baked-unreal', sourceRenderer: 'baked', lighting: 'baked', style: 'realistic', bakeStatus: 'current', bakedOutput: report.output, elements: [selected] },
  { bakeRoot: root, desktopRoot: '', viewerRoot: '' });
const metadata = JSON.parse(await fs.readFile(path.join(output, 'archai-experience.json'), 'utf8'));
assert.equal(metadata.delivery, 'baked-unreal'); assert.equal(metadata.lighting, 'baked'); assert.equal(metadata.bakedOutput, undefined);
assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'elements.json'), 'utf8')).elements, [selected]);
const look = JSON.parse(await fs.readFile(path.join(output, 'look.json'), 'utf8')); assert.equal(typeof look.exposure, 'number'); assert.ok('camera' in look);
for (const name of ['Open Scene.cmd', 'Open in VR.cmd']) {
  const command = await fs.readFile(path.join(output, name), 'utf8'); assert.ok(command.includes('-ArchaiBakedLook=') && command.includes('-ArchaiElementFilter='));
}
await fs.access(path.join(output, 'Runtime/ArchaiRender.exe'));
const capture = path.join(output,'baked-selection.png');
const child = spawn(path.join(output,'Runtime/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe'),
  ['-RenderOffscreen','-NoHMD','-unattended','-nosplash','-ResX=1280','-ResY=800',`-ArchaiBakedLook=${path.join(output,'look.json')}`,`-ArchaiElementFilter=${path.join(output,'elements.json')}`,`-ArchaiCapture=${capture}`],
  { windowsHide: true, stdio: 'ignore' });
try {
  const deadline=Date.now()+120000;
  while (!await fs.stat(capture).then(file=>file.size>1000).catch(()=>false)) {
    if (Date.now()>deadline || child.exitCode!==null) throw Error('Exported baked player did not render');
    await delay(250);
  }
} finally { child.kill(); }
await fs.writeFile(path.join(root, 'baked-folder-verification.json'), JSON.stringify({ success: true, savedCookedBake: true, lightingMetadata: true, selectionFilter: selected, cameraAndLook: true, pcAndVrLaunchers: true, rendered: capture, output }, null, 2));
console.log('Cooked bake folder, source metadata, selection filter, look and PC/VR launchers passed.');
