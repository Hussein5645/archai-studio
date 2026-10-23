import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay, setImmediate as yieldEventLoop } from 'node:timers/promises';
import { z } from 'zod';
import { UnrealPlacementSchema, UnrealCameraSchema } from '../shared/unrealRuntime.js';
import type { UnrealStatus, UnrealViewport, UnrealImageOptions } from '../shared/unrealRuntime.js';
import { readRenderPackage } from './renderPackage.js';
import { liveMeshValidation, type UnrealLiveScene } from '../shared/unrealLive.js';
import type {UnrealNativeHost} from './unrealNativeHost.js';

const Report = z.object({ token: z.string(), projectId: z.string(), revision: z.number().int().nonnegative(),
  state: z.enum(['loading', 'ready', 'error']), meshActors: z.number().int().nonnegative(), error: z.string(),
  embedded: z.boolean().default(false),
  viewCamera: UnrealCameraSchema.optional(), placements: z.array(UnrealPlacementSchema).max(64).optional(),
  customLights: z.number().int().nonnegative().optional(),
  stage: z.string().optional(), progress: z.number().min(0).max(1).optional(), liveBridge: z.boolean().optional(),
  meshesBuilt: z.number().int().nonnegative().optional(), sceneImports: z.number().int().nonnegative().optional(),
  selectedObject: z.string().optional(), selectionSequence: z.number().int().nonnegative().optional(),
  lookRevision: z.number().int().nonnegative().optional(), exposure: z.number().min(-4).max(4).optional() });
type Session = { token: string; projectId: string; directory: string; revision: number; child: ChildProcess;
  state: UnrealStatus['state']; error: string | null; stopping: boolean; modelFile: string; modelHash: string; prunedRevision: number; report?: z.infer<typeof Report> };

async function assetDigest(bytes:Uint8Array){
  const hash=createHash('sha256');
  for(let start=0;start<bytes.byteLength;start+=4*1024*1024){hash.update(bytes.subarray(start,start+4*1024*1024));await yieldEventLoop();}
  return hash.digest('hex');
}

