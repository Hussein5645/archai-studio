import { expect, test } from '@playwright/test';
test('feature edges render at every hardware instance without shader errors',async({page})=>{
  const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto('/');
  const counts=await page.evaluate(async()=>{
    const p='/node_modules/.vite/deps/three.js',d='/src/view3d/displayMaterials.ts';const T=await import(p),{featureEdgeObject}=await import(d);
    const renderer=new T.WebGLRenderer();renderer.setSize(128,64);const target=new T.WebGLRenderTarget(128,64);renderer.setRenderTarget(target);renderer.setClearColor('#ffffff');
    const mesh=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial(),2);mesh.setMatrixAt(0,new T.Matrix4().makeTranslation(-2,0,0));mesh.setMatrixAt(1,new T.Matrix4().makeTranslation(2,0,0));
    const geometry=new T.EdgesGeometry(mesh.geometry),edges=featureEdgeObject(mesh,geometry,{color:'#000000',opacity:1});const scene=new T.Scene();scene.add(edges);
    const camera=new T.OrthographicCamera(-4,4,2,-2,.1,100);camera.position.set(0,3,8);camera.lookAt(0,0,0);renderer.render(scene,camera);
    const pixels=new Uint8Array(128*64*4);renderer.readRenderTargetPixels(target,0,0,128,64,pixels);const halves:[number,number]=[0,0];for(let y=0;y<64;y++)for(let x=0;x<128;x++)if(pixels[(y*128+x)*4]!<128)halves[x<64?0:1]++;
    edges.geometry.dispose();edges.material.dispose();geometry.dispose();mesh.geometry.dispose();mesh.material.dispose();target.dispose();renderer.dispose();return halves;
  });
  expect(counts[0]).toBeGreaterThan(10);expect(counts[1]).toBeGreaterThan(10);expect(errors).toEqual([]);
});
