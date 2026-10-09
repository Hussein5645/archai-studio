// Uploads a folder to an R2 bucket with wrangler, keeping relative paths as object keys:
//   node scripts/r2-upload.mjs <folder> <bucket>/<prefix> [--skip index.json,...] [--jobs 6]
// Used for the asset and material libraries (scripts/asset-library.mjs, material-library.mjs).
import { readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { spawn } from 'node:child_process';

const [folder, target, ...rest] = process.argv.slice(2);
if (!folder || !target) throw new Error('usage: node scripts/r2-upload.mjs <folder> <bucket>/<prefix> [--skip a,b] [--jobs n]');
const option = (name, fallback) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : fallback;
};
const skip = new Set(option('skip', '').split(',').filter(Boolean));
const jobs = Number(option('jobs', '6'));
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.cai': 'application/zip', '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance' };

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (!skip.has(name)) files.push(path);
  }
};
walk(folder);

const put = (file) =>
  new Promise((resolve) => {
    const key = `${target.replace(/\/+$/, '')}/${relative(folder, file).replaceAll('\\', '/')}`;
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // npx needs a shell on Windows: quote every argument (keys and paths have spaces and "&").
    const args = ['wrangler', 'r2', 'object', 'put', key, '--file', file, '--content-type', type, '--remote'].map((arg) => `"${arg}"`);
    const child = spawn('npx', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) => resolve({ key, ok: code === 0, output }));
  });

let next = 0;
let failed = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < files.length) {
      const file = files[next++];
      let result = await put(file);
      if (!result.ok) result = await put(file);
      if (!result.ok) {
        failed++;
        console.error('FAILED', result.key, result.output.slice(-300));
      } else console.log(`${next}/${files.length}`, result.key);
    }
  }),
);
console.log(`${files.length - failed}/${files.length} uploaded in ${Math.round((Date.now() - started) / 1000)} s`);
if (failed) process.exit(1);
