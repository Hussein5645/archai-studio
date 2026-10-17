import { z } from 'zod';
import { CommandError, defineEffect } from '../contract';
import { collectPayload, deleteSelection, ElementsPayload, insertElements } from './arrange';
import { copyImage, pasteImage, pngImage, saveImage } from './clipboardImage';
import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';

export const CLIPBOARD_TYPE = 'archai/elements';

const ClipboardEnvelope = z.object({
  type: z.literal(CLIPBOARD_TYPE),
  version: z.literal(1),
  payload: ElementsPayload,
});

/** Fallback for hosts where reading the system clipboard is denied. */
let lastCopied: { text: string; pastes: number } | null = null;

export const copySelection = defineEffect({
  id: 'copy-selection',
  label: 'Copy',
  group: 'arrange',
  shortcuts: ['Mod+C'],
  input: z.void(),
  when: (ctx) => ctx.hasSelection && ctx.ui.editingTextId === null,
  run: async (ctx) => {
    const state = ctx.getState();
    const payload = collectPayload(state.doc, state.ui.selection);
    if (payload.elements.length === 0) throw new CommandError('rejected', 'Nothing to copy');
    const text = JSON.stringify({ type: CLIPBOARD_TYPE, version: 1, payload });
    lastCopied = { text, pastes: 0 };
    try {
      const element = state.ui.selection.length === 1 ? state.doc.elements[state.ui.selection[0]!] : null;
      const blob = element?.kind === 'image' ? state.doc.blobs[element.blobId] : null;
      if (blob && ctx.platform.clipboard.writeImage) await ctx.platform.clipboard.writeImage(await pngImage({name: element!.name ?? 'Image', mime: blob.mime, bytes: base64ToBytes(blob.data)}), text);
      else await ctx.platform.clipboard.writeText(text);
    } catch {
      // The in-memory copy still allows pasting inside the app.
    }
    return payload;
  },
});

export const cutSelection = defineEffect({
  id: 'cut-selection',
  label: 'Cut',
  group: 'arrange',
  shortcuts: ['Mod+X'],
  input: z.void(),
  when: (ctx) => ctx.hasSelection && ctx.ui.editingTextId === null,
  run: async (ctx) => {
    const copied = await ctx.dispatch(copySelection);
    if (!copied.ok) throw new CommandError(copied.error.code, copied.error.message);
    const removed = ctx.dispatchSync(deleteSelection, {});
    if (!removed.ok) throw new CommandError(removed.error.code, removed.error.message);
    return copied.value;
  },
});

export const paste = defineEffect({
  id: 'paste',
  label: 'Paste',
  group: 'arrange',
  shortcuts: ['Mod+V'],
  input: z.object({ offset: z.object({ x: z.number(), y: z.number() }).optional(), text: z.string().optional() }).prefault({}),
  when: (ctx) => ctx.ui.editingTextId === null,
  run: async (ctx, input) => {
    let text: string | null = null;
    let denied = false;
    try {
      text = input.text ?? await ctx.platform.clipboard.readText();
    } catch {
      text = null;
      denied = true;
    }
    let envelope = text ? ClipboardEnvelope.safeParse(tryJson(text)) : null;
    if (!envelope?.success && input.text === undefined && ctx.platform.clipboard.readImage) {
      try {
        const image = await ctx.platform.clipboard.readImage();
        if (image) {
          const result = await ctx.dispatch('paste-image', {data:bytesToBase64(image.bytes), mime:image.mime, name:image.name});
          if (!result.ok) throw new CommandError(result.error.code,result.error.message);
          return result.value;
        }
      } catch (error) { if (error instanceof CommandError) throw error; }
    }
    if (!envelope?.success && (denied || !text) && lastCopied) envelope = ClipboardEnvelope.safeParse(tryJson(lastCopied.text));
    if (!envelope?.success) throw new CommandError('rejected', 'The clipboard has no ArchAI elements');

    const isRepeat = lastCopied && text === lastCopied.text;
    const step = isRepeat ? ++lastCopied!.pastes : 1;
    const offset = input.offset ?? { x: 200 * step, y: 200 * step };
    const inserted = ctx.dispatchSync(insertElements, { ...envelope.data.payload, offset });
    if (!inserted.ok) throw new CommandError(inserted.error.code, inserted.error.message, inserted.error.details);
    return inserted.value;
  },
});

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const clipboardCommands = [copySelection, cutSelection, paste, pasteImage, copyImage, saveImage];
