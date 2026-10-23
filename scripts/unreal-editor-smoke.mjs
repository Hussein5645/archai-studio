import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { UnrealEditor } from '../dist-electron/electron/unrealEditor.js';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Provide ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const output = option('--output');
const fixture = new Uint8Array(await fs.readFile(option('--package')));
let child;
const editor = new UnrealEditor(option('--engine'), output, path.resolve('unreal/archai_editor.py'), (executable, args, options) => {
  child = spawn(executable, [...args, `-ExecutePythonScript=${path.resolve('scripts/unreal-editor-smoke.py')}`], options);
  return child;
});
async function waitJSON(file, timeout = 300_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (child?.exitCode !== null) throw new Error('Editor exited before completing its checks');
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${file}`);
}
try {
  const project = await editor.open(fixture);
  const root = path.dirname(project);
  await waitJSON(path.join(root, 'smoke-edited.json'));
  // Change a real vertex position while preserving node/object IDs and materials.
  const files = unzipSync(fixture);
  const glb = files['scene.glb'];
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(strFromU8(glb.slice(20, 20 + jsonLength)));
  const accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const buffer = gltf.bufferViews[accessor.bufferView];
  const offset = 28 + jsonLength + (buffer.byteOffset || 0) + (accessor.byteOffset || 0);
  view.setFloat32(offset, view.getFloat32(offset, true) + 0.125, true);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  manifest.model.sha256 = createHash('sha256').update(glb).digest('hex');
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  await editor.open(zipSync(files), false);
  const pending = await waitJSON(path.join(root, 'ArchaiSource/pending.json'));
  await fs.writeFile(path.join(root, 'smoke-next.json'), JSON.stringify(pending));
  const report = await waitJSON(path.join(root, 'editor-verification.json'), 180_000);
  assert.equal(report.success, true, report.error);
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ ...report, project }, null, 2));
  console.log(JSON.stringify(report));
} finally { if (child?.exitCode === null) child.kill(); }
