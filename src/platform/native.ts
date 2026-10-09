/**
 * Native tablet/phone host (the Kotlin Multiplatform app in `native/`): the web app runs in the
 * system WebView and reaches the host through the same `archai:` channels and payloads the
 * Electron main process serves (see `@shared/ipc`). Messages are JSON envelopes
 * `{ id, channel, payload }` answered by `{ id, ok, value }` or `{ id, ok: false, error }`.
 */
import { IPC, type OpenDocumentResult, type OpenImageResult, type SaveDocumentResult } from '@shared/ipc';
import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';
import { downloadFile } from './web';
import type { Platform } from './types';

interface NativeReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Sends one serialised envelope and resolves with the host's serialised reply. */
type NativeTransport = (message: string) => Promise<string>;

interface AndroidHostPort {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}

interface IosHostHandler {
  postMessage(message: string): Promise<string>;
}

declare global {
  interface Window {
    /** Injected by the Android host (WebViewCompat.addWebMessageListener). */
    ArchaiNativeHost?: AndroidHostPort;
    webkit?: { messageHandlers?: { archaiNative?: IosHostHandler } };
  }
}

/** Android answers asynchronously on the same port, so replies are matched to requests by id. */
function androidTransport(port: AndroidHostPort): NativeTransport {
  const pending = new Map<number, (reply: string) => void>();
  port.onmessage = (event) => {
    const id = (JSON.parse(event.data) as NativeReply).id;
    pending.get(id)?.(event.data);
    pending.delete(id);
  };
  return (message) =>
    new Promise((resolve) => {
      pending.set((JSON.parse(message) as { id: number }).id, resolve);
      port.postMessage(message);
    });
}

export function getNativeTransport(): NativeTransport | null {
  if (typeof window === 'undefined') return null;
  if (window.ArchaiNativeHost) return androidTransport(window.ArchaiNativeHost);
  const ios = window.webkit?.messageHandlers?.archaiNative;
  // WKScriptMessageHandlerWithReply: postMessage returns the host's reply as a promise.
  if (ios) return (message) => ios.postMessage(message);
  return null;
}

export function createNativePlatform(transport: NativeTransport): Platform {
  let nextId = 1;
  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const reply = JSON.parse(await transport(JSON.stringify({ id: nextId++, channel, payload: payload ?? null }))) as NativeReply;
    if (!reply.ok) throw new Error(reply.error ?? `${channel} failed`);
    return reply.value as T;
  };
  return {
    kind: 'native',
    files: {
      async openDocument() {
        const result = await invoke<(OpenDocumentResult & { name: string }) | null>(IPC.filesOpenDocument);
        // `path` is a host handle (a content URI on Android, a file URL on iOS) that
        // saveDocumentTo accepts back; `name` is the display name.
        return result ? { path: result.path, name: result.name, text: result.text } : null;
      },
      async saveDocumentAs(text, suggestedName) {
        const result = await invoke<SaveDocumentResult | null>(IPC.filesSaveDocumentAs, { text, suggestedName });
        return result ? { path: result.path } : null;
      },
      async saveDocumentTo(path, text) {
        // The host falls back to a save dialog when it can no longer write to `path`.
        const result = await invoke<SaveDocumentResult | null>(IPC.filesSaveDocumentTo, { path, text });
        return result ? { path: result.path } : null;
      },
      async openImage() {
        const result = await invoke<OpenImageResult | null>(IPC.filesOpenImage);
        return result ? { name: result.name, mime: result.mime, bytes: base64ToBytes(result.data) } : null;
      },
      async saveBinary(bytes, suggestedName, mime) {
        // The bridge carries JSON: bytes go as base64. Hosts without the channel get a download.
        try {
          const result = await invoke<SaveDocumentResult | null>(IPC.filesSaveBinary, { data: bytesToBase64(bytes), suggestedName, mime });
          return result ? { path: result.path } : null;
        } catch {
          downloadFile(bytes, suggestedName, mime);
          return { path: null };
        }
      },
    },
    storage: {
      get: (key) => invoke<string | null>(IPC.storageGet, { key }),
      set: (key, value) => invoke<void>(IPC.storageSet, { key, value }),
      delete: (key) => invoke<void>(IPC.storageDelete, { key }),
      keys: (prefix) => invoke<string[]>(IPC.storageKeys, { prefix }),
    },
    clipboard: {
      readText: () => invoke<string | null>(IPC.clipboardReadText),
      writeText: (text) => invoke<void>(IPC.clipboardWriteText, { text }),
    },
    // Tablets have no menu bar; the app's own shortcuts and toolbar cover the commands.
    menu: null,
    window: {
      setTitle: (title) => {
        document.title = title;
      },
      // One WebView for now: the modeling workspace replaces the board (which autosaves).
      openModeling: ({ assetId, name, projectId }) => {
        const params = new URLSearchParams({ asset: assetId, name });
        if (projectId) params.set('project', projectId);
        window.location.assign(`/modeling?${params.toString()}`);
      },
      // One WebView: ArchAI Render runs in the desktop app.
      openRender: null,
    },
    studio: null,
  };
}
