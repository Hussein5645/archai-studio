import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { validateLiveMesh } from '@shared/unrealLive';
import { encodeLiveMesh, liveGeometryKey, UnrealLiveSceneBuilder } from './unrealLiveScene';
import { defaultSettings } from './settings';

describe('direct Unreal scene data', () => {
  it('does not serialize model blobs when checking a warm geometry identity',()=>{
    const app=createTestApp(),doc=app.store.getState().doc;
    let serializations=0;
    const blobs={...doc.blobs};Object.defineProperty(blobs,'toJSON',{value:()=>{serializations++;return {};}});
    const source={...doc,blobs};
    expect(liveGeometryKey(source,'realistic')).toBe(liveGeometryKey({...source,meta:{...source.meta,name:'Changed title'}},'realistic'));
    expect(serializations).toBe(0);
  });
  it('encodes a large indexed mesh with compact vertex remapping and round-trips its positions',()=>{
    const geometry=new THREE.PlaneGeometry(10,10,256,128);
    const bytes=encodeLiveMesh(geometry,0,geometry.index!.count);
    validateLiveMesh(bytes);
    const header=new DataView(bytes.buffer),vertices=header.getUint32(4,true);
    expect(vertices).toBe(geometry.getAttribute('position').count);
    for(const index of [0,1,2,100001,geometry.index!.count-1]){
      const encoded=header.getUint32(16+vertices*48+index*4,true),original=geometry.index!.getX(index);
      expect(header.getFloat32(16+encoded*48,true)).toBe(geometry.getAttribute('position').getX(original));
      expect(header.getFloat32(20+encoded*48,true)).toBe(geometry.getAttribute('position').getY(original));
    }
    geometry.dispose();
  });
  it('restores prepared geometry from storage without rebuilding or uploading meshes', async () => {
    const app = createTestApp();
    run(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const doc = app.store.getState().doc, settings = defaultSettings();
    const first = new UnrealLiveSceneBuilder(app.platform.storage,'unreal-cache-test');
    const scene = await first.build(doc,app.catalog,'realistic',settings,undefined,()=>{});
    first.acknowledge(scene);
    await Promise.resolve();
    const reopened = new UnrealLiveSceneBuilder(app.platform.storage,'unreal-cache-test');
    const stages:string[]=[];
    const cached=await reopened.build(doc,app.catalog,'realistic',settings,undefined,stage=>stages.push(stage));
    expect(cached.nodes).toEqual(scene.nodes);
    expect(cached.assets).toHaveLength(0);
    expect(stages).toContain('Restoring saved Unreal geometry…');
    reopened.invalidateCached();
    expect((await reopened.build(doc,app.catalog,'realistic',settings,undefined,()=>{})).assets.length).toBeGreaterThan(0);
  });
  it('shares mesh sections despite world-aligned UV offsets and excludes unused vertices', () => {
    const a = new THREE.BoxGeometry(2, 3, 4), b = a.clone();
    const uv = b.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + 2000, uv.getY(i) + 1000);
    const first = encodeLiveMesh(a, 0, 6), second = encodeLiveMesh(b, 0, 6, new THREE.Vector2(2000, 1000));
    expect(second).toEqual(first);
    expect(new DataView(first.buffer).getUint32(4, true)).toBe(4);
    a.dispose(); b.dispose();
  });
  it('encodes indexed and non-indexed mesh sections with normals, UVs and colours', () => {
    for (const geometry of [new THREE.BoxGeometry(2, 3, 4), new THREE.BoxGeometry(2, 3, 4).toNonIndexed()]) {
      const bytes = encodeLiveMesh(geometry, 0, 6);
      expect(() => validateLiveMesh(bytes)).not.toThrow();
      const header = new DataView(bytes.buffer);
      expect(header.getUint32(8, true)).toBe(6);
      header.setUint32(bytes.byteLength - 4, 999999, true);
      expect(() => validateLiveMesh(bytes)).toThrow('index');
      geometry.dispose();
    }
  });

  it('ignores view exposure, camera and light edits while detecting geometry and style edits', () => {
    const app = createTestApp();
    run(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const view = run<string>(app, 'create-view3d');
    const before = liveGeometryKey(app.store.getState().doc, 'realistic');
    run(app, 'set-view3d-settings', { id: view, renderSettings: { ...defaultSettings(), exposure: 2 } });
    run(app, 'create-light', { kind: 'point', x: 1, y: 2 });
    expect(liveGeometryKey(app.store.getState().doc, 'realistic')).toBe(before);
    expect(liveGeometryKey(app.store.getState().doc, 'wireframe')).not.toBe(before);
    run(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    expect(liveGeometryKey(app.store.getState().doc, 'realistic')).not.toBe(before);
  });

  it('reuses geometry between identical elements and sends no binary assets after acknowledgment', async () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 2000, y: 0 });
    const builder = new UnrealLiveSceneBuilder();
    const scene = await builder.build(app.store.getState().doc, app.catalog, 'realistic', defaultSettings(), undefined, () => {});
    expect(new Set(scene.nodes.map((node) => node.elementId))).toEqual(new Set([a, b]));
    expect(new Set(scene.nodes.map((node) => node.mesh)).size).toBeLessThan(scene.nodes.length);
    scene.assets.forEach((asset) => expect(() => validateLiveMesh(asset.bytes)).not.toThrow());
    builder.acknowledge(scene);
    const exposure = await builder.build(app.store.getState().doc, app.catalog, 'realistic', { ...defaultSettings(), exposure: 2 }, undefined, () => {});
    expect(exposure.nodes).toBe(scene.nodes);
    expect(exposure.assets).toHaveLength(0);
    builder.resetUploads();
    expect((await builder.build(app.store.getState().doc, app.catalog, 'realistic', defaultSettings(), undefined, () => {})).assets.length).toBe(scene.assets.length);
  });
});
