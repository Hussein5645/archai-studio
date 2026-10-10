/**
 * The only boundary between the renderer and the host. Electron, the native tablet host and the
 * plain browser each implement it; nothing else in `src/` may import Electron.
 */
import type { MenuItemTemplateT } from '@shared/ipc';

export interface ImageFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface OpenedDocumentFile {
  /** Absolute path on disk (Electron) or null when the host cannot provide one (web). */
  path: string | null;
  name: string;
  text: string;
}

export interface Platform {
  kind: 'electron' | 'native' | 'web';
  files: {
    openDocument(): Promise<OpenedDocumentFile | null>;
    /** Returns null when the user cancels. `path` is null on hosts that download instead. */
    saveDocumentAs(text: string, suggestedName: string): Promise<{ path: string | null } | null>;
    /** Writes to a known path; hosts without a filesystem fall back to `saveDocumentAs`. */
    saveDocumentTo(path: string, text: string): Promise<{ path: string | null } | null>;
    openImage(): Promise<ImageFile | null>;
    /**
     * Saves an exported file (PDF, image, CAD...): a native Save dialog on desktop, a download
     * on the web. Returns null when the user cancels.
     */
    saveBinary(bytes: Uint8Array, suggestedName: string, mime: string): Promise<{ path: string | null } | null>;
  };
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix: string): Promise<string[]>;
  };
  clipboard: {
    readText(): Promise<string | null>;
    writeText(text: string): Promise<void>;
  };
  menu: {
    set(menus: MenuItemTemplateT[]): void;
    onCommand(listener: (commandId: string) => void): () => void;
  } | null;
  window: {
    setTitle(title: string): void;
    /** Opens the modeling workspace (`/modeling?asset=…&name=…`) in a new tab or desktop window. */
    openModeling(params: { assetId: string; name: string; projectId?: string }): void;
    /** Opens the ArchAI Render studio (`/render`); null on hosts without it (the tablet app). */
    openRender: (() => void) | null;
    /**
     * Progress of long tasks on the host's own indicator (the desktop taskbar button): a fraction,
     * 'indeterminate', or null to clear it. Absent where the host has none.
     */
    setProgress?: (progress: number | 'indeterminate' | null) => void;
  };
  /**
   * Messages between this window and the Render studio window (IPC relay on desktop, a
   * BroadcastChannel in the browser); null on hosts with one window.
   */
  studio: {
    send(message: { type: string } & Record<string, unknown>): void;
    subscribe(listener: (message: { type: string } & Record<string, unknown>) => void): () => void;
  } | null;
  /**
   * Live link with the modelling-app plugins (desktop only, see electron/liveLink.ts): the board
   * answers each request; null elsewhere.
   */
  /**
   * archai:// links the app was opened with (desktop: invite links); the link it started with is
   * delivered to the first subscriber. Null on hosts without them.
   */
  links?: {
    subscribe(listener: (url: string) => void): () => void;
  } | null;
  live?: {
    serve(handler: (kind: 'status' | 'push' | 'pull' | 'stop' | 'account', payload: Record<string, unknown>) => Promise<unknown>): () => void;
  } | null;
}
