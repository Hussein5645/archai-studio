import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('reviews representative saved linked geometry without opening or changing the project', async ({ page }) => {
  const project=process.env.ARCHAI_VISUAL_DOCUMENT;
  test.skip(!project,'Set ARCHAI_VISUAL_DOCUMENT for a local source-geometry review');
  test.setTimeout(180000);
  const folder=join(process.env.APPDATA!,'archai','storage');
  const read=(key:string):string=>{const r=JSON.parse(readFileSync(join(folder,key.replace(/[^A-Za-z0-9_.-]/g,'_')+'.json'),'utf8'));expect(r.key).toBe(key);const m='ARCHAI_CHUNKED_STORAGE_V1\n';return r.value.startsWith(m)?JSON.parse(r.value.slice(m.length)).map(read).join(''):r.value;};
  const doc=JSON.parse(read('doc:'+project));
  const all=(Object.values(doc.elements) as {x:number;y:number;meta?:{mesh?:{blobId:string}}}[]).filter(e=>e.meta?.mesh);
  const selected=[...all.slice(0,4),all.find(e=>doc.blobs[e.meta!.mesh!.blobId].data.length>10000000 || read('blob:'+project+':'+e.meta!.mesh!.blobId).length>10000000)].filter(Boolean) as typeof all;
  const packets=selected.map(e=>({data:doc.blobs[e.meta!.mesh!.blobId].data||read('blob:'+project+':'+e.meta!.mesh!.blobId),x:e.x,y:e.y}));
  mkdirSync('release/visual-review',{recursive:true});
  await page.route('**/__visual_meshes',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(packets)}));
  await page.goto('/');
  await page.evaluate(async()=>{
    const t='/node_modules/.vite/deps/three.js',v='/src/view3d/SceneView.ts',l='/node_modules/three/examples/jsm/loaders/GLTFLoader.js',ed='/src/view3d/edges.ts';
    const THREE=await import(t),{SceneView}=await import(v),{GLTFLoader}=await import(l),{prepareEdges}=await import(ed);
    const container=document.createElement('div');container.id='source-review';Object.assign(container.style,{position:'fixed',inset:'0',zIndex:'99999',background:'white'});document.body.append(container);
    const view=new SceneView(container,{onSelect:()=>{},onTransform:()=>{},onCameraChange:()=>{}});
    for(const packet of await(await fetch('/__visual_meshes')).json()){
      const bytes=Uint8Array.from(atob(packet.data),c=>c.charCodeAt(0));const root=(await new GLTFLoader().parseAsync(bytes.buffer,'')).scene;
      root.position.set(packet.x,0,packet.y);view.content.add(root);
    }
    const meshes: {geometry:unknown}[]=[];view.content.traverse((o:{isMesh?:boolean;geometry:unknown})=>{if(o.isMesh)meshes.push(o);});
    for(const mesh of meshes)await prepareEdges(mesh.geometry,[25]);
    const box=new THREE.Box3().setFromObject(view.content.children[view.content.children.length-1]),center=box.getCenter(new THREE.Vector3()),r=box.getSize(new THREE.Vector3()).length()/2;
    view.controls.target.copy(center);view.camera.position.copy(center).add(new THREE.Vector3(r,r*.8,r));view.camera.near=Math.max(1,r/10000);view.camera.far=r*10;view.camera.updateProjectionMatrix();view.orthoHalfHeight=r;view.fit();view.controls.update();
    Reflect.set(window,'__review',view);
  });
  for(const style of ['realistic','consistent','hidden-line','shaded','wireframe']){
    await page.evaluate(style=>{const v=Reflect.get(window,'__review');v.viewStyle=style;v.applyViewStyle();v.renderer.render(v.scene,v.camera);},style);
    await page.locator('#source-review').screenshot({path:`release/visual-review/linked-model-${style}.png`});
  }
  await page.evaluate(()=>{Reflect.get(window,'__review').dispose();document.querySelector('#source-review')?.remove();});
});
