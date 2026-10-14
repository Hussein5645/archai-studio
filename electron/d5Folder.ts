import fs from 'node:fs/promises';
import path from 'node:path';
import type { D5FolderResult } from '../shared/ipc.js';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;

/** Only reads the selected folder's D5 data. Never follows links or resolves external D5 paths. */
export async function readD5Folder(folder: string): Promise<D5FolderResult> {
  const root = await fs.realpath(folder);
  const files: D5FolderResult['files'] = [];
  let total = 0;
  async function walk(relative: string): Promise<void> {
    const directory = path.join(root, relative);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw new Error(
          'D5 folders containing linked files are not supported. Copy the project into one folder.',
        );
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (relative || ['asset', 'resource'].includes(entry.name.toLowerCase())) await walk(name);
      } else if (entry.isFile() && /\.(save|d5a|d5mesh|json|drs|png|jpe?g|webp|exr)$/i.test(name)) {
        const full = path.join(root, name);
        const stat = await fs.stat(full);
        total += stat.size;
        if (total > MAX_BYTES || files.length >= MAX_FILES)
          throw new Error(
            'This D5 folder exceeds the import limit (256 MB or 10,000 files). Export a smaller scene.',
          );
        const bytes = new Uint8Array(await fs.readFile(full));
        if (bytes.byteLength !== stat.size)
          throw new Error('The D5 project changed while reading. Finish saving in D5, then retry.');
        files.push({ name: name.replaceAll('\\', '/'), bytes });
      }
    }
  }
  await walk('');
  if (!files.some((file) => file.name.toLowerCase() === 'asset/1.save'))
    throw new Error('Choose the D5 project folder containing asset/1.save.');
  return { name: path.basename(root), files };
}
