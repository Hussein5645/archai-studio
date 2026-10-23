import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRenderPackage } from './renderPackage.js';
import type { ExperienceOptions } from '../shared/unrealRuntime.js';

type ExportHost = { bakeRoot: string; desktopRoot: string; viewerRoot: string; vrEnabled?: boolean };
const filterRuntime = (file: string) => !/\.(pdb|debug)$/i.test(file) && !/[\\/](Saved|Intermediate|DerivedDataCache|Crashes)([\\/]|$)/i.test(file);

// Electron's archive reader supports readdir/readFile; fs.cp cannot traverse app.asar.
async function copyViewerAssets(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyViewerAssets(from, to);
    else await fs.writeFile(to, await fs.readFile(from));
  }
}

async function exportWebExperience(scene: Awaited<ReturnType<typeof readRenderPackage>>, output: string, host: ExportHost) {
  if (path.resolve(output).startsWith(path.resolve(host.desktopRoot) + path.sep)) throw new Error('Choose an export folder outside the Archai installation.');
  const player = path.join(output, 'Player');
  await fs.cp(host.desktopRoot, player, { recursive: true, filter: file => filterRuntime(file) && path.basename(file) !== 'resources' });
  const executable = path.basename(process.execPath);
  await fs.rename(path.join(player, executable), path.join(player, 'ArchaiPlayer.exe'));
  const web = path.join(output, 'Scene'); await fs.mkdir(web);
  await copyViewerAssets(path.join(host.viewerRoot, 'assets'), path.join(web, 'assets'));
  await fs.writeFile(path.join(web, 'index.html'), await fs.readFile(path.join(host.viewerRoot, 'interactive.html')));
  await fs.writeFile(path.join(web, 'model.glb'), scene.model);
  await fs.writeFile(path.join(web, 'scene.json'), JSON.stringify({ settings: scene.settings, camera: scene.camera, sunDirection: scene.sunDirection, vrEnabled: host?.vrEnabled !== false }));
  const resources = path.join(player, 'resources/app'); await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'package.json'), JSON.stringify({ name: 'archai-experience', version: '1.0.0', main: 'main.cjs' }));
  await fs.writeFile(path.join(resources, 'main.cjs'), `const {app,BrowserWindow,shell}=require('electron');const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
app.whenReady().then(()=>{const root=path.resolve(process.resourcesPath,'../../Scene');
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.glb':'model/gltf-binary','.wasm':'application/wasm','.png':'image/png','.jpg':'image/jpeg','.css':'text/css'};
const server=http.createServer((req,res)=>{let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(file===root)file=path.join(root,'index.html');if(!file.startsWith(root+path.sep))throw Error();}catch{res.writeHead(400);res.end();return;}fs.stat(file,(e,s)=>{if(e||!s.isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});});
server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port+'/';if(!process.argv.includes('--archai-verify'))shell.openExternal(url+(process.argv.includes('--vr')?'?vr=1':''));
const win=new BrowserWindow({width:480,height:260,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.webContents.setWindowOpenHandler(({url:next})=>{if(next.startsWith(url))shell.openExternal(next);return {action:'deny'};});win.loadURL('data:text/html,'+encodeURIComponent('<html><body style="font:16px system-ui;padding:24px"><h2>Archai interactive scene</h2><p><a target="_blank" href="'+url+'">Open scene</a>${host.vrEnabled === false ? '' : ' · <a target="_blank" href="\'+url+\'?vr=1">Open VR entry</a>'}</p><p>${host.vrEnabled === false ? 'Explore this scene on your PC.' : 'Use Enter VR with a compatible PC headset.'} Close this window to stop the local player.</p></body></html>'));win.on('closed',()=>{server.close();app.quit();});});});`);
  await fs.writeFile(path.join(output, 'Open Scene.cmd'), '@echo off\r\nstart "Archai Experience" "%~dp0Player\\ArchaiPlayer.exe" --user-data-dir="%~dp0PlayerData"\r\n');
  if (host.vrEnabled !== false) await fs.writeFile(path.join(output, 'Open in VR.cmd'), '@echo off\r\nstart "Archai VR Experience" "%~dp0Player\\ArchaiPlayer.exe" --user-data-dir="%~dp0PlayerData" --vr\r\n');
  await fs.writeFile(path.join(output, 'README.txt'), host.vrEnabled === false ? 'Archai desktop interactive folder. Open Scene.cmd to explore on this PC. Keep the entire folder together. No Unreal download required.\r\n' : 'Archai WebXR experience\r\nOpen Scene.cmd starts a local browser player. Open in VR.cmd opens its VR entry page.\r\nUse a WebXR-compatible browser and PC headset runtime for local VR.\r\nFor a standalone headset, publish a web link or host the Scene folder over HTTPS.\r\nKeep this entire folder together. No Unreal Editor or Node installation is required.\r\n');
}

