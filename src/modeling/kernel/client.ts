/**
 * Main-thread door to the kernel worker. The worker (and the ~540 KB WASM) starts on the first
 * evaluation, so the workspace loads without it until a body exists. Per body, at most one
 * request is in flight and one is waiting: a newer request replaces the waiting one, and the
 * replaced promise resolves to `null` ("superseded") so previews while dragging never pile up.
 */
import type { KernelRequest, KernelResponse } from './protocol';
import type { Body, EvaluationContext, MeshData } from './types';

export class KernelError extends Error {
  constructor(
    readonly bodyId: string,
    readonly featureId: string,
    message: string,
  ) {
    super(message);
  }
}

interface Waiter {
  resolve: (mesh: MeshData | null) => void;
  reject: (error: Error) => void;
}

interface Queued extends Waiter {
  body: Body;
  context: EvaluationContext;
}

interface Active extends Queued {
  requestId: number;
  attempts: number;
}

export interface KernelStats {
  /** Milliseconds the worker took to load and initialise the WASM (null until it has). */
  initMs: number | null;
  /** Milliseconds of the most recent evaluation. */
  lastMs: number | null;
  evaluations: number;
}

export class KernelClient {
  private worker: Worker | null = null;
  private failure: Error | null = null;
  private localFallback = false;
  private nextId = 1;
  private readonly inFlight = new Map<string, Active>();
  private readonly waiting = new Map<string, Queued>();
  readonly stats: KernelStats = { initMs: null, lastMs: null, evaluations: 0 };
  private readonly listeners = new Set<() => void>();

  /** Notifies when the stats change (the Inspector shows them). */
  onStats(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'modeling-kernel' });
    worker.onmessage = (event: MessageEvent<KernelResponse>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
      this.recover(new Error(`${event.message || 'The modeling kernel crashed'}${location}`));
    };
    worker.onmessageerror = () => this.recover(new Error('The modeling kernel returned an unreadable response'));
    this.worker = worker;
    return worker;
  }

  /** Restarts once after a worker/WASM crash and replays the newest request for each body. */
  private recover(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.failure = null;
    const active = new Map(this.inFlight);
    const waiting = new Map(this.waiting);
    this.inFlight.clear();
    this.waiting.clear();
    const bodyIds = new Set([...active.keys(), ...waiting.keys()]);
    let retrying = false;
    for (const bodyId of bodyIds) {
      const current = active.get(bodyId);
      const newest = waiting.get(bodyId);
      if (newest) current?.resolve(null);
      const request = newest ?? current;
      if (!request) continue;
      const attempts = newest ? 0 : (current?.attempts ?? 0);
      if (attempts >= 1) {
        this.localFallback = true;
        void this.evaluateLocal(request.body, request.context).then(request.resolve, (fallbackError: unknown) => {
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          request.reject(new Error(`${error.message}. The local kernel fallback also failed: ${detail}`));
        });
        continue;
      }
      retrying = true;
      this.send(request.body, request.context, request, attempts + 1);
    }
    if (!retrying && bodyIds.size === 0) this.failure = error;
  }

  private receive(message: KernelResponse): void {
    if (message.type === 'ready') {
      this.stats.initMs = message.initMs;
      this.emit();
      return;
    }
    if (message.type === 'failed') {
      this.recover(new Error(message.message));
      return;
    }
    const current = this.inFlight.get(message.bodyId);
    if (!current || current.requestId !== message.requestId) return;
    this.inFlight.delete(message.bodyId);
    if (message.type === 'result') {
      this.stats.lastMs = message.ms;
      this.stats.evaluations++;
      this.emit();
      current.resolve(message.mesh);
    } else {
      current.reject(new KernelError(message.bodyId, message.featureId, message.message));
    }
    const next = this.waiting.get(message.bodyId);
    if (next) {
      this.waiting.delete(message.bodyId);
      this.send(next.body, next.context, next);
    }
  }

  private send(body: Body, context: EvaluationContext, waiter: Waiter, attempts = 0): void {
    const requestId = this.nextId++;
    // Put the generated metadata after the waiter: a replay passes an Active request whose old
    // request id must never overwrite this new worker message id.
    this.inFlight.set(body.id, { ...waiter, requestId, body, context, attempts });
    const request: KernelRequest = { type: 'evaluate', requestId, body, context };
    this.start().postMessage(request);
  }

  /** Lazily loads Manifold on the UI thread only when this browser cannot keep a worker alive. */
  private async evaluateLocal(body: Body, context: EvaluationContext): Promise<MeshData> {
    const started = performance.now();
    const { evaluateLocally } = await import('./local');
    const mesh = await evaluateLocally(body, context);
    this.stats.lastMs = performance.now() - started;
    this.stats.evaluations++;
    this.emit();
    return mesh;
  }

  /**
   * Evaluates the body against the sketches it may read; resolves to `null` when a newer request
   * for the same body replaced it.
   */
  evaluate(body: Body, context: EvaluationContext): Promise<MeshData | null> {
    if (this.localFallback) return this.evaluateLocal(body, context);
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      if (this.inFlight.has(body.id)) {
        this.waiting.get(body.id)?.resolve(null);
        this.waiting.set(body.id, { body, context, resolve, reject });
        return;
      }
      this.send(body, context, { resolve, reject });
    });
  }

  /** Frees the worker-side cache of a deleted body. */
  drop(bodyId: string): void {
    this.waiting.get(bodyId)?.resolve(null);
    this.waiting.delete(bodyId);
    this.inFlight.get(bodyId)?.resolve(null);
    this.inFlight.delete(bodyId);
    const request: KernelRequest = { type: 'drop', bodyId };
    this.worker?.postMessage(request);
    if (this.localFallback) void import('./local').then(({ dropLocal }) => dropLocal(bodyId));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

export const kernel = new KernelClient();
