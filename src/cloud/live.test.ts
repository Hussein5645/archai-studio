import { afterEach, expect, it, vi } from 'vitest';
import { applyPatches } from 'immer';
import { createTestApp, run } from '@/test/harness';
import type { AccountService } from './account';
import { LiveSession } from './live';

class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  sent: Record<string, unknown>[] = [];
  constructor() { Socket.latest = this; }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() {}
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
afterEach(() => vi.unstubAllGlobals());

it('waits for a large linked model acknowledgement before sending its move', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const app = createTestApp();
  const id = app.store.getState().doc.id;
  let server = app.store.getState().doc;
  let finish!: () => void;
  const request = vi.fn(async (_url: string, input: RequestInit) => {
    const body = JSON.parse(String(input.body));
    await new Promise<void>(resolve => { finish = resolve; });
    server = applyPatches(server, body.patches);
    return new Response(JSON.stringify({ version: 1 }));
  });
  const live = new LiveSession(id, 0, 'owner', { token: () => 'test', request } as unknown as AccountService,
    app.executor, app.store, { notice: vi.fn(), progress: vi.fn(), role: vi.fn(), ended: vi.fn() });
  try {
    const socket = Socket.latest;
    socket.receive({ t: 'synced', version: 0 });
    await vi.waitFor(() => expect(live.snapshot().status).toBe('live'));
    run(app, 'bridge-sync', { key: 'large', app: 'Revit', model: {
      archaiRevit: 1, materials: [], walls: [], openings: [], meshes: [
        { id: 'a', origin: [0, 0, 0], size: [100, 100, 100], glb: 'AAAA'.repeat(150000) },
      ],
    } });
    const group = app.store.getState().doc.bridge!.sources['large']!.groupId!;
    run(app, 'select', { ids: [group] });
    run(app, 'move-selection', { ids: [group], dx: 500, dy: 200 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(socket.sent.filter(message => message.t === 'ops')).toHaveLength(0);
    finish();
    await vi.waitFor(() => expect(socket.sent.filter(message => message.t === 'ops')).toHaveLength(1));
    const move = socket.sent.find(message => message.t === 'ops')!;
    server = applyPatches(server, move.patches as Parameters<typeof applyPatches>[1]);
    expect(server.elements[group]).toMatchObject({ x: 500, y: 200 });
    socket.receive({ t: 'ack', seq: move.seq, version: 2 });
    await vi.waitFor(() => expect(live.snapshot().pending).toBe(0));
    expect(app.store.getState().doc.elements[group]).toBeDefined();
  } finally { live.close(); }
});

it('preserves the local model before reloading a rejected edit', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const app = createTestApp();
  const initial = app.store.getState().doc;
  let complete!: () => void;
  const preserve = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const request = vi.fn(async () => new Response(JSON.stringify(initial), { headers: { 'X-Version': '0' } }));
  const live = new LiveSession(initial.id, 0, 'owner', { token: () => 'test', request } as unknown as AccountService,
    app.executor, app.store, { preserve, notice: vi.fn(), progress: vi.fn(), role: vi.fn(), ended: vi.fn() });
  try {
    Socket.latest.receive({ t: 'synced', version: 0 });
    await vi.waitFor(() => expect(live.snapshot().status).toBe('live'));
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    Socket.latest.receive({ t: 'reject', seq: 1, reason: 'The edit no longer fits the document' });
    await vi.waitFor(() => expect(preserve).toHaveBeenCalledTimes(1));
    expect(preserve.mock.calls[0]).toBeDefined();
    expect(app.store.getState().doc.elements[rect]).toBeDefined();
    expect(request).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(live.snapshot().pending).toBe(0);
  } finally { live.close(); }
});
