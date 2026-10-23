/** Publish verified desktop artifacts. Credentials stay in the configured Git credential helper. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [mode, folder] = process.argv.slice(2);
if (!['draft', 'publish'].includes(mode) || !folder) throw Error('Usage: node scripts/publish-github-release.mjs draft|publish <verified-artifacts>');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')), version = pkg.build.buildVersion;
const root = path.resolve(folder), tag = `v${version}`, repository = 'Hussein5645/archai-studio';
const credential = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true, timeout: 20000 });
const token = credential.stdout?.split('\n').find(line => line.startsWith('password='))?.slice(9).trim();
if (!token) throw Error('GitHub credential unavailable.');
const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Archai-release', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(url, init = {}) {
  const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com/repos/${repository}${url}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) throw Error(`GitHub release operation failed (${response.status}): ${(await response.text()).slice(0, 600)}`);
  return response.json();
}
const releases = await api('/releases?per_page=100');
let release = releases.find(value => value.tag_name === tag);
if (mode === 'draft') {
  const verification = JSON.parse(await fs.readFile(path.join(root, 'verification.json'), 'utf8'));
  if (!verification.success || !verification.baseInstallerNoUnreal) throw Error('A verified base installer is required.');
  if (release && !release.draft) throw Error('This version is already published; create a new release.');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const body = `Archai ${version} brings native Unreal rendering inside the regular Archai interface, with Unreal distributed as an optional account download.\n\n` +
    '- Windows setup includes no Unreal dependencies and does not download them.\n' +
    '- Sign in inside Archai, select Unreal Engine in a 3D view, then choose Download Unreal. The pack is cached for later use.\n' +
    '- Guests can export Default views as interactive desktop folders. Unreal, VR exports and interactive web links require an account.\n' +
    '- Includes rendering controls, Archai light elements, image resolution settings, scene caching and optimized WebXR publishing.\n' +
    '- Local projects and existing files are preserved.\n\n' +
    'Unreal folder experiences target Windows desktop / PC OpenXR. Web links use optimized WebXR rendering. Lightmass baking requires a configured authoring worker; the optional pack does not install the Unreal Editor. Account verification requires internet access.\n\n' +
    'Download the Windows setup below. SHA-256 checksums and the release verification report are included. Physical headset validation remains separate.';
  release = release ? await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ name: `ArchAI ${version}`, body, target_commitish: commit }), headers: { 'Content-Type': 'application/json' } })
    : await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: `ArchAI ${version}`, target_commitish: commit, body, draft: true, prerelease: false }), headers: { 'Content-Type': 'application/json' } });
  const names = [`ArchAI-Setup-${version}.exe`, `ArchAI-${version}-manifest.json`, `ArchAI-${version}-SHA256SUMS.txt`, 'verification.json'];
  const assets = await api(`/releases/${release.id}/assets`);
  for (const name of names) {
    if (assets.some(asset => asset.name === name)) throw Error(`Asset already exists: ${name}; inspect before replacing.`);
    const file = path.join(root, name), size = (await fs.stat(file)).size;
    await api(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, { method: 'POST', body: createReadStream(file), duplex: 'half',
      headers: { 'Content-Type': name.endsWith('.exe') ? 'application/octet-stream' : name.endsWith('.json') ? 'application/json' : 'text/plain', 'Content-Length': String(size) } });
    console.log(`Uploaded ${name} (${size} bytes)`);
  }
} else {
  if (!release?.draft) throw Error('Expected a reviewed draft release.');
  const assets = await api(`/releases/${release.id}/assets`);
  if (assets.length !== 4 || !assets.some(value => value.name === `ArchAI-Setup-${version}.exe`)) throw Error('Release assets are incomplete.');
  release = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }), headers: { 'Content-Type': 'application/json' } });
}
console.log(JSON.stringify({ id: release.id, url: release.html_url, draft: release.draft }));
