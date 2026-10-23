import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron,expect} from '@playwright/test';

// Exercises the real engine library. The small host-verification DLL cannot satisfy this test.
const output=path.resolve(process.argv[2]||'E:/Archai-UnrealSource/native-render-check');
const installed=process.env.ARCHAI_VERIFY_APP;
const library=process.env.ARCHAI_UNREAL_LIBRARY||(installed?path.join(path.dirname(installed),'resources/unreal/ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll'):undefined);
assert.ok(library,'Set ARCHAI_UNREAL_LIBRARY to the built Unreal DLL');
await fs.access(library);
await fs.mkdir(output,{recursive:true});
const app=await electron.launch({executablePath:installed||path.resolve('node_modules/electron/dist/electron.exe'),
 args:[...(installed?[]:[process.cwd()]),'--user-data-dir='+path.join(output,'profile')],
 env:{...process.env,ARCHAI_RENDER_CACHE:path.join(output,'sessions')},timeout:60000});
let closed=false;
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.__archai));
 const initial=await page.evaluate(async()=>{
  const api=window.__archai,catalog=api.executor.describe();
  for(const id of ['new-document','create-arch-element','open-render-studio'])
   if(!catalog.some(command=>command.id===id))throw Error('Missing command '+id);
  const run=async(id,input)=>{const result=await api.executor.dispatch(id,input);if(!result.ok)throw Error(result.error.message);return result.value;};
  await run('new-document',{name:'In-process Unreal verification'});
  const columns=[];for(let i=0;i<30;i++)columns.push(await run('create-arch-element',{tool:'column',x:i%6*2000,y:Math.floor(i/6)*2000}));
  await run('create-light',{kind:'point',x:0,y:0});
  await run('create-light',{kind:'spot',x:2000,y:0,target:[0,0]});
  await run('create-light',{kind:'area',x:4000,y:0});
  await run('open-render-studio');const view=api.store.getState().ui.view3d.portalId;
  await run('set-view3d-settings',{id:view,style:'realistic'});return {view,columns};
 });
 const status=()=>page.evaluate(()=>window.__archai.platform.unreal.status());
 const wait=async predicate=>expect.poll(async()=>{
  const state=await status();await fs.writeFile(path.join(output,'last-status.json'),JSON.stringify(state,null,2));
  if(state.state==='error')throw Error(state.error);return predicate(state);
 },{timeout:240000}).toBe(true);
 const start=Date.now();await wait(state=>state.state==='ready'&&state.liveBridge&&state.embedded&&state.meshActors>=30);
 const first=await status(),firstLoadMs=Date.now()-start;
 assert.equal(first.sceneImports,0);assert.equal(first.customLights,3);
 const sessions=await fs.readdir(path.join(output,'sessions'));
 const active=sessions.find(name=>name.startsWith('session-'));assert.ok(active);
 const sessionFiles=await fs.readdir(path.join(output,'sessions',active));
 assert.ok(!sessionFiles.some(name=>name.endsWith('.mesh')||name.endsWith('.glb')||name==='session.json'),'Live native geometry must enter through memory, not session files');
 const host=await app.evaluate(()=>({pid:process.pid,modules:process.report.getReport().sharedObjects}));
 assert.ok(host.modules.some(file=>path.resolve(file).toLowerCase()===path.resolve(library).toLowerCase()),'Actual Unreal library must be loaded inside the Archai main process');
 const image=async name=>fs.writeFile(path.join(output,name),new Uint8Array(await page.evaluate(async()=>Array.from(await window.__archai.platform.unreal.image({width:1280,height:800,quality:'high'})))));
 await image('render.png');
 const bytes=await fs.readFile(path.join(output,'render.png'));assert.equal(bytes.readUInt32BE(0),0x89504e47);assert.ok(bytes.length>10000,'Expected a rendered scene');
 await page.getByRole('radio',{name:'View',exact:true}).click();await page.getByLabel('View exposure').fill('1');
 await wait(state=>state.state==='ready'&&state.exposure===1&&state.revision>first.revision);
 const exposure=await status();assert.equal(exposure.meshesBuilt,first.meshesBuilt);
 await page.getByRole('button',{name:'Back to Board'}).click();await expect(page.getByRole('button',{name:'Back to Board'})).toHaveCount(0,{timeout:30000});
 const reopen=Date.now();await page.evaluate(async id=>{await window.__archai.executor.dispatch('open-view3d',{id});},initial.view);
 await wait(state=>state.state==='ready'&&state.meshActors===first.meshActors);await image('reopened.png');
 assert.equal((await status()).meshesBuilt,first.meshesBuilt);
 const warmReopenMs=Date.now()-reopen;
 await page.evaluate(async()=>{await window.__archai.platform.unreal.stop();});
 // A stopped view can use the same initialized library for a new session.
 await page.getByRole('button',{name:'Back to Board'}).click();await expect(page.getByRole('button',{name:'Back to Board'})).toHaveCount(0,{timeout:30000});
 await page.evaluate(async id=>{await window.__archai.executor.dispatch('open-view3d',{id});},initial.view);
 await wait(state=>state.state==='ready'&&state.meshActors===first.meshActors);await image('new-session.png');
 await app.close();closed=true;
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,hosting:'actual-unreal-library',archaiProcess:host.pid,library,firstLoadMs,warmReopenMs,meshActors:first.meshActors,lights:first.customLights,sceneImports:first.sceneImports,exposureWithoutMeshRebuild:true,sessionReuse:true,shutdown:true},null,2));
 console.log('Real Unreal library rendering, image, exposure, retention, session reuse and shutdown passed.');
}finally{if(!closed)await app.close();}
