import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readD5Files, readD5Folder } from '../electron/d5Folder';

const roots: string[] = [];
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archai-d5-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'asset'), { recursive: true });
  await fs.writeFile(path.join(root, 'asset/1.save'), '{"furnitureDatas":[]}');
  return root;
}
afterEach(async () => {
  const parent = await fs.realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = await fs.realpath(root);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('archai-d5-'))
      throw new Error('Unexpected test cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
describe('D5 on-demand folder reads', () => {
  it('opens a folder above the former size cap without reading unused files', async () => {
    const root = await project();
    const file = await fs.open(path.join(root, 'asset/unused.d5mesh'), 'w');
    try {
      await file.truncate(300 * 1024 * 1024);
    } finally {
      await file.close();
    }
    const folder = await readD5Folder(root);
    expect(folder.files.map((file) => file.name)).toEqual(['asset/1.save']);
    expect(folder.files[0]!.bytes.byteLength).toBeLessThan(100);
    const unsupported = await readD5Files(root, ['asset/unused.d5mesh']);
    expect(unsupported[0]?.unsupported).toContain('unsupported D5 mesh format');
    expect(unsupported[0]?.bytes.byteLength).toBe(4);
  });
  it('reads only the first existing resource from the scene candidates', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'resource'));
    await fs.writeFile(path.join(root, 'resource/chair.d5a'), 'model');
    await fs.writeFile(path.join(root, 'asset/unused.d5mesh'), 'other model');
    const files = await readD5Files(root, [
      'resource/missing.d5a',
      'resource/chair.d5a',
      'asset/unused.d5mesh',
    ]);
    expect(files.map((file) => file.name)).toEqual(['resource/chair.d5a']);
  });
  it('refuses path traversal and arbitrary project files', async () => {
    const root = await project();
    await expect(readD5Files(root, ['asset/../../private.d5mesh'])).rejects.toThrow('inside');
    await expect(readD5Files(root, ['asset/private.env'])).rejects.toThrow('model or texture');
  });
});
