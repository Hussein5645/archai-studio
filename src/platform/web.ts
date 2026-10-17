/**
 * Browser fallback: IndexedDB for storage, file inputs and downloads for documents. This keeps
 * the renderer fully usable (and testable with Playwright) outside Electron.
 */
import { DOCUMENT_FILE_EXTENSION, LEGACY_DOCUMENT_FILE_EXTENSIONS } from '@shared/ipc';
import type { ImageFile, Platform } from './types';

const DB_NAME = 'archai';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

/** Downloads bytes as a file (browsers have no save dialog the page can open). */
export function downloadFile(bytes: Uint8Array | string, name: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    files: {
      async openDocument() {
        const file = await pickFile([DOCUMENT_FILE_EXTENSION, DOCUMENT_FILE_EXTENSION.toLowerCase(), ...LEGACY_DOCUMENT_FILE_EXTENSIONS, 'rvt'].map((ext) => `.${ext}`).join(','));
        return file ? { path: null, name: file.name, text: await file.text() } : null;
      },
      async saveDocumentAs(text, suggestedName) {
        download(`${suggestedName}.${DOCUMENT_FILE_EXTENSION}`, text);
        return { path: null };
      },
      async saveDocumentTo(_path, text) {
        download(`document.${DOCUMENT_FILE_EXTENSION}`, text);
        return { path: null };
      },
      async openImage(): Promise<ImageFile | null> {
        const file = await pickFile('image/*');
        if (!file) return null;
        return { name: file.name, mime: file.type || 'image/png', bytes: new Uint8Array(await file.arrayBuffer()) };
      },
      async saveBinary(bytes, suggestedName, mime) {
        downloadFile(bytes, suggestedName, mime);
        return { path: null };
      },
    },
    storage: {
      get: (key) => withStore<string | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null),
      set: (key, value) => withStore('readwrite', (s) => s.put(value, key)).then(() => undefined),
      delete: (key) => withStore('readwrite', (s) => s.delete(key)).then(() => undefined),
      keys: (prefix) =>
        withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
          keys.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)),
        ),
    },
    clipboard: {
      readText: () => navigator.clipboard.readText(),
      writeText: (text) => navigator.clipboard.writeText(text),
      readImage: async () => {
        for (const item of await navigator.clipboard.read()) {
          const mime = item.types.find(type => type.startsWith('image/'));
          if (mime) return { name: 'Pasted image.png', mime, bytes: new Uint8Array(await (await item.getType(mime)).arrayBuffer()) };
        }
        return null;
      },
      writeImage: (image, text) => navigator.clipboard.write([new ClipboardItem({
        [image.mime]: new Blob([image.bytes as BlobPart], { type: image.mime }),
        ...(text ? { 'text/plain': new Blob([text], { type: 'text/plain' }) } : {}),
      })]),
    },
    menu: null,
    window: {
      setTitle: (title) => {
        document.title = title;
      },
      openModeling: ({ assetId, name, projectId }) => {
        const params = new URLSearchParams({ asset: assetId, name });
        if (projectId) params.set('project', projectId);
        window.open(`/modeling?${params.toString()}`, '_blank', 'noopener');
      },
      openRender: () => {
        window.open('/render', 'archai-render');
      },
    },
    studio: browserStudioChannel(),
  };
}

/** Board ↔ Render studio messages between tabs of the same origin. */
function browserStudioChannel(): Platform['studio'] {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel('archai-studio');
  return {
    send: (message) => channel.postMessage(message),
    subscribe: (listener) => {
      const handler = (event: MessageEvent) => {
        const data = event.data as unknown;
        if (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string') listener(data as { type: string } & Record<string, unknown>);
      };
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
  };
}
