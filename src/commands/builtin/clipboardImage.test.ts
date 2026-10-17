import { afterEach, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { bytesToBase64 } from '@/persistence/base64';

afterEach(() => vi.unstubAllGlobals());
const png = new Uint8Array([137,80,78,71,13,10,26,10]);

it('copies image pixels and editable element data together and saves original bytes', async () => {
  const app = createTestApp();
  const id = run<string>(app, 'create-image', { x:0,y:0,name:'Reference.png',blob:{mime:'image/png',data:bytesToBase64(png),width:32,height:16} });
  run(app,'select',{ids:[id]});
  const writeImage = vi.fn(async () => {});
  app.platform.clipboard.writeImage = writeImage;
  expect((await app.executor.dispatch('copy-selection')).ok).toBe(true);
  expect(writeImage.mock.calls[0]).toEqual([{name:'Reference.png',mime:'image/png',bytes:png},expect.stringContaining('archai/elements')]);
  expect((await app.executor.dispatch('save-image')).ok).toBe(true);
  expect(app.platform.savedBinaries[0]).toEqual({bytes:png,name:'Reference.png',mime:'image/png'});
});

it('pastes an external image in one undo step instead of falling back to old copied elements', async () => {
  const app = createTestApp();
  const rect=run<string>(app,'create-rect',{x:0,y:0});
  run(app,'select',{ids:[rect]});await app.executor.dispatch('copy-selection');
  app.platform.clipboardText='';
  app.platform.clipboard.readImage=async()=>({name:'Screenshot.png',mime:'image/png',bytes:png});
  const close=vi.fn();
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:32,height:16,close})));
  const result=await app.executor.dispatch('paste');
  expect(result.ok).toBe(true);
  expect(Object.values(app.store.getState().doc.elements).filter(e=>e.kind==='image')).toHaveLength(1);
  expect(close).toHaveBeenCalledOnce();
  app.executor.undo();
  expect(Object.values(app.store.getState().doc.elements).filter(e=>e.kind==='image')).toHaveLength(0);
});

it('does not insert an image into a different project if decoding finishes late', async () => {
  const app=createTestApp();let release!:()=>void;
  vi.stubGlobal('createImageBitmap',()=>new Promise(resolve=>{release=()=>resolve({width:32,height:16,close:()=>{}});}));
  const pending=app.executor.dispatch('paste-image',{data:bytesToBase64(png),mime:'image/png'});
  run(app,'new-document');release();
  expect((await pending).ok).toBe(false);
  expect(Object.keys(app.store.getState().doc.elements)).toHaveLength(0);
});
