import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {_electron as electron,expect} from '@playwright/test';
const output=path.resolve(process.argv[2]);await fs.mkdir(output,{recursive:true});
const installed=process.env.ARCHAI_VERIFY_APP;
const app=await electron.launch({executablePath:installed||path.resolve('node_modules/electron/dist/electron.exe'),
 args:[...(installed?[]:[process.cwd()]),'--user-data-dir='+path.join(output,'profile')],env:{...process.env,ARCHAI_RENDER_CACHE:path.join(output,'sessions')},timeout:60000});
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.__archai));
 await page.evaluate(async()=>{
  const api=window.__archai,catalog=api.executor.describe();
  for(const id of ['new-document','create-arch-element','open-render-studio','set-tool'])if(!catalog.some(command=>command.id===id))throw Error('Missing '+id);
  const run=async(id,input)=>{const r=await api.executor.dispatch(id,input);if(!r.ok)throw Error(r.error.message);return r.value;};
  await run('new-document',{name:'Native input verification'});
  await run('create-arch-element',{tool:'column',x:-2000,y:0});await run('create-arch-element',{tool:'column',x:2000,y:0});
  await run('open-render-studio');await run('set-view3d-settings',{id:api.store.getState().ui.view3d.portalId,style:'realistic'});
 });
 const read=()=>page.evaluate(async()=>({status:await window.__archai.platform.unreal.status(),selection:window.__archai.store.getState().ui.selection,
  columns:Object.values(window.__archai.store.getState().doc.elements).filter(e=>e.meta?.arch?.type==='column').length}));
 await expect.poll(async()=>{const s=await read();if(s.status.state==='error')throw Error(s.status.error);return s.status.state==='ready'&&s.status.meshActors===12;},{timeout:120000}).toBe(true);
 const before=await read();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setTitle('Archai native input verification'));
 await fs.writeFile(path.join(output,'input-ready.json'),JSON.stringify(before,null,2));
 let placing=false,picked='';const deadline=Date.now()+600000;
 while(!await fs.access(path.join(output,'input-done')).then(()=>true).catch(()=>false)){
  if(Date.now()>deadline)throw Error('Native input check timed out');
  if(!placing&&await fs.access(path.join(output,'place-request')).then(()=>true).catch(()=>false)){
   await page.evaluate(async()=>{const r=await window.__archai.executor.dispatch('set-tool',{tool:'arch:column'});if(!r.ok)throw Error(r.error.message);});placing=true;
  }
  const native=await app.evaluate(()=>{const file=process.env.ARCHAI_UNREAL_NATIVE_HOST||process.resourcesPath+'/unreal-native/archai_unreal_host.node';const addon=process.getBuiltinModule('module').createRequire(file)(file);return {...addon.state(),report:JSON.parse(addon.status())};});
  const current=await read();if(current.status.selectedObject&&current.selection.includes(current.status.selectedObject))picked=current.status.selectedObject;
  await fs.writeFile(path.join(output,'input-state.json'),JSON.stringify({placing,picked,native,...current},null,2));await delay(400);
 }
 const after=await read();
 assert.ok(after.status.selectionSequence>before.status.selectionSequence,'Native pointer selection must reach Archai');
 assert.ok(picked,'A picked native object must select the corresponding Archai element');
 assert.notDeepEqual(after.status.viewCamera,before.status.viewCamera,'Native orbit must move the camera');
 assert.equal(after.columns,3,'A native viewport click must add an Archai column');
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,nativeSelection:picked,nativeOrbit:true,nativePlacement:true,before,after},null,2));
 console.log('Actual native pointer selection, orbit and direct element placement passed.');
}finally{await app.close();}
