import { _electron as electron, chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output = path.resolve(process.argv[2] || 'F:/Archai-Releases/0.3.0.10/folder-check');
await fs.mkdir(output, { recursive: true });
const installed = process.env.ARCHAI_VERIFY_APP;
const app = await electron.launch({ executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'),
  args: [...(installed ? [] : [process.cwd()]), '--user-data-dir='+path.join(output,'profile')], timeout: 60_000 });
let exported;
try {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, output);
  const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.__archai));
  const first = await page.evaluate(async () => {
    const api = window.__archai;
    const run = async (id,input) => { const r = await api.executor.dispatch(id,input); if (!r.ok) throw Error(r.error.message); return r.value; };
    await run('new-document',{name:'Default interactive folder'});
    const first = await run('create-arch-element',{tool:'column',x:0,y:0}); await run('rename',{id:first,name:'First column'});
    await run('create-arch-element',{tool:'column',x:2000,y:0});
    const view = await run('create-view3d'); await run('set-view3d-settings',{id:view,style:'shaded'}); await run('open-view3d',{id:view});
    return first;
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.getByRole('radio',{name:'View',exact:true}).click();
  await page.getByRole('button',{name:'Export interactive',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Export interactive scene'});
  await page.getByLabel('Export scope').selectOption('selected'); await dialog.getByLabel('First column',{exact:true}).check();
  await dialog.getByRole('button',{name:'Export interactive scene',exact:true}).click();
  await expect(dialog.getByText(/Interactive scene saved:/)).toBeVisible({timeout:120_000});
  exported = path.join(output,(await fs.readdir(output)).find(name=>name.startsWith('Archai-Experience-')));
  const manifest = JSON.parse(await fs.readFile(path.join(exported,'archai-experience.json'),'utf8'));
  assert.equal(manifest.delivery,'webxr'); assert.equal(manifest.sourceRenderer,'default'); assert.equal(manifest.style,'shaded');
  const glb = await fs.readFile(path.join(exported,'Scene/model.glb'));
  const data = JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString('utf8').trim());
  assert.deepEqual([...new Set(data.nodes.map(node=>node.extras?.archai?.id).filter(Boolean))],[first]);
  await fs.access(path.join(exported,'Open Scene.cmd')); assert.equal(await fs.access(path.join(exported,'Open in VR.cmd')).then(()=>true,()=>false),false);
  assert.equal(JSON.parse(await fs.readFile(path.join(exported,'Scene/scene.json'),'utf8')).vrEnabled,false);
} finally { await app.close(); }
const player = await electron.launch({ executablePath:path.join(exported,'Player/ArchaiPlayer.exe'),args:['--archai-verify','--user-data-dir='+path.join(output,'player-profile')],timeout:60_000 });
const browser = await chromium.launch({headless:true,channel:'chrome'});
try {
  const status = await player.firstWindow(); const url = await status.getByRole('link',{name:'Open scene',exact:true}).getAttribute('href');
  await expect(status.getByRole('link',{name:'Open VR entry'})).toHaveCount(0);
  const page = await browser.newPage(); await page.goto(url); await expect(page.getByRole('status')).toContainText('ready',{timeout:60_000});
  await expect(page.getByRole('button',{name:'Frame scene'})).toBeVisible();
  await page.screenshot({path:path.join(output,'portable-web-viewer.png')});
  await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,defaultRendererPreserved:true,selectedElementOnly:true,pcLauncher:true,guestHasNoVRLauncher:true,portablePlayerStarts:true,webViewerLoads:true,exported},null,2));
  console.log('Default renderer folder, selected element, guest desktop launcher and portable web player passed.');
} finally { await browser.close(); await player.close(); }
