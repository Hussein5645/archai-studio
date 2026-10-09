import { z } from 'zod';
import type { JsonValue } from '@/document';
import { CommandError, defineMutation } from '../contract';
import { createRect } from './create';

export interface AiPortalMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: number;
}

export const createAiPortal = defineMutation({
  id: 'create-ai-portal',
  label: 'Add AI Portal',
  description: 'Places an AI portal on the board with an interactive chat window.',
  aliases: ['ai portal', 'chat portal', 'assistant portal'],
  group: 'create',
  history: 'record',
  input: z
    .object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().positive().default(4000),
      height: z.number().positive().default(3000),
    })
    .prefault({}),
  run: (ctx, input) => {
    const { viewport, canvasSize } = ctx.ui;
    const x = input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom - input.width / 2;
    const y = input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom - input.height / 2;
    return createRect.run(ctx, {
      x,
      y,
      width: input.width,
      height: input.height,
      radius: 36,
      rotation: 0,
      style: { fill: '#e9ecf1', stroke: null, strokeWidth: 0, opacity: 1 },
      name: 'AI Portal',
      meta: {
        aiPortal: {
          messages: [],
        } as unknown as JsonValue,
      },
      parentId: null,
      select: true,
    });
  },
});

export const sendAiPortalMessage = defineMutation({
  id: 'send-ai-portal-message',
  label: 'Send AI Portal Message',
  description: 'Sends a message to the AI portal and receives an AI response.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    id: z.string(),
    text: z.string().min(1),
  }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || element.kind !== 'rect' || !element.meta?.['aiPortal']) {
      throw new CommandError('rejected', 'Not an AI Portal element');
    }
    const currentMeta = (element.meta['aiPortal'] as { messages?: AiPortalMessage[] }) ?? {};
    const messages = [...(currentMeta.messages ?? [])];
    const userMsg: AiPortalMessage = {
      id: ctx.ids.next('el'),
      sender: 'user',
      text: input.text.trim(),
      timestamp: Date.now(),
    };
    const aiMsg: AiPortalMessage = {
      id: ctx.ids.next('el'),
      sender: 'ai',
      text: 'AI coming soon',
      timestamp: Date.now() + 10,
    };
    messages.push(userMsg, aiMsg);
    element.meta = {
      ...element.meta,
      aiPortal: {
        ...currentMeta,
        messages,
      } as unknown as JsonValue,
    };
  },
});

export const clearAiPortalMessages = defineMutation({
  id: 'clear-ai-portal-messages',
  label: 'Clear AI Portal Messages',
  description: 'Clears all messages in an AI portal.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    id: z.string(),
  }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || element.kind !== 'rect' || !element.meta?.['aiPortal']) {
      throw new CommandError('rejected', 'Not an AI Portal element');
    }
    element.meta = {
      ...element.meta,
      aiPortal: {
        messages: [],
      } as unknown as JsonValue,
    };
  },
});

export const aiPortalCommands = [createAiPortal, sendAiPortalMessage, clearAiPortalMessages];
