/** Developer-only asset preparation. Customers will use a separately packaged runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (!args.includes('--package') || !args.includes('--engine') || !args.includes('--output')) {
  throw new Error('Usage: node scripts/unreal-prepare.mjs --engine <UE folder> --package <scene.zip> --output <new project folder>');
}
const engine = path.resolve(option('--engine'));
const output = path.resolve(option('--output'));
const executable = path.join(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
await fs.access(executable);
const bytes = await fs.readFile(path.resolve(option('--package')));
if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('Scene package exceeds 512 MB');
const allowed = new Set(['manifest.json', 'render.json', 'scene.glb']);
let unpacked = 0;
const files = unzipSync(bytes, { filter: (file) => {
  if (!allowed.has(file.name)) throw new Error(`Unexpected package entry: ${file.name}`);
  unpacked += file.originalSize;
  if (unpacked > 1024 * 1024 * 1024) throw new Error('Expanded scene package exceeds 1 GB');
  return true;
} });
for (const name of allowed) if (!files[name]) throw new Error(`Missing ${name}`);
const manifest = JSON.parse(strFromU8(files['manifest.json']));
const render = JSON.parse(strFromU8(files['render.json']));
if (manifest.format !== 'archai-scene' || manifest.version !== 1 || render.projectId !== manifest.projectId)
  throw new Error('Unsupported or mismatched scene package');
for (const entry of [manifest.model, manifest.renderDocument]) {
  if (!allowed.has(entry?.path) || createHash('sha256').update(files[entry.path]).digest('hex') !== entry.sha256)
    throw new Error('Scene asset integrity check failed');
}
// Never modify or replace an existing Unreal project.
await fs.mkdir(output);
await fs.mkdir(path.join(output, 'Input'));
await fs.mkdir(path.join(output, 'Config'));
for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(output, 'Input', name), data);
const descriptor = { FileVersion: 3, Category: 'Archai', Description: 'Archai rendering feasibility project',
  Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'EditorScriptingUtilities', Enabled: true },
    { Name: 'Interchange', Enabled: true }, { Name: 'InterchangeEditor', Enabled: true }] };
const project = path.join(output, 'ArchaiRender.uproject');
await fs.writeFile(project, JSON.stringify(descriptor, null, 2));
await fs.writeFile(path.join(output, 'Config', 'DefaultEngine.ini'),
  '[/Script/Engine.RendererSettings]\nr.DynamicGlobalIlluminationMethod=1\nr.ReflectionMethod=1\nr.GenerateMeshDistanceFields=True\n');
const script = fileURLToPath(new URL('../unreal/prepare_scene.py', import.meta.url));
const child = spawn(executable, [project, '-run=pythonscript', `-script=${script}`, '-unattended', '-nosplash', '-NoSound', '-NoSourceControl',
  ...(args.includes('--render') ? ['-AllowCommandletRendering'] : ['-NullRHI'])],
  { shell: false, windowsHide: true, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) throw new Error(`Unreal preparation failed (${code}); see ${output}/Saved/Logs`);
const report = JSON.parse(await fs.readFile(path.join(output, 'preparation-report.json'), 'utf8'));
if (!report.success) throw new Error(report.error || 'Unreal did not complete the scene import');
console.log(JSON.stringify(report, null, 2));
