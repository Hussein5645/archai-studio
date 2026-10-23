import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Unzip, UnzipInflate } from 'fflate';
import { z } from 'zod';
import { ACCOUNT_CLOUD_URL, UNREAL_PACK_VERSION, type RuntimeDownloadState } from '../shared/runtimeDownload.js';

const Manifest = z.object({ version: z.literal(UNREAL_PACK_VERSION), bytes: z.number().int().positive().max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), unpackedBytes: z.number().int().positive().max(8 * 1024 ** 3) });
export const runtimeFiles = ['unreal/ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll',
  'unreal/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe', 'unreal/ArchaiRender/ArchaiRender.uproject',
  'unreal-native/archai_unreal_host.node'];

export function runtimeEntry(root: string, name: string): string {
  if (!/^(unreal|unreal-native|unreal-worker)\//.test(name) || name.includes('\\') || name.includes(':') || name.split('/').some(p => p === '..' || p === '.') || /[. ](?:\/|$)/.test(name))
    throw new Error('Unsafe file in Unreal download.');
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe Unreal download path.');
  return target;
}

/** Extract only our authenticated, hash-verified pack, streaming with bounded memory. */
export async function extractRuntime(archive: string, root: string, limit: number, signal?: AbortSignal) {
  let bytes = 0, failure: Error | undefined;
  const opened = new Set<number>(), entries = new Set<string>();
  const unzip = new Unzip(file => {
    const target = runtimeEntry(root, file.name), key = file.name.toLowerCase();
    if (entries.has(key)) throw new Error('Duplicate file in Unreal download.');
    entries.add(key);
    if (entries.size > 100000) throw new Error('Too many files in Unreal download.');
    if (file.name.endsWith('/')) { mkdirSync(target, { recursive: true }); file.ondata = () => {}; file.start(); return; }
    mkdirSync(path.dirname(target), { recursive: true });
    const fd = openSync(target, 'wx'); opened.add(fd);
    file.ondata = (error, chunk, final) => {
      if (error) { failure = error; return; }
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Unreal download exceeds its declared size.');
      writeSync(fd, chunk);
      if (final) { closeSync(fd); opened.delete(fd); }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(archive, { highWaterMark: 64 * 1024, signal })) {
      unzip.push(new Uint8Array(chunk), false); if (failure) throw failure;
    }
    unzip.push(new Uint8Array(), true);
    if (failure || opened.size || bytes !== limit) throw failure ?? new Error('Incomplete Unreal download.');
    for (const name of runtimeFiles) await fs.access(path.join(root, name));
  } finally { for (const fd of opened) closeSync(fd); }
}

export class RuntimeDownload {
  readonly root: string;
  private progress: RuntimeDownloadState = { state: 'missing', received: 0, total: 0 };
  private controller: AbortController | null = null;
  constructor(private readonly directory: string, private readonly authorize: () => Promise<string>,
    private readonly cloud = ACCOUNT_CLOUD_URL) { this.root = path.join(directory, UNREAL_PACK_VERSION); }
  async installed() {
    try {
      Manifest.parse(JSON.parse(await fs.readFile(path.join(this.root, 'installed.json'), 'utf8')));
      for (const name of runtimeFiles) await fs.access(path.join(this.root, name));
      return true;
    } catch { return false; }
  }
  async status(): Promise<RuntimeDownloadState> {
    if (!this.controller && await this.installed()) return { state: 'ready', received: 0, total: 0 };
    return { ...this.progress };
  }
  cancel() { this.controller?.abort(); }
  async install(): Promise<RuntimeDownloadState> {
    if (this.controller) throw new Error('The Unreal download is already running.');
    const controller = new AbortController(); this.controller = controller;
    const temporary = path.join(this.directory, `.download-${randomUUID()}`);
    this.progress = { state: 'downloading', received: 0, total: 0 };
    const url = `${this.cloud}/runtime/${UNREAL_PACK_VERSION}`;
    try {
      const token = await this.authorize(); controller.signal.throwIfAborted();
      if (await this.installed()) { this.progress.state = 'ready'; return { ...this.progress }; }
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch(`${url}/manifest`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), redirect: 'error' });
      if (!response.ok) throw new Error('Could not get the Unreal download. Sign in again or retry later.');
      const manifest = Manifest.parse(await response.json());
      this.progress.total = manifest.bytes;
      await fs.mkdir(temporary, { recursive: true });
      const space = await fs.statfs(temporary);
      if (space.bavail * space.bsize < manifest.bytes + manifest.unpackedBytes + 256 * 1024 ** 2) throw new Error('Not enough free space for Unreal. Free space on the drive containing your Archai profile.');
      const pack = await fetch(`${url}/package`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60 * 1000)]), redirect: 'error' });
      if (!pack.ok || !pack.body) throw new Error('The Unreal download failed. Please retry.');
      const digest = createHash('sha256'), archive = path.join(temporary, 'runtime.zip');
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
        this.progress.received += chunk.length;
        if (this.progress.received > manifest.bytes) return done(new Error('Invalid Unreal download size.'));
        digest.update(chunk); done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(pack.body as never), meter, createWriteStream(archive), { signal: controller.signal });
      this.progress.state = 'verifying';
      if (this.progress.received !== manifest.bytes || digest.digest('hex') !== manifest.sha256) throw new Error('Unreal download verification failed. Please download again.');
      await this.authorize(); controller.signal.throwIfAborted();
      this.progress.state = 'installing';
      const staging = path.join(temporary, 'content');
      await extractRuntime(archive, staging, manifest.unpackedBytes, controller.signal);
      await this.authorize(); controller.signal.throwIfAborted();
      await fs.writeFile(path.join(staging, 'installed.json'), JSON.stringify(manifest));
      // Only replaces an incomplete pack of this version; never touches project storage.
      await fs.rm(this.root, { recursive: true, force: true });
      await fs.rename(staging, this.root);
      this.progress.state = 'ready';
    } catch (error) {
      this.progress = { ...this.progress, state: 'error', error: controller.signal.aborted ? 'Download cancelled.' : error instanceof Error ? error.message : String(error) };
    } finally {
      this.controller = null;
      await fs.rm(temporary, { recursive: true, force: true });
    }
    return this.status();
  }
}
