import { z } from 'zod';
import { base64ToBytes } from '@/persistence/base64';
import type { ImageFile } from '@/platform/types';
import { CommandError, defineEffect } from '../contract';
import { createImage } from './create';

export async function pngImage(image: ImageFile): Promise<ImageFile> {
  if (image.mime === 'image/png') return image;
  const bitmap = await createImageBitmap(new Blob([image.bytes as BlobPart], { type: image.mime }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode image')), 'image/png'));
    return { name: image.name, mime: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally { bitmap.close(); }
}

export const pasteImage = defineEffect({
  id: 'paste-image', label: 'Paste image', group: 'create', palette: false,
  input: z.object({ data: z.string().min(1).max(64 * 1024 * 1024), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/svg+xml']), name: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  run: async (ctx, input) => {
    const documentId = ctx.getState().doc.id;
    const bitmap = await createImageBitmap(new Blob([base64ToBytes(input.data) as BlobPart], { type: input.mime }));
    const width = bitmap.width, height = bitmap.height;
    bitmap.close();
    if (ctx.getState().doc.id !== documentId) throw new CommandError('rejected', 'The project changed while pasting');
    const { viewport, canvasSize } = ctx.getState().ui;
    const result = ctx.dispatchSync(createImage, {
      x: input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom,
      y: input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom,
      name: input.name ?? 'Pasted image',
      blob: { mime: input.mime, data: input.data, width, height },
    });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message);
    return result.value;
  },
});

export const copyImage = defineEffect({
  id: 'copy-image', label: 'Copy image', group: 'arrange',
  when: ctx => ctx.ui.selection.length === 1 && ctx.doc.elements[ctx.ui.selection[0]!]?.kind === 'image',
  input: z.void(),
  run: async ctx => {
    const {doc,ui} = ctx.getState();
    const element = doc.elements[ui.selection[0]!];
    if (element?.kind !== 'image') throw new CommandError('rejected', 'Select one image');
    const blob = doc.blobs[element.blobId];
    if (!blob || !ctx.platform.clipboard.writeImage) throw new CommandError('rejected', 'Image clipboard is unavailable');
    await ctx.platform.clipboard.writeImage(await pngImage({ name: element.name ?? 'Image', mime: blob.mime, bytes: base64ToBytes(blob.data) }));
  },
});

export const saveImage = defineEffect({
  id: 'save-image', label: 'Save image…', group: 'document', input: z.void(),
  when: ctx => ctx.ui.selection.length === 1 && ctx.doc.elements[ctx.ui.selection[0]!]?.kind === 'image',
  run: async ctx => {
    const {doc,ui} = ctx.getState();
    const element = doc.elements[ui.selection[0]!];
    if (element?.kind !== 'image') throw new CommandError('rejected', 'Select one image');
    const blob = doc.blobs[element.blobId];
    if (!blob) throw new CommandError('rejected', 'Image data is missing');
    const extension = ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','image/bmp':'bmp'} as Record<string,string>)[blob.mime] ?? 'png';
    const name = (element.name ?? 'Image').replace(/[\\/:*?"<>|]/g, '_').replace(/\.(png|jpe?g|webp|gif|svg|bmp)$/i, '') + '.' + extension;
    return ctx.platform.files.saveBinary(base64ToBytes(blob.data), name, blob.mime);
  },
});
