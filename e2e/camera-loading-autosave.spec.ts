import { expect, test, type Page } from '@playwright/test';

async function camera(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const module = '/src/view3d/SceneView.ts';
    const { mountedViews } = await import(module);
    return mountedViews.get(id)?.getCamera();
  }, id);
}

test('pinned perspective cameras stay fixed and group navigation clears the 3D toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const run = async (name: string, input?: unknown) => {
      const result = await executor.dispatch(name, input);
      if (!result.ok) throw new Error(result.error.message);
      return String(result.value);
    };
    await run('new-document');
    const a = await run('create-rect', { x: 1500, y: 0, width: 500, height: 500, meta: { solid: { height: 1200 } } });
    const group = await run('group-selection', { ids: [a], name: 'Revit: Green Zone-Central model' });
    const portal = await run('create-camera-view', { a: [0, 0], b: [3000, 0] });
    const marker = (store.getState().doc.elements[portal]!.meta!['view3d'] as { cameraId: string }).cameraId;
    await run('select', { ids: [marker] });
    await run('toggle-lock');
    await run('open-view3d', { id: portal });
    return { portal, marker, group };
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await expect(page.getByTestId('view3d-toolbar').getByText('Camera pinned')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Frame all', exact: true })).toBeDisabled();
  const before = await camera(page, ids.portal);
  const canvas = page.getByTestId('view3d-workspace').locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  for (const button of ['left', 'right'] as const) {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down({ button });
    await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 45, { steps: 6 });
    await page.mouse.up({ button });
  }
  await page.mouse.wheel(0, 500);
  await canvas.focus();
  await page.keyboard.press('f');
  expect(await camera(page, ids.portal)).toEqual(before);
  await page.evaluate(async ({ group }) => { await window.__archai!.executor.dispatch('enter-group', { id: group }); }, ids);
  const groupBar = page.getByTestId('group-edit-bar');
  await expect(groupBar).toBeVisible();
  const groupBounds = (await groupBar.boundingBox())!;
  const toolbar = (await page.getByTestId('view3d-toolbar').boundingBox())!;
  expect(groupBounds.y).toBeGreaterThan(toolbar.y + toolbar.height);
  for (const panel of ['left-panel', 'inspector']) {
    const panelBounds = (await page.getByTestId(panel).boundingBox())!;
    expect(panelBounds.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  }
  await page.screenshot({ path: 'test-results/camera-pinned-toolbar.png' });
  await page.evaluate(async ({ marker }) => {
    await window.__archai!.executor.dispatch('exit-group', { all: true });
    await window.__archai!.executor.dispatch('select', { ids: [marker] });
    await window.__archai!.executor.dispatch('toggle-lock');
  }, ids);
  await expect(page.getByRole('button', { name: 'Frame all', exact: true })).toBeEnabled();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 45, { steps: 6 });
  await page.mouse.up();
  expect(await camera(page, ids.portal)).not.toEqual(before);
});

test('local autosave can be disabled and unsaved changes can be saved with one click', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('new-document', { name: 'Manual save test' }); });
  await page.keyboard.press('Control+,');
  const autosave = page.getByRole('radiogroup', { name: 'Autosave local projects', exact: true });
  await autosave.getByRole('radio', { name: 'Off', exact: true }).click();
  await page.getByTestId('settings-done').click();
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('rename-document', { name: 'Manual save changed' }); });
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes');
  await page.getByTestId('save-state').click();
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  expect(await page.evaluate(async () => {
    const { persistence, store } = window.__archai!;
    return (await persistence.loadStored(store.getState().doc.id))?.meta.name;
  })).toBe('Manual save changed');
});