async function exportBakedExperience(output: string, options: ExperienceOptions, host: ExportHost, scene: Awaited<ReturnType<typeof readRenderPackage>>) {
  if (!options.bakedOutput) throw new Error('No baked Unreal experience was selected.');
  const root = await fs.realpath(host.bakeRoot), source = await fs.realpath(options.bakedOutput);
  const relative = path.relative(root, source);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || path.basename(source) !== 'Experience') throw new Error('The baked experience is outside the local bake cache.');
  const workspace = path.dirname(source);
  if ((await fs.readFile(path.join(workspace, '.archai-unreal-bake'), 'utf8')).trim() !== '1') throw new Error('Invalid bake workspace.');
  const status = JSON.parse(await fs.readFile(path.join(workspace, 'job-status.json'), 'utf8'));
  if (status.state !== 'ready' || await fs.realpath(status.output) !== source) throw new Error('The Unreal bake is not ready.');
  const original = await readRenderPackage(new Uint8Array(await fs.readFile(path.join(workspace, 'Input/scene-package.zip'))));
  if (original.projectId !== scene.projectId) throw new Error('The saved bake belongs to a different project.');
  await fs.cp(path.join(source, 'Windows'), path.join(output, 'Runtime'), { recursive: true, filter: filterRuntime });
  if (options.elements) await fs.writeFile(path.join(output, 'elements.json'), JSON.stringify({ elements: options.elements }));
  await fs.writeFile(path.join(output, 'look.json'), JSON.stringify({ exposure: scene.settings.exposure, bloom: scene.settings.bloom, camera: scene.camera }));
  const launch = (vr: boolean) => '@echo off\r\nstart "Archai Baked Experience" "%~dp0Runtime\\ArchaiRender.exe" ' +
    (vr ? '-vr ' : '-windowed ') + '-ArchaiBakedLook="%~dp0look.json" ' + (options.elements ? '-ArchaiElementFilter="%~dp0elements.json" ' : '') + '\r\n';
  await fs.writeFile(path.join(output, 'Open Scene.cmd'), launch(false));
  await fs.writeFile(path.join(output, 'Open in VR.cmd'), launch(true));
  await fs.writeFile(path.join(output, 'README.txt'), 'Archai baked Unreal experience\r\nOpen Scene.cmd for desktop, Open in VR.cmd for a compatible Windows PC OpenXR headset.\r\nThis uses saved Lightmass illumination and materials. A selection retains the original full-scene lighting context.\r\nNo Unreal Editor is required. This Windows player does not run in a standalone headset browser.\r\n');
}

/** Portable Unreal player plus a frozen scene. No Editor or local UE install is required. */
export async function exportUnrealExperience(executable: string, bytes: Uint8Array, destination: string, options?: ExperienceOptions, host?: ExportHost): Promise<string> {
  const scene = await readRenderPackage(bytes);
  const output = path.join(destination, `Archai-Experience-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(output); // Never merge with or overwrite a user's project.
  if (options) {
    const { bakedOutput: _path, ...description } = options;
    await fs.writeFile(path.join(output, 'archai-experience.json'), JSON.stringify({ ...description, projectId: scene.projectId, vrEnabled: host?.vrEnabled !== false, createdAt: new Date().toISOString() }, null, 2));
    if (options.delivery !== 'unreal') {
      if (!host) throw new Error('The export host is unavailable.');
      if (options.delivery === 'webxr') await exportWebExperience(scene, output, host);
      else await exportBakedExperience(output, options, host, scene);
      return output;
    }
  }
  await fs.access(executable);
  const token = randomUUID();
  const runtimeRoot = path.resolve(path.dirname(executable), '../../..');
  await fs.cp(runtimeRoot, path.join(output, 'Runtime'), { recursive: true,
    filter: (file) => path.basename(file)!=='ArchaiEmbedded.dll' && !/\.(pdb|debug)$/i.test(file) && !/[\\/](Saved|Intermediate|DerivedDataCache|Crashes)([\\/]|$)/i.test(file) &&
      !(path.basename(executable) !== 'ArchaiRender.exe' && file === path.join(runtimeRoot, 'ArchaiRender', 'Binaries', 'Win64', 'ArchaiRender.exe')) });
  await fs.mkdir(path.join(output, 'Scene'));
  const modelFile = `scene-${scene.modelHash}.glb`;
  await fs.writeFile(path.join(output, 'Scene', modelFile), scene.model);
  await fs.writeFile(path.join(output, 'Scene', 'session.json'), JSON.stringify({ version: 1, token, projectId: scene.projectId,
    revision: 1, modelFile, modelHash: scene.modelHash, settings: scene.settings, camera: scene.camera, sunDirection: scene.sunDirection, vrEnabled: host?.vrEnabled !== false }));
  const launch = (vr: boolean) => `@echo off\r\nstart "Archai Experience" "%~dp0Runtime\\ArchaiRender\\Binaries\\Win64\\${path.basename(executable)}" -ArchaiSession="%~dp0Scene" -ArchaiToken=${token} ${vr ? '-vr' : '-windowed'}\r\n`;
  await fs.writeFile(path.join(output, 'Open Scene.cmd'), launch(false));
  await fs.writeFile(path.join(output, 'Open in VR.cmd'), launch(true));
  await fs.writeFile(path.join(output, 'README.txt'), 'Archai Unreal experience\r\n\r\nKeep this whole folder together. Open Scene.cmd starts the desktop experience.\r\nDrag to orbit, right-drag to pan, wheel to zoom, F to frame. Click individual elements to select them.\r\nOpen in VR.cmd requests a compatible Windows PC OpenXR headset/runtime.\r\nNo Unreal Editor installation is needed. This is not a standalone Quest or browser build.\r\nLighting is real-time Unreal lighting, not baked lightmaps. Headset hardware validation remains required.\r\n');
  return output;
}
