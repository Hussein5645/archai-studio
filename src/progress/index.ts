/**
 * Progress of long tasks (exports, imports, opening files, live-link syncs, uploads), shown by the
 * progress card (src/ui/ProgressCenter.tsx) and, on the desktop, the taskbar button.
 *
 *   await withProgress('Exporting PDF', async (task) => {
 *     task.update('Sheet 2 of 5', 0.4);
 *     await task.paint(); // let the card repaint before more synchronous work
 *   });
 *
 * A fraction of null means "working, size unknown" (an animated bar). Commands use this module,
 * not React, so it works from command code, the Live Bridge and services alike.
 */

export interface ProgressTask {
  id: number;
  title: string;
  detail: string;
  /** 0..1, or null when the amount of work is not known. */
  fraction: number | null;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  /** When it finished (done or failed). */
  endedAt?: number;
}

export interface ProgressHandle {
  /** New status line and/or fraction (undefined keeps the current one). */
  update(detail?: string, fraction?: number | null): void;
  /** `index` (0-based) of `count` items done, as a fraction inside [from, to] of the whole task. */
  step(index: number, count: number, detail?: string, from?: number, to?: number): void;
  done(): void;
  failed(): void;
  /** Resolves after the browser has painted, so the card shows the latest step. */
  paint(): Promise<void>;
}

type Listener = () => void;

let tasks: readonly ProgressTask[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
let hostReporter: ((fraction: number | null, active: boolean) => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
  if (hostReporter) {
    const running = tasks.filter((task) => task.state === 'running');
    if (running.length === 0) hostReporter(null, false);
    else {
      const known = running.filter((task) => task.fraction !== null);
      hostReporter(known.length === running.length ? known.reduce((sum, task) => sum + (task.fraction ?? 0), 0) / known.length : null, true);
    }
  }
}

function patch(id: number, change: Partial<ProgressTask>): void {
  tasks = tasks.map((task) => (task.id === id ? { ...task, ...change } : task));
  emit();
}

/** How long finished tasks stay on the card. */
const LINGER_MS = { done: 1200, failed: 0 };

function finish(id: number, state: 'done' | 'failed'): void {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.state !== 'running') return;
  patch(id, { state, endedAt: Date.now(), ...(state === 'done' ? { fraction: 1 } : {}) });
  setTimeout(() => {
    tasks = tasks.filter((item) => item.id !== id);
    emit();
  }, LINGER_MS[state]);
}

export function paint(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

export function startProgress(title: string, detail = '', fraction: number | null = null): ProgressHandle {
  const id = nextId++;
  tasks = [...tasks, { id, title, detail, fraction, state: 'running', startedAt: Date.now() }];
  emit();
  return {
    update(nextDetail, nextFraction) {
      const task = tasks.find((item) => item.id === id);
      if (!task || task.state !== 'running') return;
      const change: Partial<ProgressTask> = {};
      if (nextDetail !== undefined && nextDetail !== task.detail) change.detail = nextDetail;
      if (nextFraction !== undefined) {
        const clamped = nextFraction === null ? null : Math.max(0, Math.min(1, nextFraction));
        // Fractions only move forward (several phases report into one bar).
        if (clamped === null ? task.fraction !== null : task.fraction === null || clamped > task.fraction) change.fraction = clamped;
      }
      if (Object.keys(change).length) patch(id, change);
    },
    step(index, count, nextDetail, from = 0, to = 1) {
      this.update(nextDetail, count > 0 ? from + (to - from) * (index / count) : null);
    },
    done: () => finish(id, 'done'),
    failed: () => finish(id, 'failed'),
    paint,
  };
}

/** Runs `work` as a task: done when it resolves, failed when it throws (the error is re-thrown). */
export async function withProgress<T>(title: string, work: (task: ProgressHandle) => Promise<T>, detail = ''): Promise<T> {
  const task = startProgress(title, detail);
  try {
    const result = await work(task);
    task.done();
    return result;
  } catch (error) {
    task.failed();
    throw error;
  }
}

export function progressTasks(): readonly ProgressTask[] {
  return tasks;
}

export function subscribeProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The host's own indicator (desktop taskbar): `fraction` null with `active` means indeterminate. */
export function setHostProgressReporter(reporter: ((fraction: number | null, active: boolean) => void) | null): void {
  hostReporter = reporter;
}

/** Bytes as "4.2 MB" for status lines. */
export function megabytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Uploads with progress (fetch cannot report upload progress): PUT/POST `body` and resolve with
 * the response text, or reject with the server's error. `onProgress` gets 0..1.
 */
export function uploadWithProgress(
  url: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  init: { method?: string; headers?: Record<string, string> },
  onProgress: (fraction: number, loaded: number, total: number) => void,
): Promise<{ status: number; text: string; headers: (name: string) => string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'PUT', url);
    for (const [name, value] of Object.entries(init.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total, event.loaded, event.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, headers: (name) => xhr.getResponseHeader(name) });
    xhr.onerror = () => reject(new Error('Network error: check the internet connection'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(body instanceof Uint8Array ? new Blob([body as BlobPart]) : body);
  });
}

/** Reads a response body with progress (Content-Length known), else plainly. */
export async function readWithProgress(response: Response, onProgress: (fraction: number, loaded: number, total: number) => void): Promise<Uint8Array> {
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(Math.min(1, loaded / total), loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
