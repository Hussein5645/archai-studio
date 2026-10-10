/**
 * Live Bridge with the ArchAI plugins (docs/plugins.md, "Live Bridge"): a small HTTP server on the
 * loopback interface that Revit, AutoCAD, Rhino, SketchUp, Blender, 3ds Max and Unreal talk to
 * while their Live Bridge is on. Requests go to the board window, which owns the document:
 *
 *   GET  /live/status?key=K&name=N&app=A[&project=P&protocol=2]
 *                              { app, version, protocol, document, bound, mismatch?, revision, own }
 *                              (is ArchAI there? On its Home screen it opens a project for K)
 *   POST /live/push           { key, app, name, model[, protocol: 2, project, changeId, complete,
 *                              deleted] }  → { protocol, ack, revision, document, applied, created,
 *                              skipped } or { refused, message }: the plugin's model (the exchange
 *                              format of src/revit/exchange.ts) applied through the Live Bridge
 *   GET  /live/projects        { protocol, open, projects: [{ id, name, updatedAt, online, open }] }
 *   POST /live/bind           { key, app, name, project | newName }  → { document, revision }
 *                              links the model to that project (opened) or a new one
 *   GET  /live/pull?key=K     ArchAI's model as binary glTF (X-ArchAI-Revision header), without
 *                              the elements that came from that plugin
 *   POST /live/stop           { key }   the plugin turned its link off
 *   GET  /live/account?app=A&prompt=1   { signedIn, token?, user? }  the ArchAI account, for the
 *                              plugins' cloud features (Open in VR); prompt=1 brings ArchAI to the
 *                              front with its sign-in dialog when nobody is signed in
 *
 * Only loopback, only requests without an Origin header (a web page cannot drive it), and only
 * with the `X-ArchAI-Live: 1` header the plugins send.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC, LiveReplyInput, type LiveRequest } from '../shared/ipc.js';

export const LIVE_PORT = Number(process.env['ARCHAI_LIVE_PORT']) || 47821;
const MAX_BODY = 768 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

/** Called from the IPC handler of IPC.liveReply. */
export function liveReply(raw: unknown): void {
  const reply = LiveReplyInput.parse(raw);
  const waiting = pending.get(reply.id);
  if (!waiting) return;
  pending.delete(reply.id);
  clearTimeout(waiting.timer);
  if (reply.ok) waiting.resolve(reply.result);
  else waiting.reject(new Error(reply.error ?? 'ArchAI could not do that'));
}

function ask(board: BrowserWindow | null, kind: LiveRequest['kind'], payload: Record<string, unknown>): Promise<unknown> {
  if (!board || board.isDestroyed()) return Promise.reject(Object.assign(new Error('ArchAI has no project window open'), { status: 503 }));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('ArchAI did not answer in time'), { status: 504 }));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    const request: LiveRequest = { id, kind, payload };
    board.webContents.send(IPC.liveEvent, request);
  });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('The model is too large for the Live Bridge'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/**
 * Starts the server; `board` returns the window that holds the project. A second ArchAI (port
 * taken) runs without a Live Bridge.
 */
export function startLiveLink(board: () => BrowserWindow | null, version: string): void {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Browsers always send Origin on cross-site requests: a web page must not reach the model.
      if (request.headers.origin || request.headers['x-archai-live'] !== '1') return send(response, 403, { error: 'Live Bridge requests come from the ArchAI plugins' });
      const key = (url.searchParams.get('key') ?? '').slice(0, 300);
      if (request.method === 'GET' && url.pathname === '/live/status') {
        const status = (await ask(board(), 'status', {
          key,
          name: (url.searchParams.get('name') ?? '').slice(0, 200),
          app: (url.searchParams.get('app') ?? '').slice(0, 60),
          project: (url.searchParams.get('project') ?? '').slice(0, 64),
          protocol: Number(url.searchParams.get('protocol')) || 1,
        })) as Record<string, unknown>;
        return send(response, 200, { app: 'ArchAI', version, ...status });
      }
      if (request.method === 'GET' && url.pathname === '/live/projects') {
        return send(response, 200, await ask(board(), 'projects', {}));
      }
      const posts = { '/live/push': 'push', '/live/stop': 'stop', '/live/bind': 'bind' } as const;
      if (request.method === 'POST' && url.pathname in posts) {
        const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
        if (typeof body['key'] !== 'string' || !body['key']) return send(response, 400, { error: 'key is required' });
        const result = await ask(board(), posts[url.pathname as keyof typeof posts], body);
        return send(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/live/account') {
        const prompt = url.searchParams.get('prompt') === '1';
        const result = (await ask(board(), 'account', { prompt, app: (url.searchParams.get('app') ?? '').slice(0, 60) })) as { signedIn?: boolean };
        const window = board();
        if (prompt && !result.signedIn && window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        }
        return send(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/live/pull') {
        const result = (await ask(board(), 'pull', { key, protocol: Number(url.searchParams.get('protocol')) || 1, fresh: url.searchParams.get('fresh') === '1' })) as { glb: Uint8Array; revision: number; name: string } | null;
        if (!result) return send(response, 204, {});
        const bytes = Buffer.from(result.glb.buffer, result.glb.byteOffset, result.glb.byteLength);
        response.writeHead(200, {
          'content-type': 'model/gltf-binary',
          'content-length': bytes.length,
          'x-archai-revision': String(result.revision),
          'x-archai-name': encodeURIComponent(result.name),
        });
        response.end(bytes);
        return;
      }
      send(response, 404, { error: 'Unknown live-link request' });
    })().catch((error: unknown) => {
      const status = (error as { status?: number }).status ?? (error instanceof SyntaxError ? 400 : 500);
      if (!response.headersSent) send(response, status, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
  });
  server.on('error', (error) => console.warn(`ArchAI Live Bridge is off: ${error.message}`));
  server.listen(LIVE_PORT, '127.0.0.1');
}
