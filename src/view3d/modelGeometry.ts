import type * as THREE from 'three';
import type { GeometryTask } from './modelGeometry.worker';
import { geometryTransfers, packGeometry, unpackGeometry, type GeometryPacket } from './geometryPacket';
import { cacheNormalRepair, type NormalMode } from './meshNormals';
import { paint } from '@/progress';

export const extrusionKey = (points: readonly { x: number; y: number }[], depth: number, holes: readonly { x: number; y: number }[][]) => JSON.stringify([points, depth, holes]);

/** Each viewport owns its cancellable worker. A newer update terminates obsolete calculations. */
export class ModelGeometry {
  private worker: Worker | null = null;
  private readonly extrusions = new Map<string, GeometryPacket>();
  private readonly repaired = new WeakMap<THREE.BufferGeometry, Set<NormalMode>>();

  private async run(tasks: GeometryTask[], signal: AbortSignal): Promise<{ key: string; geometry: GeometryPacket }[]> {
    signal.throwIfAborted();
    const worker = this.worker ??= new Worker(new URL('./modelGeometry.worker.ts', import.meta.url), { type: 'module', name: 'model-geometry' });
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener('abort', abort); worker.onmessage = null; worker.onerror = null; };
      const abort = () => { cleanup(); worker.terminate(); if (this.worker === worker) this.worker = null; reject(new DOMException('Model update superseded', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<{ results: { key: string; geometry: GeometryPacket }[]; error?: string }>) => {
        cleanup();
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.results);
      };
      worker.onerror = (event) => { cleanup(); worker.terminate(); if (this.worker === worker) this.worker = null; reject(new Error(event.message)); };
      try { worker.postMessage(tasks, tasks.flatMap((task) => task.kind === 'normals' ? geometryTransfers(task.geometry) : [])); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  async prepareExtrusions(tasks: Extract<GeometryTask, { kind: 'extrude' }>[], signal: AbortSignal): Promise<ReadonlyMap<string, GeometryPacket>> {
    if (typeof Worker === 'undefined') return this.extrusions;
    const missing = tasks.filter((task) => !this.extrusions.has(task.key));
    for (let offset = 0; offset < missing.length; offset += 8) {
      const results = await this.run(missing.slice(offset, offset + 8), signal);
      signal.throwIfAborted();
      for (const result of results) this.extrusions.set(result.key, result.geometry);
      await paint();
    }
    const active = new Set(tasks.map((task) => task.key));
    for (const key of this.extrusions.keys()) if (!active.has(key)) this.extrusions.delete(key);
    return this.extrusions;
  }

  async prepareNormals(source: THREE.BufferGeometry, mode: NormalMode, signal: AbortSignal): Promise<void> {
    if (typeof Worker === 'undefined' || mode === 'source' || this.repaired.get(source)?.has(mode)) return;
    const [result] = await this.run([{ kind: 'normals', key: 'normal', geometry: packGeometry(source), mode }], signal);
    signal.throwIfAborted();
    if (result) {
      cacheNormalRepair(source, mode, unpackGeometry(result.geometry));
      const modes = this.repaired.get(source) ?? new Set<NormalMode>();
      modes.add(mode); this.repaired.set(source, modes);
    }
  }

  dispose(): void { this.worker?.terminate(); this.worker = null; this.extrusions.clear(); }
}
