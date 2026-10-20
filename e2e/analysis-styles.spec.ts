import { expect, test } from '@playwright/test';
import type { Element } from '../src/document';

test('sun, wind and noise keep their heat-map colours across all view styles', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const threePath = '/node_modules/.vite/deps/three.js';
    const analysisPath = '/src/analysis/layer3d.ts';
    const THREE = await import(threePath);
    const { AnalysisLayer } = await import(analysisPath);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(128, 128);
    const scene = new THREE.Scene();
    const content = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4000, 2000, 4000), new THREE.MeshStandardMaterial({ color: '#ff00ff' }));
    mesh.position.y = 1000;
    content.add(mesh); scene.add(content);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 3));
    const container = document.createElement('div'); document.body.append(container);
    const layer = new AnalysisLayer({ renderer, scene, content, container, helpers: () => [] });
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
    camera.position.set(5000, 7000, 7000); camera.lookAt(0, 1000, 0); camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(128, 128);
    const values = [];
    try {
      for (const spec of [
        { kind: 'sun', display: 'sun-hours', current: [0, 1, 0], samples: [{ dir: [0, 1, 0], hours: 6 }], title: 'Sun hours' },
        { kind: 'sun', display: 'shadows', current: [0, 1, 0], samples: [], title: 'Sun shadows' },
        { kind: 'wind', flow: [1, 0], speed: 3, height: 1500, title: 'Wind' },
        { kind: 'noise', emitters: [{ id: 'area', x: 0, y: 1000, z: 0, level: 85, area: { u: [3000, 0], v: [0, 2000] } }], min: 35, max: 90, barrier: 0, receiverHeight: 1500, title: 'Noise' },
      ]) {
        layer.set(spec); layer.ensureReady();
        // Freeze the already-prepared wind field so palette comparisons use identical values.
        layer.advanceWind = () => {};
        const pixels = [];
        for (const style of ['consistent', 'realistic', 'shaded', 'hidden-line', 'wireframe']) {
          renderer.toneMapping = style === 'realistic' || style === 'shaded' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
          renderer.toneMappingExposure = style === 'realistic' ? 1.7 : 1;
          renderer.setRenderTarget(target);
          layer.render(camera, style);
          const pixel = new Uint8Array(4);
          renderer.readRenderTargetPixels(target, 64, 64, 1, 1, pixel);
          pixels.push({ style, rgba: [...pixel] });
        }
        values.push({ kind: spec.kind, display: spec.display, pixels });
      }
      const receiver = layer.sampleValues(1000, null).find((sample: { x: number; y: number; z: number }) => sample.x > 3000 && sample.y > 3000 && Math.abs(sample.z - 2) < 1);
      if (!receiver) throw new Error('Missing ground noise sample');
      let energy = 0;
      for (const u of [-2 / 3, 0, 2 / 3]) for (const v of [-2 / 3, 0, 2 / 3]) {
        const distance = Math.max(1, Math.hypot(receiver.x - 3000 * u, 1502 - 1000, receiver.y - 2000 * v) / 1000);
        energy += Math.pow(10, (85 - 20 * Math.log10(distance)) / 10) / 9;
      }
      if (Math.abs(receiver.value - 10 * Math.log10(energy)) > 0.01) throw new Error('Area noise energy or attenuation is incorrect');
      return values;
    } finally {
      layer.dispose(); target.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); renderer.dispose(); container.remove();
    }
  });
  for (const result of results) {
    const reference = result.pixels[0]!.rgba;
    expect(reference[3]).toBe(255);
    expect(reference.slice(0, 3).some(value => value > 0)).toBe(true);
    for (const pixel of result.pixels) expect(pixel.rgba, `${result.kind}/${result.display}/${pixel.style}`).toEqual(reference);
  }
  expect(errors).toEqual([]);
});

test('draws and edits an area emitter without replacing point emitters', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    await executor.dispatch('set-viewport', { x: 100, y: 80, zoom: 0.1 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
    const origin = await executor.dispatch('create-analysis-origin', { kind: 'noise' });
    await executor.dispatch('select', { ids: [origin.value] });
    await executor.dispatch('create-noise-emitter', { originId: origin.value, x: -1000, y: -1000 });
  });
  await page.getByRole('button', { name: 'Draw area emitter', exact: true }).click();
  const box = (await page.getByTestId('workboard').boundingBox())!;
  await page.mouse.move(box.x + 650, box.y + 450);
  await page.mouse.down();
  await page.mouse.move(box.x + 350, box.y + 250, { steps: 5 });
  await page.mouse.up();
  const emitters = await page.evaluate(() => Object.values<Element>(window.__archai!.store.getState().doc.elements).filter(e => e.meta?.noiseEmitter));
  expect(emitters).toHaveLength(2);
  const area = emitters.find(e => (e.meta!.noiseEmitter as { shape: string }).shape === 'area')!;
  expect(area).toMatchObject({ width: 3000, height: 2000, x: 2500, y: 1700 });
  await page.keyboard.press('Escape');
  await page.evaluate(id => window.__archai!.executor.dispatch('select', { ids: [id] }), area.id);
  await expect(page.getByLabel('Emitter area width', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Emitter area depth', { exact: true })).toBeVisible();
});

test('sun edges have fractional display coverage while exported hours stay sampled', async ({ page }) => {
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const t='/node_modules/.vite/deps/three.js',a='/src/analysis/layer3d.ts';const T=await import(t),{AnalysisLayer}=await import(a);
    const renderer=new T.WebGLRenderer();renderer.setSize(256,256);renderer.capabilities.maxTextureSize=128;
    const scene=new T.Scene(),content=new T.Group();scene.add(content);
    const mesh=new T.Mesh(new T.BoxGeometry(2000,1000,2000),new T.MeshBasicMaterial());mesh.position.y=500;content.add(mesh);
    const container=document.createElement('div');document.body.append(container);
    const layer=new AnalysisLayer({renderer,scene,content,container,helpers:()=>[]});
    layer.set({kind:'sun',display:'sun-hours',current:[.7,1,.3],samples:[{dir:[.7,1,.3],hours:6}],title:'Sun'});layer.ensureReady();
    const camera=new T.OrthographicCamera(-1600,1600,1600,-1600,1,20000);camera.position.set(0,10000,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const target=new T.WebGLRenderTarget(256,256);renderer.setRenderTarget(target);layer.render(camera,'realistic');
    const pixels=new Uint8Array(256*256*4);renderer.readRenderTargetPixels(target,0,0,256,256,pixels);
    let intermediate=0;for(let i=0;i<pixels.length;i+=4){const r=pixels[i]!,g=pixels[i+1]!,b=pixels[i+2]!;if(g>90&&g>r&&g>b)intermediate++;}
    const values=layer.sampleValues(100,null).map((s:{value:number})=>s.value);
    layer.dispose();target.dispose();mesh.geometry.dispose();mesh.material.dispose();renderer.dispose();container.remove();return{intermediate,values};
  });
  expect(result.intermediate).toBeGreaterThan(10);
  expect(result.values.length).toBeGreaterThan(20);
  expect(result.values.every((value:number)=>value===0||value===6)).toBe(true);
  expect(result.values).toContain(0);expect(result.values).toContain(6);
});
