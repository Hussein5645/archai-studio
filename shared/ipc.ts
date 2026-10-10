/**
 * IPC contract shared by the Electron main process and the renderer.
 *
 * Every channel is namespaced with `archai:` — the preload script only forwards channels
 * under that namespace, and the main process validates every payload with zod, because the
 * renderer is treated as untrusted input.
 */
import { z } from 'zod';

export const IPC = {
  filesOpenDocument: 'archai:files:openDocument',
  filesSaveDocumentAs: 'archai:files:saveDocumentAs',
  filesSaveDocumentTo: 'archai:files:saveDocumentTo',
  filesOpenImage: 'archai:files:openImage',
  filesSaveBinary: 'archai:files:saveBinary',
  filesOpenFiles: 'archai:files:openFiles',
  storageGet: 'archai:storage:get',
  storageSet: 'archai:storage:set',
  storageDelete: 'archai:storage:delete',
  storageKeys: 'archai:storage:keys',
  clipboardReadText: 'archai:clipboard:readText',
  clipboardWriteText: 'archai:clipboard:writeText',
  menuSet: 'archai:menu:set',
  windowSetTitle: 'archai:window:setTitle',
  windowOpenModeling: 'archai:window:openModeling',
  /** Opens (or focuses) the ArchAI Render studio window. */
  windowOpenRender: 'archai:window:openRender',
  /** renderer → main: taskbar progress of long tasks (a fraction, 'indeterminate' or null). */
  windowSetProgress: 'archai:window:setProgress',
  /** renderer → main: a message for the other windows (board ↔ Render studio Live Bridge). */
  studioSend: 'archai:studio:send',
  /** main → renderer: a live-link message from another window. */
  studioEvent: 'archai:studio',
  /** main → renderer: the user picked a menu item bound to a command id. */
  commandEvent: 'archai:command',
  /** main → board renderer: a request from a modelling app's ArchAI plugin (Live Bridge, see electron/liveLink.ts). */
  liveEvent: 'archai:live',
  /** board renderer → main: the answer to a live-link request. */
  liveReply: 'archai:live:reply',
  /** main → board renderer: an archai:// link ArchAI was opened with (invite links). */
  linkEvent: 'archai:link',
  /** board renderer → main: the archai:// link ArchAI was started with, if any (asked once at boot). */
  linkTake: 'archai:link:take',
} as const;

export const DOCUMENT_FILE_EXTENSION = 'AIR';
/** Extensions the open dialog still accepts (older `.archai.json` saves and plain JSON). */
export const LEGACY_DOCUMENT_FILE_EXTENSIONS = ['archai.json', 'json'];

// ---- payload schemas (validated in main) -------------------------------------------------

export const SaveDocumentAsInput = z.object({
  text: z.string(),
  suggestedName: z.string().min(1).max(200),
});
export type SaveDocumentAsInput = z.infer<typeof SaveDocumentAsInput>;

export const SaveDocumentToInput = z.object({ path: z.string().min(1), text: z.string() });
export type SaveDocumentToInput = z.infer<typeof SaveDocumentToInput>;

/** An exported file; the bytes travel as a Uint8Array (structured clone). */
export const SaveBinaryInput = z.object({
  bytes: z.instanceof(Uint8Array),
  suggestedName: z.string().min(1).max(200),
  mime: z.string().max(100),
});
export type SaveBinaryInput = z.infer<typeof SaveBinaryInput>;

/** A multi-file open dialog with the renderer's file-type list (each entry its own dropdown line). */
export const OpenFilesInput = z.object({
  title: z.string().max(200).optional(),
  filters: z.array(z.object({ name: z.string().min(1).max(100), extensions: z.array(z.string().regex(/^(\*|[a-z0-9]{1,10})$/i)).min(1).max(50) })).max(50),
});
export type OpenFilesInput = z.infer<typeof OpenFilesInput>;

export const StorageKeyInput = z.object({ key: z.string().min(1).max(200) });
export const StorageSetInput = z.object({ key: z.string().min(1).max(200), value: z.string() });
export const StorageKeysInput = z.object({ prefix: z.string().max(200) });
export const ClipboardWriteInput = z.object({ text: z.string() });
export const WindowOpenModelingInput = z.object({ assetId: z.string().min(1).max(200), name: z.string().max(200) });
/** A live-link message: `type` plus whatever the studio protocol carries (src/studio/link.ts). */
export const StudioMessageInput = z.object({ type: z.string().min(1).max(40) }).passthrough();
export const WindowSetTitleInput = z.object({ title: z.string().max(300) });
/** The board's answer to a live-link request (`result` may carry bytes as a Uint8Array). */
export const LiveReplyInput = z.object({ id: z.string().min(1).max(40), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(2000).optional() });

/** The live-link / Live Bridge requests the board answers (electron/liveLink.ts). */
export type LiveRequestKind = 'status' | 'push' | 'pull' | 'stop' | 'account' | 'projects' | 'bind';
/** A live-link request to the board (see LiveRequestKind). */
export interface LiveRequest {
  id: string;
  kind: LiveRequestKind;
  payload: Record<string, unknown>;
}

export const MenuItemTemplate: z.ZodType<MenuItemTemplateT> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('separator') }),
    z.object({
      type: z.literal('command'),
      commandId: z.string(),
      label: z.string(),
      accelerator: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('submenu'),
      label: z.string(),
      items: z.array(MenuItemTemplate),
    }),
  ]),
);
export type MenuItemTemplateT =
  | { type: 'separator' }
  | { type: 'command'; commandId: string; label: string; accelerator?: string; enabled?: boolean }
  | { type: 'submenu'; label: string; items: MenuItemTemplateT[] };

export const MenuSetInput = z.object({ menus: z.array(MenuItemTemplate) });
export type MenuSetInput = z.infer<typeof MenuSetInput>;

// ---- results ------------------------------------------------------------------------------

export interface OpenDocumentResult {
  path: string;
  text: string;
}
export interface SaveDocumentResult {
  path: string;
}
export interface OpenImageResult {
  name: string;
  mime: string;
  /** base64-encoded bytes */
  data: string;
}

export interface OpenFileResult {
  name: string;
  bytes: Uint8Array;
}

/** The API the preload script exposes on `window.archai`. */
export interface ArchaiBridge {
  platform: 'electron';
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  onCommand(listener: (commandId: string) => void): () => void;
  /** Live-link messages from other windows (see IPC.studioSend). */
  onStudio?(listener: (message: unknown) => void): () => void;
  /** Live-link requests from plugins (desktop board window). */
  onLive?(listener: (request: LiveRequest) => void): () => void;
  /** archai:// links ArchAI was opened with while running (desktop board window). */
  onLink?(listener: (url: string) => void): () => void;
}
