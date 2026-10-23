import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { UnrealRuntime } from '../electron/unrealRuntime';
import { readRenderPackage } from '../electron/renderPackage';
import { defaultSettings } from '../src/studio/settings';
import { UnrealLiveInput, liveAssetBatches, type UnrealLiveScene } from './unrealLive';
import { setTimeout as delay } from 'node:timers/promises';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });
function fixture(projectId = 'project', options: { sky?: string; hash?: string; renderProject?: string; variant?: boolean } = {}) {
  const model = new Uint8Array(24);
  const view = new DataView(model.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, 24, true);
  view.setUint32(12, 4, true); view.setUint32(16, 0x4e4f534a, true); model.set(strToU8('{}  '), 20);
  if (options.variant) model[23] = 10; // A second valid glTF JSON chunk with a different content hash.
  const render = strToU8(JSON.stringify({ format: 'archai-render-document', version: 1, projectId: options.renderProject ?? projectId,
    settings: { ...defaultSettings(), sky: options.sky ?? 'sun' }, camera: null }));
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  const manifest = strToU8(JSON.stringify({ format: 'archai-scene', version: 1, projectId,
    model: { path: 'scene.glb', bytes: model.length, sha256: options.hash ?? hash(model) },
    renderDocument: { path: 'render.json', bytes: render.length, sha256: hash(render) } }));
  return zipSync({ 'manifest.json': manifest, 'render.json': render, 'scene.glb': model });
}
async function manager() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'archai-runtime-test-'));
  folders.push(folder);
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => { child.emit('exit', 0); return true; } });
    return child as unknown as ChildProcess;
  });
  return { folder, launch, runtime: new UnrealRuntime(process.execPath, folder, launch) };
}

