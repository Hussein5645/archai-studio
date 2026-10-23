import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';

const [source, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!source || !output) throw Error('Usage: node scripts/package-optional-unreal.mjs <native-stage> <output-directory>');
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).build.buildVersion;
await fs.mkdir(output, { recursive: true });
const staging = path.join(output, 'pack-content');
await fs.mkdir(staging); // New output only: never overwrite an existing pack.
const filter = file => !/[\\/](Binaries|Intermediate|Saved|DerivedDataCache|__pycache__)([\\/]|$)/.test(file);
await fs.cp('unreal', path.join(staging, 'unreal-worker'), { recursive: true, filter });
await fs.cp(path.join(source, 'unreal'), path.join(staging, 'unreal'), { recursive: true,
  filter: file => !/[\\/](Saved|Intermediate|DerivedDataCache|Logs|Crashes)([\\/]|$)/.test(file) && !/\.(pdb|debug)$/i.test(file) && path.basename(file) !== 'ArchaiRender.exe' });
await fs.cp(path.join(source, 'unreal-native'), path.join(staging, 'unreal-native'), { recursive: true });
let unpackedBytes = 0;
async function count(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await count(file); else unpackedBytes += (await fs.stat(file)).size; } }
await count(staging);
const archive = path.join(output, 'runtime.zip');
const archiveTool = await getPath7za();
await new Promise((resolve, reject) => { const child = spawn(archiveTool, ['a', '-tzip', '-mx=5', archive, 'unreal', 'unreal-native', 'unreal-worker'], { cwd: staging, stdio: 'ignore', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`Archive failed: ${code}`))); });
const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
const manifest = { version, bytes: (await fs.stat(archive)).size, sha256: digest.digest('hex'), unpackedBytes };
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
