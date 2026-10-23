import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { UnrealRuntime } from '../dist-electron/electron/unrealRuntime.js';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const executable = option('--runtime');
const output = option('--output');
await fs.mkdir(output);
const original = new Uint8Array(await fs.readFile(option('--package')));
let sessionDirectory, launches = 0;
const manager = new UnrealRuntime(executable, output, (file, parameters, options) => {
  ++launches;
  sessionDirectory = parameters.find((arg) => arg.startsWith('-ArchaiSession=')).slice('-ArchaiSession='.length);
  return spawn(file, [...parameters, '-RenderOffscreen', '-unattended', `-abslog=${path.join(output, 'runtime.log')}`], { ...options, windowsHide: true });
});
async function ready(revision) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await manager.status(1);
    if (status.state === 'error' || status.state === 'closed') throw new Error(status.error || status.state);
    if (status.state === 'ready' && status.revision === revision) return JSON.parse(await fs.readFile(path.join(sessionDirectory, 'status.json'), 'utf8'));
    await delay(200);
  }
  throw new Error(`Runtime revision ${revision} timed out`);
}
function changedPackage(input, geometry) {
  const files = unzipSync(input);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const render = JSON.parse(strFromU8(files['render.json']));
  render.settings.exposure += 0.25;
  render.camera = { position: [99999, 99999, 99999], target: [0, 0, 0], fov: 55 };
  files['render.json'] = strToU8(JSON.stringify(render));
  if (geometry) {
    const model = files['scene.glb'];
    const view = new DataView(model.buffer, model.byteOffset, model.byteLength);
    const oldJsonLength = view.getUint32(12, true);
    const gltf = JSON.parse(strFromU8(model.slice(20, 20 + oldJsonLength)));
    const node = gltf.nodes.find((entry) => entry.mesh !== undefined);
    if (node.matrix) node.matrix[12] += 1000;
    else { node.translation ??= [0, 0, 0]; node.translation[0] += 1000; }
    const text = JSON.stringify(gltf);
    const json = strToU8(text + ' '.repeat((4 - strToU8(text).length % 4) % 4));
    const remainder = model.slice(20 + oldJsonLength);
    const rebuilt = new Uint8Array(20 + json.length + remainder.length);
    const header = new DataView(rebuilt.buffer);
    header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, rebuilt.length, true);
    header.setUint32(12, json.length, true); header.setUint32(16, 0x4e4f534a, true);
    rebuilt.set(json, 20); rebuilt.set(remainder, 20 + json.length);
    files['scene.glb'] = rebuilt;
  }
  for (const resource of [manifest.model, manifest.renderDocument]) {
    resource.bytes = files[resource.path].length;
    resource.sha256 = createHash('sha256').update(files[resource.path]).digest('hex');
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}
try {
  await manager.update(1, original);
  const initial = await ready(1);
  assert.ok(initial.meshActors > 0);
  assert.equal(initial.identityMappedActors, initial.meshActors);
  const geometry = changedPackage(original, true);
  await manager.update(1, geometry);
  const updated = await ready(2);
  assert.equal(updated.meshActors, initial.meshActors);
  assert.deepEqual(updated.camera, initial.camera, 'Geometry update reset the renderer camera');
  assert.equal(updated.sceneImports, initial.sceneImports + 1);
  assert.ok(initial.sceneBounds?.length === 6 && updated.sceneBounds?.length === 6);
  assert.notDeepEqual(updated.sceneBounds, initial.sceneBounds, 'Geometry change did not reach the rendered scene');
  await manager.update(1, changedPackage(geometry, false));
  const relit = await ready(3);
  assert.equal(relit.sceneImports, updated.sceneImports, 'Lighting-only update reimported geometry');
  assert.deepEqual(relit.camera, initial.camera);
  assert.deepEqual(relit.sceneBounds, updated.sceneBounds);
  assert.equal(launches, 1);
  const image = await manager.command(1, 'image');
  assert.ok(image?.length > 1000);
  assert.deepEqual([...image.slice(0, 8)], [137,80,78,71,13,10,26,10]);
  await fs.writeFile(path.join(output, 'unreal-image.png'), image);
  await manager.command(1, 'frame');
  const report = { initial: { ...initial, token: undefined }, updated: { ...updated, token: undefined }, relit: { ...relit, token: undefined }, launches };
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await manager.stopAll(); }