/** Executable paths come only from the trusted desktop host, never from a renderer message. */
export class UnrealRuntime {
  private readonly sessions = new Map<number, Session>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly generations = new Map<number, number>();
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly viewports = new Map<number, { parent: string; layout: UnrealViewport }>();
  private readonly liveScenes = new Map<number, { directory: string; nodes: Map<string, string>; assets: Set<string>; look: string; view?:string }>();
  constructor(private readonly executable: string, private readonly cacheRoot: string,
    private readonly launch: (file: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
    private readonly native?:UnrealNativeHost) {}

  private async available(): Promise<boolean> {
    try { return (await fs.stat(this.native?.library??this.executable)).isFile(); } catch { return false; }
  }

  async status(owner: number): Promise<UnrealStatus> {
    const available = await this.available();
    const session = this.sessions.get(owner);
    if (!session) return { available, bakeAvailable: false, embedded: false, state: available ? 'idle' : 'unavailable', projectId: null, revision: 0, meshActors: 0,
      error: available ? null : 'The standalone Unreal renderer is not installed.' };
    if(this.native?.error()){session.state='error';session.error=this.native.error();}
    // Native status replacement has a brief file-system gap on Windows. Retain the last
    // authenticated metadata rather than flashing a disconnected viewport or losing its camera.
    let meshActors = session.report?.meshActors ?? 0, embedded = session.report?.embedded ?? false, customLights = session.report?.customLights ?? 0;
    let selectedObject = session.report?.selectedObject, selectionSequence = session.report?.selectionSequence;
    let lookRevision = session.report?.lookRevision, exposure = session.report?.exposure;
    let viewCamera = session.report?.viewCamera, placements = session.report?.placements;
    if (!session.stopping && session.state !== 'closed' && session.state !== 'error') {
      try {
        const file = path.join(session.directory, 'status.json');
        if (!this.native && (await fs.stat(file)).size > 64 * 1024) throw new Error('Invalid renderer status');
        const report = Report.parse(JSON.parse(this.native ? this.native.status() : await fs.readFile(file, 'utf8')));
        if (report.token === session.token && report.projectId === session.projectId && report.revision === session.revision) {
          session.report = report;
          session.state = report.state;
          session.error = report.error || null;
          meshActors = report.meshActors;
          embedded = report.embedded; selectedObject = report.selectedObject; selectionSequence = report.selectionSequence;
          customLights = report.customLights ?? 0;
          viewCamera = report.viewCamera; placements = report.placements;
          lookRevision = report.lookRevision; exposure = report.exposure;
          if (report.state === 'ready' && session.prunedRevision !== report.revision) this.prune(owner, session, report.revision);
        }
      } catch { /* No complete report has arrived yet. Keep the last known process state. */ }
    }
    return { available, bakeAvailable: false, state: session.state, projectId: session.projectId, revision: session.revision, meshActors, embedded, customLights, error: session.error, lookRevision, exposure, viewCamera, placements, selectedObject, selectionSequence,
      stage: session.report?.revision === session.revision ? session.report.stage : undefined,
      progress: session.report?.revision === session.revision ? session.report.progress : undefined, liveBridge: session.report?.liveBridge,
      meshesBuilt: session.report?.meshesBuilt, sceneImports: session.report?.sceneImports };
  }

  async viewport(owner: number, parent: string, layout: UnrealViewport): Promise<void> {
    clearTimeout(this.idleTimers.get(owner));
    this.idleTimers.delete(owner);
    if (!layout.visible) {
      const timer = setTimeout(() => { void this.stop(owner); }, 5 * 60_000);
      timer.unref(); this.idleTimers.set(owner, timer);
    }
    this.viewports.set(owner, { parent, layout });
    const session = this.sessions.get(owner);
    if (session) {
      if(this.native){this.native.viewport(JSON.stringify({token:session.token,...layout}));return;}
      const temporary = path.join(session.directory, `viewport-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify({ token: session.token, ...layout }));
      await fs.rename(temporary, path.join(session.directory, 'viewport.json'));
    }
  }

  update(owner: number, bytes: Uint8Array): Promise<UnrealStatus> {
    const generation = this.generations.get(owner) ?? 0;
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(() => this.apply(owner, bytes, generation));
    this.queues.set(owner, job);
    void job.finally(() => { if (this.queues.get(owner) === job) this.queues.delete(owner); }).catch(() => undefined);
    return job;
  }

  live(owner: number, scene: UnrealLiveScene): Promise<UnrealStatus> {
    const generation = this.generations.get(owner) ?? 0;
    const job = (this.queues.get(owner) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.applyLive(owner, scene, generation));
    this.queues.set(owner, job);
    void job.finally(() => { if (this.queues.get(owner) === job) this.queues.delete(owner); }).catch(() => undefined);
    return job;
  }

  assets(owner:number,projectId:string,assets:UnrealLiveScene['assets']):Promise<UnrealStatus>{
    const generation=this.generations.get(owner)??0;
    const job=(this.queues.get(owner)??Promise.resolve()).catch(()=>undefined).then(async()=>{await this.installLiveAssets(owner,projectId,assets,generation);return this.status(owner);});
    this.queues.set(owner,job);void job.finally(()=>{if(this.queues.get(owner)===job)this.queues.delete(owner);}).catch(()=>undefined);return job;
  }

  private async installLiveAssets(owner:number,projectId:string,inputAssets:UnrealLiveScene['assets'],generation:number){
    if (!await this.available()) throw new Error('The standalone Unreal renderer is not installed.');
    // Validate binary content before launching or modifying the viewer.
    for (const asset of inputAssets) {
      if (await assetDigest(asset.bytes) !== asset.hash) throw new Error('Live asset integrity check failed');
      if (asset.kind === 'mesh') { for(const step of liveMeshValidation(asset.bytes)){void step;await yieldEventLoop();} }
      else {
        const png = new DataView(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength);
        if (asset.bytes.byteLength < 24 || png.getUint32(0) !== 0x89504e47 || png.getUint32(4) !== 0x0d0a1a0a ||
            png.getUint32(16) > 4096 || png.getUint32(20) > 4096) throw new Error('Invalid live texture');
      }
    }
    const session = await this.ensureSession(owner, projectId, generation);
    const deadline = Date.now() + 180_000;
    while (session.revision && (await this.status(owner)).state !== 'ready') {
      if (session.state === 'error' || session.state === 'closed' || session.stopping || (this.generations.get(owner) ?? 0) !== generation)
        throw new Error(session.error || 'Live scene update cancelled');
      if (Date.now() > deadline) throw new Error('Unreal did not finish the previous scene update.');
      await delay(100);
    }
    let cache = this.liveScenes.get(owner);
    if (cache?.directory !== session.directory) {
      cache = { directory: session.directory, nodes: new Map(), assets: new Set(), look: '' };
      this.liveScenes.set(owner, cache);
    }
    const assets = inputAssets.filter((asset) => !cache!.assets.has(`${asset.kind}:${asset.hash}`));
    const assetRoot = path.join(this.cacheRoot, 'assets-v1');
    await fs.mkdir(assetRoot, { recursive: true });
    const install = async (hash: string, kind: 'mesh' | 'texture', bytes?: Uint8Array) => {
      const name = `asset-${hash}.${kind === 'mesh' ? 'mesh' : 'png'}`;
      const saved = path.join(assetRoot, name), target = path.join(session.directory, name);
      if (bytes) {
        try { await fs.writeFile(saved, bytes, { flag: 'wx' }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await assetDigest(await fs.readFile(saved)) !== hash) await fs.writeFile(saved, bytes);
        }
      } else {
        const existing = await fs.readFile(saved).catch(() => { throw new Error('Unreal asset cache missing. Refresh the scene cache.'); });
        if (await assetDigest(existing) !== hash) throw new Error('Unreal asset cache damaged. Refresh the scene cache.');
      }
      if(this.native){
        if(!this.native.hasAsset(name))this.native.asset(name,bytes??await fs.readFile(saved));
        cache!.assets.add(`${kind}:${hash}`);return;
      }
      try { await fs.link(saved, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await fs.copyFile(saved, target);
      }
      cache!.assets.add(`${kind}:${hash}`);
    };
    for (let offset = 0; offset < assets.length; offset += 4) {
      await Promise.all(assets.slice(offset, offset + 4).map(async (asset) => {
        await install(asset.hash, asset.kind, asset.bytes);
      }));
    }
    return {session,cache,install};
  }
  private async applyLive(owner:number,scene:UnrealLiveScene,generation:number):Promise<UnrealStatus>{
    const {session,cache,install}=await this.installLiveAssets(owner,scene.projectId,scene.assets,generation);
    const next = new Map<string, string>(), upsert: UnrealLiveScene['nodes'] = [];
    for (const node of scene.nodes) {
      if (!cache.assets.has(`mesh:${node.mesh}`) || this.native&&!this.native.hasAsset(`asset-${node.mesh}.mesh`)) await install(node.mesh, 'mesh');
      for (const texture of [node.material.map, node.material.normalMap, node.material.roughnessMap, node.material.metalnessMap, node.material.emissiveMap, node.material.aoMap, node.material.alphaMap])
        if (texture && (!cache.assets.has(`texture:${texture.hash}`) || this.native&&!this.native.hasAsset(`asset-${texture.hash}.png`))) await install(texture.hash, 'texture');
      const signature = JSON.stringify(node); next.set(node.id, signature);
      if (cache.nodes.get(node.id) !== signature) upsert.push(node);
    }
    const remove = [...cache.nodes.keys()].filter((id) => !next.has(id));
    if(this.native){
      const names=new Set<string>();
      for(const node of scene.nodes){names.add(`asset-${node.mesh}.mesh`);for(const texture of [node.material.map,node.material.normalMap,node.material.roughnessMap,node.material.metalnessMap,node.material.emissiveMap,node.material.aoMap,node.material.alphaMap])if(texture)names.add(`asset-${texture.hash}.png`);}
      this.native.retain(names);
    }
    const look = JSON.stringify([scene.settings, scene.sunDirection]);
    // Navigation is owned by the live viewer after its initial camera; do not echo it back.
    if (!upsert.length && !remove.length && look === cache.look && cache.view===scene.viewId && session.revision) return this.status(owner);
    const ticket = { version: 1, bridgeVersion: 1, token: session.token, projectId: scene.projectId,
      baseRevision: session.revision, revision: session.revision + 1, reset: !cache.look,
      resetCamera:cache.view!==scene.viewId,
      upsert, remove, settings: scene.settings, sunDirection: scene.sunDirection, camera: scene.camera };
    const temp = path.join(session.directory, 'session.tmp');
    const serialized = JSON.stringify(ticket);
    if (Buffer.byteLength(serialized) > 128 * 1024 * 1024) throw new Error('Live element metadata exceeds 128 MB. Hide part of the model and retry.');
    if(!this.native)await fs.writeFile(temp, serialized);
    if (session.stopping || (this.generations.get(owner) ?? 0) !== generation) throw new Error('Live scene update cancelled');
    if(!this.native)await fs.rename(temp, path.join(session.directory, 'session.json'));
    if(this.native)this.native.submit('scene',serialized);
    session.revision++; session.state = 'loading'; cache.nodes = next; cache.look = look;cache.view=scene.viewId;
    return this.status(owner);
  }

  command(owner: number, action: 'frame' | 'image', options?: UnrealImageOptions): Promise<Uint8Array | void> {
    const generation = this.generations.get(owner) ?? 0;
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(async () => {
      const session = this.sessions.get(owner);
      if (!session) throw new Error('Open the Unreal viewport before rendering.');
      const readyDeadline = Date.now() + 60_000;
      while ((await this.status(owner)).state !== 'ready') {
        if (session.stopping || session.state === 'closed' || session.state === 'error' ||
          (this.generations.get(owner) ?? 0) !== generation) throw new Error(session.error || 'The Unreal command was cancelled.');
        if (Date.now() >= readyDeadline) throw new Error('Unreal did not finish updating the scene.');
        await delay(100);
      }
      const id = randomUUID();
      const temporary = path.join(session.directory, 'command.tmp');
      if(!this.native){
        await fs.writeFile(temporary, JSON.stringify({ token: session.token, id, action, options }));
        await fs.rename(temporary, path.join(session.directory, 'command.json'));
      }
      if(this.native)this.native.submit('command',JSON.stringify({token:session.token,id,action,options}));
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !session.stopping && session.child.exitCode === null && (this.generations.get(owner) ?? 0) === generation) {
        let result;
        try { result = JSON.parse(await fs.readFile(path.join(session.directory, 'command-result.json'), 'utf8')) as Record<string, unknown>; } catch { /* Pending. */ }
        if (result?.['token'] === session.token && result['id'] === id) {
          if (result['error']) throw new Error(String(result['error']));
          if (action === 'frame') return;
          const image = path.join(session.directory, `image-${id}.png`);
          if ((await fs.stat(image)).size > 64 * 1024 * 1024) throw new Error('Rendered image exceeds 64 MB');
          const bytes = new Uint8Array(await fs.readFile(image));
          await fs.unlink(image);
          return bytes;
        }
        await delay(100);
      }
      throw new Error('Unreal did not complete the rendering command.');
    });
    this.queues.set(owner, job);
    void job.finally(() => { if (this.queues.get(owner) === job) this.queues.delete(owner); }).catch(() => undefined);
    return job;
  }

  private prune(owner: number, session: Session, revision: number): void {
    session.prunedRevision = revision;
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(async () => {
      if (this.sessions.get(owner) !== session || session.revision !== revision || session.stopping) return;
      for (const file of await fs.readdir(session.directory)) {
        if (/^scene-[a-f0-9]{64}(?:-\d+)?\.glb$/.test(file) && file !== session.modelFile)
          await fs.unlink(path.join(session.directory, file));
      }
    });
    this.queues.set(owner, job);
    void job.finally(() => { if (this.queues.get(owner) === job) this.queues.delete(owner); }).catch(() => undefined);
  }

  private async apply(owner: number, bytes: Uint8Array, generation: number): Promise<UnrealStatus> {
    if (!await this.available()) throw new Error('The standalone Unreal renderer is not installed.');
    const scene = await readRenderPackage(bytes);
    const liveCache = this.liveScenes.get(owner);
    if (liveCache) { liveCache.nodes.clear(); liveCache.look = ''; }
    if ((this.generations.get(owner) ?? 0) !== generation) throw new Error('Renderer update cancelled');
    const session = await this.ensureSession(owner, scene.projectId, generation);
    // Interchange caches source identities. Returning to an earlier model/style must use a
    // fresh source path, while look-only updates can keep the current geometry file.
    const modelFile = session.modelHash === scene.modelHash ? session.modelFile : `scene-${scene.modelHash}-${session.revision + 1}.glb`;
    session.modelFile = modelFile;
    session.modelHash = scene.modelHash;
    const modelPath = path.join(session.directory, modelFile);
    try { await fs.writeFile(modelPath, scene.model, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const ticket = { version: 1, token: session.token, projectId: session.projectId, revision: ++session.revision,
      modelFile, modelHash: scene.modelHash, settings: scene.settings, camera: scene.camera, sunDirection: scene.sunDirection };
    const temp = path.join(session.directory, 'session.tmp');
    await fs.writeFile(temp, JSON.stringify(ticket));
    await fs.rename(temp, path.join(session.directory, 'session.json'));
    session.state = 'loading';
    if(this.native)this.native.submit('scene',JSON.stringify(ticket));
    return this.status(owner);
  }

  private async ensureSession(owner: number, projectId: string, generation: number): Promise<Session> {
    if ((this.generations.get(owner) ?? 0) !== generation) throw new Error('Renderer update cancelled');
    let session = this.sessions.get(owner);
    if (session && (session.projectId !== projectId || session.state === 'closed' || session.state === 'error')) {
      await this.stopSession(owner);
      session = undefined;
    }
    if (!session) {
      await fs.mkdir(this.cacheRoot, { recursive: true });
      const directory = await fs.mkdtemp(path.join(this.cacheRoot, 'session-'));
      if ((this.generations.get(owner) ?? 0) !== generation) throw new Error('Renderer update cancelled');
      const token = randomUUID();
      const viewport = this.viewports.get(owner);
      if (viewport&&!this.native) await fs.writeFile(path.join(directory, 'viewport.json'), JSON.stringify({ token, ...viewport.layout }));
      if(this.native&&!viewport)throw Error('The native Unreal viewport requires an Archai host window.');
      const child = this.native ? this.native.launch(viewport!.parent,directory,token,projectId) : this.launch(this.executable, [`-ArchaiSession=${directory}`, `-ArchaiToken=${token}`, ...(viewport ? [`-ArchaiParent=${viewport.parent}`] : []), '-windowed', '-ResX=1280', '-ResY=800', '-nosplash'],
        { shell: false, windowsHide: false, stdio: 'ignore' });
      session = { token, directory, projectId: projectId, revision: 0, child, state: 'starting', error: null, stopping: false, modelFile: '', modelHash: '', prunedRevision: 0 };
      this.sessions.set(owner, session);
      const owned = session;
      child.once('error', (error) => { owned.state = 'error'; owned.error = error.message; });
      child.once('exit', (code) => {
        owned.state = owned.stopping || code === 0 ? 'closed' : 'error';
        if (!owned.stopping && code !== 0) owned.error = `Unreal renderer exited (${code ?? 'terminated'}).`;
      });
    }
    if(this.native){
      await this.native.ready();
      const viewport=this.viewports.get(owner);
      if(viewport)this.native.viewport(JSON.stringify({token:session.token,...viewport.layout}));
    }
    return session;
  }

  async stop(owner: number): Promise<void> {
    clearTimeout(this.idleTimers.get(owner)); this.idleTimers.delete(owner);
    this.viewports.delete(owner);
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    await this.queues.get(owner)?.catch(() => undefined);
    await this.stopSession(owner);
  }

  private async stopSession(owner: number): Promise<void> {
    const session = this.sessions.get(owner);
    if (!session) return;
    session.stopping = true;
    const exited = new Promise<void>((resolve) => {
      if (session.child.exitCode !== null || session.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 3000);
      session.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    session.child.kill();
    await exited;
    this.sessions.delete(owner);
    this.liveScenes.delete(owner);
    // Only ephemeral directories created by this manager may be removed.
    if (path.dirname(session.directory) === path.resolve(this.cacheRoot) && path.basename(session.directory).startsWith('session-'))
      await fs.rm(session.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  async hideAll() {
    await Promise.all([...new Set([...this.sessions.keys(), ...this.queues.keys()])].map(owner => this.stop(owner)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.sessions.keys(), ...this.queues.keys()])].map((owner) => this.stop(owner)));
    await this.native?.shutdown();
    const root = path.resolve(this.cacheRoot, 'assets-v1');
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    const files = [];
    for (const name of entries) {
      if (!/^asset-[a-f0-9]{64}\.(mesh|png)$/.test(name)) continue;
      const file = path.join(root,name), info = await fs.stat(file).catch(() => null);
      if (info?.isFile()) files.push({file,bytes:info.size,modified:info.mtimeMs});
    }
    let total = files.reduce((sum,file)=>sum+file.bytes,0);
    for (const file of files.sort((a,b)=>a.modified-b.modified)) {
      if(total<=4*1024*1024*1024)break;
      await fs.unlink(file.file).catch(()=>undefined);total-=file.bytes;
    }
  }
}