test('3D opening paints a loader while resources prepare, and closing cancels safely', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('new-document');
    const module = '/src/view3d/assets.ts';
    const { modelStore } = await import(module);
    const prepare = modelStore.prepare.bind(modelStore);
    const gate = new Promise<void>((resolve) => { (window as unknown as { release3D: () => void }).release3D = resolve; });
    modelStore.prepare = async (doc: unknown) => { await gate; return prepare(doc); };
    await executor.dispatch('open-view3d');
  });
  await expect(page.getByTestId('view3d-loading')).toBeVisible();
  await expect(page.getByTestId('view3d-loading')).toContainText('Opening 3D view');
  await page.getByRole('button', { name: 'Close 3D workspace', exact: true }).click();
  await page.evaluate(() => (window as unknown as { release3D: () => void }).release3D());
  await expect(page.getByTestId('view3d-workspace')).toHaveCount(0);
  await expect(page.getByTestId('workboard')).toBeVisible();
});

test('dense imported mesh edges are prepared in a worker before the 3D canvas is revealed', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('edges.worker')) (window as unknown as { edgeWorkerStarted: boolean }).edgeWorkerStarted = true;
        if (String(url).includes('modelGeometry.worker')) (window as unknown as { modelWorkerStarted: boolean }).modelWorkerStarted = true;
      }
    };
  });
  const triangles = 22000;
  const bin = Buffer.alloc(triangles * 36);
  for (let i = 0; i < triangles; i++) {
    const x = i % 100 * 10, z = Math.floor(i / 100) * 10;
    [x, 0, z, x + 5, 0, z, x, 0, z + 5].forEach((value, j) => bin.writeFloatLE(value, i * 36 + j * 4));
  }
  const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: triangles * 3, type: 'VEC3', min: [0, 0, 0], max: [1000, 0, 2200] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 });
  const padded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4));
  const glb = Buffer.alloc(28 + padded.length + bin.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(glb, 28 + padded.length);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async (glb) => {
    const { executor } = window.__archai!;
    await executor.dispatch('new-document');
    const result = await executor.dispatch('create-mesh-element', { name: 'Dense mesh', glb, x: 0, y: 0, size: [1000, 2200, 10] });
    if (!result.ok) throw new Error(result.error.message);
    await executor.dispatch('open-view3d');
  }, glb.toString('base64'));
  await expect(page.getByTestId('view3d-workspace')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { edgeWorkerStarted: boolean }).edgeWorkerStarted)).toBe(true);
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await expect(page.getByTestId('view3d-workspace').locator('canvas')).toBeVisible();
  await page.evaluate(async () => {
    const {store,executor}=window.__archai!;
    const element=(Object.values(store.getState().doc.elements) as {id:string;name?:string}[]).find(element=>element.name==='Dense mesh')!;
    const result=await executor.dispatch('auto-repair-group-normals',{ids:[element.id]});
    if (!result.ok) throw new Error(result.error.message);
  });
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {modelWorkerStarted:boolean}).modelWorkerStarted)).toBe(true);
  await expect(page.getByTestId('view3d-updating')).toHaveCount(0);
});


