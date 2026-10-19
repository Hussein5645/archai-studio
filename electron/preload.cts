// Sandboxed preload: it can only require 'electron' and a few Node built-ins, so it must stay
// self-contained. It exposes a minimal, namespaced bridge to the renderer.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed preloads must use require()
const { contextBridge, ipcRenderer } = require('electron');

const NAMESPACE = 'archai:';
const COMMAND_EVENT = 'archai:command';
const STUDIO_EVENT = 'archai:studio';
const LIVE_EVENT = 'archai:live';
const LINK_EVENT = 'archai:link';

contextBridge.exposeInMainWorld('archai', {
  platform: 'electron',
  onBeforeClose(listener: () => Promise<void>): () => void {
    const handler = (_event: unknown, id: unknown) => {
      if (typeof id !== 'string') return;
      void Promise.resolve().then(listener).then(
        () => ipcRenderer.send('archai:window:saved', { id, ok: true }),
        (error: unknown) => ipcRenderer.send('archai:window:saved', { id, ok: false, error: error instanceof Error ? error.message : 'The project could not be saved.' }),
      );
    };
    ipcRenderer.on('archai:window:save', handler);
    ipcRenderer.send('archai:window:save-ready', true);
    return () => {
      ipcRenderer.removeListener('archai:window:save', handler);
      ipcRenderer.send('archai:window:save-ready', false);
    };
  },
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (typeof channel !== 'string' || !channel.startsWith(NAMESPACE)) {
      return Promise.reject(new Error(`Refused IPC channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onCommand(listener: (commandId: string) => void): () => void {
    const handler = (_event: unknown, commandId: unknown) => {
      if (typeof commandId === 'string') listener(commandId);
    };
    ipcRenderer.on(COMMAND_EVENT, handler);
    return () => ipcRenderer.removeListener(COMMAND_EVENT, handler);
  },
  onStudio(listener: (message: unknown) => void): () => void {
    const handler = (_event: unknown, message: unknown) => listener(message);
    ipcRenderer.on(STUDIO_EVENT, handler);
    return () => ipcRenderer.removeListener(STUDIO_EVENT, handler);
  },
  onLive(listener: (request: unknown) => void): () => void {
    const handler = (_event: unknown, request: unknown) => listener(request);
    ipcRenderer.on(LIVE_EVENT, handler);
    return () => ipcRenderer.removeListener(LIVE_EVENT, handler);
  },
  onLink(listener: (url: string) => void): () => void {
    const handler = (_event: unknown, url: unknown) => {
      if (typeof url === 'string') listener(url);
    };
    ipcRenderer.on(LINK_EVENT, handler);
    return () => ipcRenderer.removeListener(LINK_EVENT, handler);
  },
});
