import fs from 'node:fs/promises';
import path from 'node:path';
import type { D5FolderResult, D5ResourceResult } from '../shared/ipc.js';

const MAX_RESOURCE_BYTES = 256 * 1024 * 1024;

/** Read one requested resource at a time, in preference order. Never traverse the project tree. */
export async function readD5Files(
  folder: string,
  names: readonly string[],
): Promise<D5ResourceResult[]> {
  const root = await fs.realpath(folder);
  for (const name of names) {
    const relative = name.replaceAll('\\', '/');
    if (
      relative.includes(':') ||
      relative.startsWith('/') ||
      relative.split('/').some((part) => part === '..' || part === '.') ||
      !/^(?:asset|resource)\//i.test(relative) ||
      !/\.(?:save|d5a|d5mesh|png|jpe?g)$/i.test(relative)
    )
      throw new Error(
        'D5 resource path must stay inside the selected project folder and refer to a model or texture.',
      );
    let full: string;
    try {
      full = await fs.realpath(path.join(root, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const resolved = path.relative(root, full);
    if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved))
      throw new Error('D5 resource links outside the selected project folder are not supported.');
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    if (/\.d5mesh$/i.test(relative) && stat.size >= 4) {
      const file = await fs.open(full, 'r');
      const header = Buffer.alloc(4);
      try {
        await file.read(header, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (header.readUInt32LE() !== 11)
        return [
          {
            name: relative,
            bytes: header,
            unsupported: 'This resource uses an unsupported D5 mesh format.',
          },
        ];
    }
    if (stat.size > MAX_RESOURCE_BYTES)
      return [
        {
          name: relative,
          bytes: new Uint8Array(),
          unsupported: `This individual resource exceeds the 256 MB decode budget (${Math.round(stat.size / 1024 / 1024)} MB).`,
        },
      ];
    const bytes = new Uint8Array(await fs.readFile(full));
    if (bytes.byteLength !== stat.size)
      throw new Error('The D5 project changed while reading. Finish saving in D5, then retry.');
    return [{ name: relative, bytes }];
  }
  return [];
}

/** Read only the scene index. Meshes and textures are requested during conversion. */
export async function readD5Folder(folder: string): Promise<D5FolderResult> {
  const files = await readD5Files(folder, ['asset/1.save']);
  if (!files.length) throw new Error('Choose the D5 project folder containing asset/1.save.');
  if (files[0]?.unsupported)
    throw new Error(`The D5 scene index cannot be read: ${files[0].unsupported}`);
  return { name: path.basename(await fs.realpath(folder)), files };
}
