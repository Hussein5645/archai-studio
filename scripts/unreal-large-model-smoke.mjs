import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {_electron as electron,expect} from '@playwright/test';
const output=path.resolve(process.argv[2]||'E:/Archai-UnrealSource/large-model-check');await fs.mkdir(output,{recursive:true});
const fixture=path.join(output,'million-triangle-sphere.glb');
const geometry=new THREE.SphereGeometry(5,1024,512).toNonIndexed();
const attributes=['position','normal','uv'].map(name=>geometry.getAttribute(name));
let offset=0;const views=attributes.map(attribute=>{const value={buffer:0,byteOffset:offset,byteLength:attribute.array.byteLength,target:34962};offset+=attribute.array.byteLength;return value;});
const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[.65,.65,.65,1],metallicFactor:0,roughnessFactor:.6}}],buffers:[{byteLength:offset}],bufferViews:views,accessors:attributes.map((a,i)=>({bufferView:i,componentType:5126,count:a.count,type:a.itemSize===3?'VEC3':'VEC2',...(i===0?{min:[-5,-5,-5],max:[5,5,5]}:{})}))};
const rawJson=Buffer.from(JSON.stringify(json)),jsonSize=Math.ceil(rawJson.length/4)*4;
const header=Buffer.alloc(20+jsonSize+8,32);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(header.length+offset,8);header.writeUInt32LE(jsonSize,12);header.writeUInt32LE(0x4e4f534a,16);rawJson.copy(header,20);header.writeUInt32LE(offset,20+jsonSize);header.writeUInt32LE(0x004e4942,24+jsonSize);
await fs.writeFile(fixture,Buffer.concat([header,...attributes.map(a=>Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength))]));
const triangles=attributes[0].count/3;geometry.dispose();
const installed=process.env.ARCHAI_VERIFY_APP;
const app=await electron.launch({executablePath:installed||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(installed?[]:[process.cwd()]),'--user-data-dir='+path.join(output,'profile')],env:{...process.env,...(!installed?{ARCHAI_RENDER_RUNTIME:process.env.ARCHAI_RENDER_RUNTIME||'F:/Archai-Releases/0.3.0.2/runtime-build/Packaged/Windows/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe'}:{}),ARCHAI_RENDER_CACHE:path.join(output,'sessions')},timeout:60000});
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.__archai));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},fixture);
 const imported=await page.evaluate(async()=>{
  const api=window.__archai;const catalog=api.executor.describe();if(!catalog.some(command=>command.id==='import-3d-model'))throw Error('Missing model importer');
  const run=async(id,input)=>{const r=await api.executor.dispatch(id,input);if(!r.ok)throw Error(r.error.message);return r.value;};
  await run('new-document',{name:'Million triangle native rendering check'});
  const start=performance.now();await run('import-3d-model',{x:0,y:0});return {ms:performance.now()-start};
 });
 const started=Date.now();
 const view=await page.evaluate(async()=>{
  const api=window.__archai;window.__largeHeartbeat={last:performance.now(),maximum:0};window.__largeTimer=setInterval(()=>{const h=window.__largeHeartbeat,now=performance.now();h.maximum=Math.max(h.maximum,now-h.last);h.last=now;},16);
  const live=api.platform.unreal.live;api.platform.unreal.live=scene=>{window.__largeMeshHashes=scene.nodes.map(node=>node.mesh);return live(scene);};
  await api.executor.dispatch('open-render-studio');const id=api.store.getState().ui.view3d.portalId;
  await api.executor.dispatch('set-view3d-settings',{id,style:'realistic'});return id;
 });
 const status=()=>page.evaluate(()=>window.__archai.platform.unreal.status());
 await expect.poll(async()=>{const state=await status();await fs.writeFile(path.join(output,'last-status.json'),JSON.stringify(state,null,2));if(state.state==='error')throw Error(state.error);return state.state==='ready'&&state.liveBridge&&state.meshActors>=16;},{timeout:300000}).toBe(true);
 const loaded=await status(),loadMs=Date.now()-started;
 const session=path.join(output,'sessions',(await fs.readdir(path.join(output,'sessions'))).find(name=>name.startsWith('session-')));
 const meshes=await page.evaluate(()=>window.__largeMeshHashes);
 const host=await app.evaluate(()=>({pid:process.pid,modules:process.report.getReport().sharedObjects}));
 const native=host.modules.some(file=>file.toLowerCase().endsWith('archaiembedded.dll'));
 if(native)assert.ok(!(await fs.readdir(session)).some(name=>name==='session.json'||name.endsWith('.mesh')),'Native geometry must stay on the memory bridge');
 let encodedTriangles=0,assetBytes=0,maximumAsset=0;
 for(const mesh of meshes){const buffer=await fs.readFile(path.join(output,'sessions/assets-v1','asset-'+mesh+'.mesh'));encodedTriangles+=buffer.readUInt32LE(8)/3;assetBytes+=buffer.length;maximumAsset=Math.max(maximumAsset,buffer.length);}
 assert.equal(encodedTriangles,triangles);assert.ok(maximumAsset<12*1024*1024);assert.ok(assetBytes>128*1024*1024,'Fixture should exercise batched upload');
 const heartbeat=await page.evaluate(()=>{clearInterval(window.__largeTimer);return window.__largeHeartbeat.maximum;});
 await fs.writeFile(path.join(output,'render.png'),new Uint8Array(await page.evaluate(async()=>Array.from(await window.__archai.platform.unreal.image({width:1280,height:800,quality:'high'})))));
 await page.getByRole('button',{name:'Back to Board'}).click();await expect(page.getByRole('button',{name:'Back to Board'})).toHaveCount(0,{timeout:30000});
 const reopen=Date.now();await page.evaluate(async id=>{await window.__archai.executor.dispatch('open-view3d',{id});},view);
 await expect.poll(async()=>{const state=await status();return state.state==='ready'&&state.meshActors===loaded.meshActors;},{timeout:30000}).toBe(true);
 assert.equal((await status()).meshesBuilt,loaded.meshesBuilt);
 await page.evaluate(async()=>{await window.__archai.platform.unreal.image({width:640,height:400,quality:'standard'});});
 const warmReopenMs=Date.now()-reopen;
 await page.getByRole('button',{name:'Back to Board'}).click();await expect(page.getByRole('button',{name:'Back to Board'})).toHaveCount(0,{timeout:30000});
 await page.evaluate(async()=>{const api=window.__archai;await api.platform.storage.set('native-restart-fixture',JSON.stringify(api.store.getState().doc));await api.platform.unreal.stop();});
 await page.reload();await page.waitForFunction(()=>Boolean(window.__archai));
 const coldStart=Date.now();
 await page.evaluate(async id=>{
  const api=window.__archai,doc=JSON.parse(await api.platform.storage.get('native-restart-fixture')),state=api.store.getState();
  api.store.setState({doc,ui:{...state.ui,screen:'board',selection:[],view3d:{...state.ui.view3d,open:false,portalId:null}}});
  const original=api.platform.unreal.live;window.__restoredAssetCount=0;
  api.platform.unreal.live=scene=>{window.__restoredAssetCount+=scene.assets.length;return original(scene);};
  await api.executor.dispatch('open-view3d',{id});
 },view);
 await expect.poll(async()=>{const state=await status();if(state.state==='error')throw Error(state.error);return state.state==='ready'&&state.meshActors===loaded.meshActors;},{timeout:180000}).toBe(true);
 const restoredAssetCount=await page.evaluate(()=>window.__restoredAssetCount);assert.equal(restoredAssetCount,0,'A fresh renderer must restore the saved snapshot without geometry encoding or upload');
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,hosting:native?'actual-unreal-library':'process',archaiProcess:host.pid,fixtureTriangles:triangles,renderedTriangles:encodedTriangles,sourceBytes:(await fs.stat(fixture)).size,encodedBytes:assetBytes,maximumAssetBytes:maximumAsset,nativeMeshActors:loaded.meshActors,importMs:imported.ms,loadMs,warmReopenMs,largestUiFrameGapMs:Math.round(heartbeat),retainedWithoutMeshRebuild:true,freshViewerFromDiskCacheMs:Date.now()-coldStart,restoredBinaryUploads:restoredAssetCount},null,2));
 console.log('Million-triangle import, bounded meshes, batched transfer, native rendering and warm reopening passed.');
}finally{await app.close();}
