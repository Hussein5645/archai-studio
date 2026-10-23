import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { FeatureAccount } from '../electron/featureAccount';
import { RuntimeDownload, extractRuntime, runtimeEntry, runtimeFiles } from '../electron/runtimeDownload';
import { guestFolderAllowed, UNREAL_PACK_VERSION } from './runtimeDownload';

const directories: string[] = [], servers: Server[] = [];
const temp = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archai-runtime-test-')); directories.push(dir); return dir; };
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

it('guests can only export real-time Default folders', () => {
  expect(guestFolderAllowed(undefined)).toBe(false);
  for (const delivery of ['webxr', 'unreal', 'baked-unreal']) for (const sourceRenderer of ['default', 'unreal', 'baked']) for (const lighting of ['realtime', 'baked'])
    expect(guestFolderAllowed({ delivery, sourceRenderer, lighting })).toBe(delivery === 'webxr' && sourceRenderer === 'default' && lighting === 'realtime');
});
it('validates sessions with the server, and forgets authorization on signout', async () => {
  let stored: string | null = JSON.stringify({ token: 'test-session', user: { id: 'forged-client-user' } });
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'server-user' } })));
  const auth = new FeatureAccount(async () => stored, 'https://example.invalid', request);
  expect(await auth.require()).toBe('test-session'); expect(await auth.require()).toBe('test-session'); expect(request).toHaveBeenCalledTimes(1);
  auth.clear(); request.mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(auth.require()).rejects.toThrow('session has ended');
  stored = null; await expect(auth.require()).rejects.toThrow('Sign in');
});
it('rejects traversal, Windows path aliases and unexpected archive roots', async () => {
  const root = await temp();
  for (const name of ['../outside', 'unreal/../../escape', 'unreal/CON:stream', 'unreal/x\\..\\escape', 'unreal/file./payload', 'projects/existing.air', '/unreal/root'])
    expect(() => runtimeEntry(root, name)).toThrow();
  const zip = path.join(root, 'bad.zip'); await fs.writeFile(zip, zipSync({ 'unreal/../../escape': new Uint8Array([1]) }));
  await expect(extractRuntime(zip, path.join(root, 'content'), 1)).rejects.toThrow();
});
it('requires authorization before network access or filesystem changes', async () => {
  const root = await temp(), auth = vi.fn(async () => { throw Error('Sign in'); });
  const manager = new RuntimeDownload(root, auth, 'http://127.0.0.1:1');
  expect(await manager.install()).toMatchObject({ state: 'error', error: 'Sign in' });
  expect(await fs.readdir(root)).toEqual([]);
});

async function fixture(corrupt = false) {
  const root = await temp();
  const entries = Object.fromEntries(runtimeFiles.map(name => [name, new TextEncoder().encode(`fixture-${name}`)]));
  const archive = zipSync(entries), manifest = { version: UNREAL_PACK_VERSION, bytes: archive.length,
    sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex'), unpackedBytes: Object.values(entries).reduce((n, bytes) => n + bytes.length, 0) };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.headers.authorization !== 'Bearer fixture-session') { res.writeHead(401); res.end(); return; }
    res.end(req.url?.endsWith('/manifest') ? JSON.stringify(manifest) : archive);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No server');
  return { root, requests, manager: new RuntimeDownload(root, async () => 'fixture-session', `http://127.0.0.1:${address.port}`) };
}
it('streams and verifies an authenticated pack, installs atomically and reuses it without downloading', async () => {
  const { root, manager, requests } = await fixture();
  expect((await manager.install()).state).toBe('ready');
  for (const name of runtimeFiles) expect(await fs.readFile(path.join(manager.root, name), 'utf8')).toContain('fixture-');
  expect((await manager.install()).state).toBe('ready'); expect(requests).toHaveLength(2);
  expect(await fs.readdir(root)).toEqual([UNREAL_PACK_VERSION]);
});
it('discards corrupt downloads without activating a runtime or altering project storage', async () => {
  const { root, manager } = await fixture(true);
  await fs.mkdir(path.join(root, 'projects')); await fs.writeFile(path.join(root, 'projects/existing.air'), 'unchanged');
  expect(await manager.install()).toMatchObject({ state: 'error', error: expect.stringContaining('verification failed') });
  expect(await manager.installed()).toBe(false);
  expect(await fs.readdir(root)).toEqual(['projects']);
  expect(await fs.readFile(path.join(root, 'projects/existing.air'), 'utf8')).toBe('unchanged');
});

it('cancels during account verification and prevents concurrent installs', async () => {
  const root = await temp();
  let authorize!: (token: string) => void;
  const manager = new RuntimeDownload(root, () => new Promise(resolve => { authorize = resolve; }), 'http://127.0.0.1:1');
  const pending = manager.install();
  await expect(manager.install()).rejects.toThrow('already running');
  manager.cancel(); authorize('fixture-session');
  expect(await pending).toMatchObject({ state: 'error', error: 'Download cancelled.' });
  expect(await fs.readdir(root)).toEqual([]);
});