describe('Unreal scene handoff', () => {
  it('sends direct element deltas, reuses assets and keeps exposure updates free of geometry', async () => {
    const { runtime, folder } = await manager();
    const mesh = new Uint8Array(16 + 3 * 48 + 3 * 4), header = new DataView(mesh.buffer);
    header.setUint32(0, 0x314d4341, true); header.setUint32(4, 3, true); header.setUint32(8, 3, true);
    new Uint32Array(mesh.buffer, 16 + 3 * 48).set([0, 1, 2]);
    const hash = createHash('sha256').update(mesh).digest('hex');
    const scene: UnrealLiveScene = { protocol: 1, projectId: 'project', settings: defaultSettings(), camera: null, sunDirection: [0, 1, 0],
      assets: [{ hash, kind: 'mesh', bytes: mesh }], nodes: [{ id: 'column:0', elementId: 'column', mesh: hash,
        matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], material: { color: [1,1,1], emissive: [0,0,0], opacity: 1, roughness: 1, metalness: 0,
          unlit: false, transparent: false, vertexColors: false, alphaTest: 0, normalScale: [1,1], aoIntensity: 1,
          map: null, normalMap: null, roughnessMap: null, metalnessMap: null, emissiveMap: null, aoMap: null, alphaMap: null } }] };
    expect(UnrealLiveInput.safeParse(scene).success).toBe(true);
    expect(UnrealLiveInput.safeParse({ ...scene, nodes: [...scene.nodes, ...scene.nodes] }).success).toBe(false);
    const batches=[...liveAssetBatches([scene.assets[0]!,scene.assets[0]!],mesh.byteLength)];
    expect(batches.map(batch=>batch.length)).toEqual([1,1]);
    await runtime.assets(1,scene.projectId,scene.assets);
    const staged = path.join(folder,(await fs.readdir(folder)).find(name=>name.startsWith('session-'))!);
    expect(await fs.access(path.join(staged,'session.json')).then(()=>true).catch(()=>false)).toBe(false);
    await runtime.live(1, { ...scene,assets:[] });
    const directory = path.join(folder, (await fs.readdir(folder)).find(name => name.startsWith('session-'))!);
    const ticket = async () => JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
    const acknowledge = async () => {
      const current = await ticket();
      await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ token: current.token, projectId: 'project',
        revision: current.revision, state: 'ready', error: '', meshActors: 1, liveBridge: true, meshesBuilt: 1 }));
    };
    expect(await ticket()).toMatchObject({ bridgeVersion: 1, reset: true, upsert: [{ id: 'column:0' }] });
    expect((await fs.readdir(directory)).some((name) => name.endsWith('.glb'))).toBe(false);
    await acknowledge();
    await runtime.live(1, { ...scene, assets: [], settings: { ...scene.settings, exposure: 2 } });
    expect(await ticket()).toMatchObject({ reset: false, baseRevision: 1, revision: 2, upsert: [], remove: [], settings: { exposure: 2 } });
    await acknowledge();
    const moved = structuredClone(scene.nodes); moved[0]!.matrix[12] = 2;
    await runtime.live(1, { ...scene, assets: [], nodes: moved });
    expect((await ticket()).upsert).toHaveLength(1);
    await acknowledge();
    await runtime.live(1, { ...scene, assets: [], nodes: [] });
    expect(await ticket()).toMatchObject({ upsert: [], remove: ['column:0'] });
    await runtime.stop(1);
    // A new native session can restore immutable assets without a second binary upload.
    await runtime.live(1, { ...scene, assets: [] });
    const restored = path.join(folder, (await fs.readdir(folder)).find(name => name.startsWith('session-'))!);
    expect(new Uint8Array(await fs.readFile(path.join(restored, `asset-${hash}.mesh`)))).toEqual(mesh);
    await runtime.stop(1);
  });
  it('uses a fresh Interchange source when returning to earlier geometry and reuses it for look-only updates', async () => {
    const { runtime, folder } = await manager();
    const ticket = async () => {
      const directory = path.join(folder, (await fs.readdir(folder))[0]!);
      return JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8')) as { modelFile: string; modelHash: string };
    };
    await runtime.update(1, fixture()); const first = await ticket();
    await runtime.update(1, fixture('project', { variant: true })); const second = await ticket();
    await runtime.update(1, fixture()); const restored = await ticket();
    expect(first.modelHash).toBe(restored.modelHash);
    expect(new Set([first.modelFile, second.modelFile, restored.modelFile]).size).toBe(3);
    await runtime.update(1, fixture());
    expect((await ticket()).modelFile).toBe(restored.modelFile);
    await runtime.stop(1);
  });
  it('validates integrity, project identity and supported visualization inputs', async () => {
    expect((await readRenderPackage(fixture())).projectId).toBe('project');
    await expect(readRenderPackage(fixture('project', { hash: '0'.repeat(64) }))).rejects.toThrow('integrity');
    await expect(readRenderPackage(fixture('project', { renderProject: 'other' }))).rejects.toThrow('project mismatch');
    await expect(readRenderPackage(fixture('project', { sky: 'hdri' }))).rejects.toThrow('HDRI');
    await expect(readRenderPackage(zipSync({ '../escape': strToU8('bad') }))).rejects.toThrow('archive');
  });

  it('isolates owners and accepts only the current authenticated process report', async () => {
    const { runtime, folder, launch } = await manager();
    await runtime.update(1, fixture());
    const directory = path.join(folder, (await fs.readdir(folder))[0]!);
    const ticket = JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
    expect(launch).toHaveBeenCalledOnce();
    expect((await runtime.status(2)).state).toBe('idle');
    const report = { token: 'wrong', projectId: 'project', revision: 1, state: 'ready', meshActors: 2, error: '' };
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify(report));
    expect((await runtime.status(1)).state).toBe('loading');
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ ...report, token: ticket.token }));
    expect(await runtime.status(1)).toMatchObject({ state: 'ready', meshActors: 2 });
    await fs.unlink(path.join(directory, 'status.json'));
    expect(await runtime.status(1)).toMatchObject({ state: 'ready', meshActors: 2 });
    await runtime.update(1, fixture());
    expect((await runtime.status(1)).revision).toBe(2);
    expect((await runtime.status(1)).state).toBe('loading');
    expect(launch).toHaveBeenCalledOnce();
    await runtime.stop(1);
    expect(await fs.readdir(folder)).toEqual([]);
  });

  it('cancels an update if its window closes before the renderer launches', async () => {
    const { runtime, launch } = await manager();
    const update = runtime.update(1, fixture());
    const rejected = expect(update).rejects.toThrow('cancelled');
    await runtime.stop(1);
    await rejected;
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects corrupt input before launching a process', async () => {
    const { runtime, launch } = await manager();
    await expect(runtime.update(1, fixture('project', { hash: '0'.repeat(64) }))).rejects.toThrow('integrity');
    expect(launch).not.toHaveBeenCalled();
  });

  it('waits for its own command acknowledgment and cleans up the captured image', async () => {
    const { runtime, folder } = await manager();
    await runtime.update(1, fixture());
    const directory = path.join(folder, (await fs.readdir(folder))[0]!);
    const ticket = JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ ...ticket, state: 'ready', meshActors: 1, error: '' }));
    let settled = false;
    const command = runtime.command(1, 'image').then((result) => { settled = true; return result; });
    let request: { id: string; token: string } | undefined;
    for (let attempt = 0; attempt < 100 && !request; ++attempt) {
      try { request = JSON.parse(await fs.readFile(path.join(directory, 'command.json'), 'utf8')); } catch { await delay(10); }
    }
    expect(request).toBeDefined();
    const image = path.join(directory, `image-${request!.id}.png`);
    await fs.writeFile(image, new Uint8Array([137,80,78,71,13,10,26,10]));
    await fs.writeFile(path.join(directory, 'command-result.json'), JSON.stringify({ ...request, token: 'wrong' }));
    await delay(150);
    expect(settled).toBe(false);
    await fs.writeFile(path.join(directory, 'command-result.json'), JSON.stringify(request));
    expect(await command).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]));
    await expect(fs.stat(image)).rejects.toThrow();
    await runtime.stop(1);
  });
});