test('model updates run in a worker, keep the old scene usable and cancel stale results', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const {executor} = window.__archai!;
    await executor.dispatch('new-document');
    const rect = await executor.dispatch('create-rect', {x:0,y:0,width:500,height:500,meta:{solid:{height:500}}});
    const camera = await executor.dispatch('create-camera-view', {a:[-2000,0],b:[0,0]});
    if (!rect.ok || !camera.ok) throw new Error('Fixture failed');
    await executor.dispatch('open-view3d',{id:camera.value});
    return {rect:String(rect.value),portal:String(camera.value)};
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.evaluate(async ({rect,portal}) => {
    const module='/src/view3d/SceneView.ts';
    const {mountedViews}=await import(module);
    const view=mountedViews.get(portal);
    const state=window as unknown as {oldObject:unknown;workerStarts:number;workerStops:number;releaseGeometry:()=>void};
    state.oldObject=view.built.find((item:{id:string})=>item.id===rect).object;
    state.workerStarts=0;state.workerStops=0;
    const Native=window.Worker;
    window.Worker=class extends Native {
      private model:boolean;
      constructor(url:string|URL,options?:WorkerOptions){super(url,options);this.model=String(url).includes('modelGeometry.worker');if(this.model)state.workerStarts++;}
      postMessage(data:unknown, transfer:Transferable[] | StructuredSerializeOptions = []) {
        const send=()=>{if(Array.isArray(transfer))super.postMessage(data,transfer);else super.postMessage(data,transfer);};
        if(this.model){state.releaseGeometry=send;}else send();
      }
      terminate(){if(this.model)state.workerStops++;super.terminate();}
    };
    const points=Array.from({length:128},(_,i)=>[Math.cos(i/128*Math.PI*2)*1000,Math.sin(i/128*Math.PI*2)*1000]);
    await window.__archai!.executor.dispatch('create-line',{points,closed:true,style:{fill:'#6688aa'},meta:{solid:{height:500}}});
  },ids);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {workerStarts:number}).workerStarts)).toBe(1);
  await expect(page.getByTestId('view3d-updating')).toBeVisible();
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Frame all',exact:true})).toBeEnabled();
  expect(await page.evaluate(async ({rect,portal})=>{
    const module='/src/view3d/SceneView.ts';const {mountedViews}=await import(module);
    return mountedViews.get(portal).built.find((item:{id:string})=>item.id===rect).object===(window as unknown as {oldObject:unknown}).oldObject;
  },ids)).toBe(true);
  await page.evaluate(async ({rect})=>{await window.__archai!.executor.dispatch('move-selection',{ids:[rect],dx:100,dy:0});},ids);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {workerStarts:number}).workerStarts)).toBe(2);
  expect(await page.evaluate(()=>(window as unknown as {workerStops:number}).workerStops)).toBeGreaterThan(0);
  await page.evaluate(()=>(window as unknown as {releaseGeometry:()=>void}).releaseGeometry());
  await expect(page.getByTestId('view3d-updating')).toHaveCount(0);
  expect(await page.evaluate(async ({rect,portal})=>{
    const module='/src/view3d/SceneView.ts';const {mountedViews}=await import(module);
    const view=mountedViews.get(portal);
    return {x:view.doc.elements[rect].x,count:view.built.length};
  },ids)).toMatchObject({x:100});
});

for (const take of ['Take source for all','Keep ArchAI for all']) test('conflict window: '+take,async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.__archai));
  await page.evaluate(async()=>{
    const {executor,store}=window.__archai!;
    const run=async(id:string,input?:unknown)=>{const r=await executor.dispatch(id,input);if(!r.ok)throw new Error(r.error.message);return r.value;};
    await run('new-document');
    const model=(name:string)=>({archaiRevit:1,app:'Rhino',name:'House',materials:[],walls:[],openings:[],meshes:['a','b'].map(id=>({id,name,category:'Generic',origin:[0,0,0],size:[500,500,900],glb:'AAAA'}))});
    await run('bridge-sync',{key:'batch',app:'Rhino',name:'House',model:model('Original')});
    await run('bridge-set-source',{key:'batch',authority:{metadata:'shared'}});
    const ids=Object.keys(store.getState().doc.bridge!.elements);
    for(const id of ids)await run('rename',{id,name:'Mine'});
    await run('bridge-sync',{key:'batch',app:'Rhino',name:'House',model:model('Theirs')});
  });
  await page.getByTestId('live-link-chip').click();
  const bulk=page.getByTestId('bridge-conflict-bulk');
  await expect(bulk).toContainText('Resolve all 2 conflicts');
  await bulk.getByRole('button',{name:'Select all conflicts',exact:true}).click();
  expect(await page.evaluate(()=>window.__archai!.store.getState().ui.selection.length)).toBe(2);
  await bulk.getByRole('button',{name:take,exact:true}).click();
  await expect(bulk).toHaveCount(0);
  expect(await page.evaluate(()=>window.__archai!.store.getState().doc.bridge!.conflicts.length)).toBe(0);
  await page.evaluate(async()=>{await window.__archai!.executor.dispatch('undo');});
  await expect(bulk).toContainText('Resolve all 2 conflicts');
});
