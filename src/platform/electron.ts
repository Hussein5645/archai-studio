import { IPC, type ArchaiBridge, type OpenDocumentResult, type OpenImageResult, type SaveDocumentResult } from '@shared/ipc';
import { base64ToBytes } from '@/persistence/base64';
import type { Platform } from './types';

declare global {
  interface Window {
    archai?: ArchaiBridge;
  }
}

export function getElectronBridge(): ArchaiBridge | null {
  return typeof window !== 'undefined' && window.archai?.platform === 'electron' ? window.archai : null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function createElectronPlatform(bridge: ArchaiBridge): Platform {
  return {
    kind: 'electron',
    files: {
      async openDocument() {
        const result = await bridge.invoke<OpenDocumentResult | null>(IPC.filesOpenDocument);
        return result ? { path: result.path, name: fileName(result.path), text: result.text } : null;
      },
      async saveDocumentAs(text, suggestedName) {
        const result = await bridge.invoke<SaveDocumentResult | null>(IPC.filesSaveDocumentAs, { text, suggestedName });
        return result ? { path: result.path } : null;
      },
      async saveDocumentTo(path, text) {
        // Main may need to confirm the destination (e.g. a path from a previous session) via a
        // save dialog instead of writing straight through; a cancelled dialog resolves to null.
        const result = await bridge.invoke<SaveDocumentResult | null>(IPC.filesSaveDocumentTo, { path, text });
        return result ? { path: result.path } : null;
      },
      async openImage() {
        const result = await bridge.invoke<OpenImageResult | null>(IPC.filesOpenImage);
        return result ? { name: result.name, mime: result.mime, bytes: base64ToBytes(result.data) } : null;
      },
      async saveBinary(bytes, suggestedName, mime) {
        const result = await bridge.invoke<SaveDocumentResult | null>(IPC.filesSaveBinary, { bytes, suggestedName, mime });
        return result ? { path: result.path } : null;
      },
    },
    storage: {
      get: (key) => bridge.invoke<string | null>(IPC.storageGet, { key }),
      set: (key, value) => bridge.invoke<void>(IPC.storageSet, { key, value }),
      delete: (key) => bridge.invoke<void>(IPC.storageDelete, { key }),
      keys: (prefix) => bridge.invoke<string[]>(IPC.storageKeys, { prefix }),
    },
    clipboard: {
      readText: () => bridge.invoke<string>(IPC.clipboardReadText),
      writeText: (text) => bridge.invoke<void>(IPC.clipboardWriteText, { text }),
    },
    menu: {
      set: (menus) => void bridge.invoke(IPC.menuSet, { menus }),
      onCommand: (listener) => bridge.onCommand(listener),
    },
    window: {
      setTitle: (title) => void bridge.invoke(IPC.windowSetTitle, { title }),
      openModeling: (params) => void bridge.invoke(IPC.windowOpenModeling, params),
      openRender: () => void bridge.invoke(IPC.windowOpenRender),
      setProgress: (progress) => void bridge.invoke(IPC.windowSetProgress, { progress }),
    },
    studio: bridge.onStudio
      ? {
          send: (message) => void bridge.invoke(IPC.studioSend, message),
          subscribe: (listener) => bridge.onStudio!((message) => {
            if (message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') listener(message as { type: string } & Record<string, unknown>);
          }),
        }
      : null,
    links: bridge.onLink
      ? {
          subscribe: (listener) => {
            void bridge.invoke<string | null>(IPC.linkTake).then((url) => url && listener(url));
            return bridge.onLink!(listener);
          },
        }
      : null,
    live: bridge.onLive
      ? {
          serve: (handler) =>
            bridge.onLive!((request) => {
              void handler(request.kind, request.payload).then(
                (result) => bridge.invoke(IPC.liveReply, { id: request.id, ok: true, result }),
                (error: unknown) => bridge.invoke(IPC.liveReply, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
              );
            }),
        }
      : null,
  };
}
