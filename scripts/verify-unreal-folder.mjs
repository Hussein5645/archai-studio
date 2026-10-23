import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);await fs.mkdir(output,{recursive:true});
const metadata=JSON.parse(await fs.readFile(path.join(root,'archai-experience.json'),'utf8'));
assert.equal(metadata.delivery,'unreal');assert.equal(metadata.sourceRenderer,'unreal');
const scene=path.join(root,'Scene'),ticket=JSON.parse(await fs.readFile(path.join(scene,'session.json'),'utf8'));
const executable=path.join(root,'Runtime/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe');
assert.equal(await fs.access(path.join(path.dirname(executable),'ArchaiEmbedded.dll')).then(()=>true).catch(()=>false),false,'The standalone export must not copy the authoring library');
await fs.access(path.join(root,'Open Scene.cmd'));await fs.access(path.join(root,'Open in VR.cmd'));
const capture=path.join(output,'render.png');
const child=spawn(executable,[`-ArchaiSession=${scene}`,`-ArchaiToken=${ticket.token}`,'-RenderOffscreen','-NoHMD','-unattended','-nosplash','-ResX=1280','-ResY=800',`-abslog=${path.join(output,'player.log')}`,`-ArchaiCapture=${capture}`],{windowsHide:true,stdio:'ignore'});
try{
 const deadline=Date.now()+180000;let report;
 while(true){
  report=await fs.readFile(path.join(scene,'status.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(report?.state==='error')throw Error(report.error);
  if(report?.state==='ready'&&await fs.stat(capture).then(file=>file.size>1000).catch(()=>false))break;
  if(Date.now()>deadline||child.exitCode!==null)throw Error('Exported Unreal player did not render');await delay(300);
 }
 assert.ok(report.meshActors>0);assert.equal(report.meshActors,report.identityMappedActors);
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({success:true,rendered:true,pcAndVrLaunchers:true,noAuthoringLibrary:true,renderer:metadata.sourceRenderer,lighting:metadata.lighting,meshActors:report.meshActors,identityMappedActors:report.identityMappedActors,executable},null,2));
 console.log('Exported Unreal folder rendered with its own player and preserved object identities.');
}finally{child.kill();}
