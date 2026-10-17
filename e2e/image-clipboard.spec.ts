import {test,expect} from '@playwright/test';

test('board image clipboard, original-file saving and visible version',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.__archai));
  await page.evaluate(async()=>{await window.__archai!.executor.dispatch('new-document');});
  await expect(page.getByTestId('app-version')).toHaveText('v0.2.2.31');
  const image=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=16;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#e09020';ctx.fillRect(0,0,32,16);
    const data=canvas.toDataURL('image/png').split(',')[1]!;
    const result=await window.__archai!.executor.dispatch('paste-image',{data,mime:'image/png',name:'Screenshot.png',x:600,y:350});
    if(!result.ok)throw new Error(result.error.message);
    return {id:String(result.value),data};
  });
  await page.getByTestId('workboard').focus();
  await page.keyboard.press('Control+c');
  await expect.poll(()=>page.evaluate(async()=>{
    const items=await navigator.clipboard.read();return items.flatMap(item=>item.types).sort();
  })).toEqual(['image/png','text/plain']);
  await page.keyboard.press('Control+v');
  await expect.poll(()=>page.evaluate(()=>(Object.values(window.__archai!.store.getState().doc.elements) as {kind:string}[]).filter(e=>e.kind==='image').length)).toBe(2);
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=24;
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  });
  await page.getByTestId('workboard').focus();await page.keyboard.press('Control+v');
  await expect.poll(()=>page.evaluate(()=>(Object.values(window.__archai!.store.getState().doc.elements) as {kind:string}[]).filter(e=>e.kind==='image').length)).toBe(3);
  await page.evaluate(async()=>{await window.__archai!.executor.dispatch('undo');});
  await expect.poll(()=>page.evaluate(()=>(Object.values(window.__archai!.store.getState().doc.elements) as {kind:string}[]).filter(e=>e.kind==='image').length)).toBe(2);
  await page.evaluate(async id=>{await window.__archai!.executor.dispatch('select',{ids:[id]});},image.id);
  const download=page.waitForEvent('download');
  await page.evaluate(async()=>{const r=await window.__archai!.executor.dispatch('save-image');if(!r.ok)throw new Error(r.error.message);});
  const file=await download;expect(file.suggestedFilename()).toBe('Screenshot.png');
  const stream=await file.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('base64')).toBe(image.data);
  const bounds=(await page.locator(`[data-element-id="${image.id}"]`).first().boundingBox())!;
  await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2,{button:'right'});
  await expect(page.getByRole('menuitem',{name:'Copy image',exact:true})).toBeVisible();
  await expect(page.getByRole('menuitem',{name:'Save image…',exact:true})).toBeVisible();
});
