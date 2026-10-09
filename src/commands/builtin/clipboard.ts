import { z } from 'zod';
import { CommandError, defineEffect } from '../contract';
import { collectPayload, deleteSelection, ElementsPayload, insertElements } from './arrange';

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
      await ctx.platform.clipboard.writeText(text);
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
  input: z.object({ offset: z.object({ x: z.number(), y: z.number() }).optional() }).prefault({}),
  when: (ctx) => ctx.ui.editingTextId === null,
  run: async (ctx, input) => {
    let text: string | null = null;
    try {
      text = await ctx.platform.clipboard.readText();
    } catch {
      text = null;
    }
    let envelope = text ? ClipboardEnvelope.safeParse(tryJson(text)) : null;
    if (!envelope?.success && lastCopied) envelope = ClipboardEnvelope.safeParse(tryJson(lastCopied.text));
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

export const clipboardCommands = [copySelection, cutSelection, paste];
