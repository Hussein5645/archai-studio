import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ClipboardWriteInput,
  DOCUMENT_FILE_EXTENSION,
  LEGACY_DOCUMENT_FILE_EXTENSIONS,
  IPC,
  MenuSetInput,
  SaveBinaryInput,
  SaveDocumentAsInput,
  SaveDocumentToInput,
  OpenFilesInput,
  StorageKeyInput,
  StorageKeysInput,
  StorageSetInput,
  WindowOpenModelingInput,
  StudioMessageInput,
  WindowSetTitleInput,
  type MenuItemTemplateT,
  type OpenDocumentResult,
  type OpenFileResult,
  type OpenImageResult,
  type SaveDocumentResult,
} from '../shared/ipc.js';
import { liveReply, startLiveLink } from './liveLink.js';

const DEV_URL = process.env['ARCHAI_DEV_URL'];
/**
 * The app root: this file is dist-electron/electron/main.js, so two levels up (the asar root
 * when packaged). The renderer build lives in dist/ there.
 */
const APP_ROOT = path.join(import.meta.dirname, '..', '..');
const INDEX_HTML = path.join(APP_ROOT, 'dist', 'index.html');
const STORAGE_DIR = path.join(app.getPath('userData'), 'storage');

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
};

/**
 * WebGL backend. Chromium's default on Windows (ANGLE over Direct3D 11) takes about a minute to
 * compile ArchAI Render's path-tracing shader; OpenGL takes seconds and renders the same.
 * ARCHAI_ANGLE=d3d11|vulkan|gl overrides it.
 */
app.commandLine.appendSwitch('use-angle', process.env['ARCHAI_ANGLE'] || (process.platform === 'win32' ? 'gl' : 'default'));

let mainWindow: BrowserWindow | null = null;

/**
 * archai:// links (invite links: archai://invite/<token>) arrive in the command line, of this
 * launch or of a second one. The board asks for the first one when it is ready (IPC.linkTake).
 */
const linkOf = (argv: readonly string[]): string | null => argv.find((arg) => /^archai:\/\/invite\//i.test(arg)) ?? null;
let pendingLink: string | null = linkOf(process.argv);

/** Paths a native open/save dialog has handed back this session. `filesSaveDocumentTo` only
 * writes straight to one of these, so a compromised renderer can't turn it into an arbitrary
 * file write; anything else (e.g. a document reopened from a previous session's recent list)
 * gets a save dialog defaulted to that path instead of a silent write. */
const knownDocumentPaths = new Set<string>();

/** Renderer routes; the packaged app is served from file://, where only the hash can carry them. */
type Route = '' | `modeling?${string}` | 'render';

function createWindow(route: Route = ''): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#ebedef',
    // The renderer draws its own slim top bar; the OS only contributes the window controls.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f7f8', symbolColor: '#45464b', height: 40 },
    trafficLightPosition: { x: 12, y: 12 },
    autoHideMenuBar: true,
    // Packaged builds take the icon from the executable; build/ is not shipped.
    ...(app.isPackaged ? {} : { icon: path.join(APP_ROOT, 'build', 'icon.png') }),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Shown once the page has painted. Some GPU setups never report that first paint for a hidden
  // window (the app then ran with no window at all), so the loaded page, or at the latest three
  // seconds, shows it too.
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 3000);
  // A page that fails to load never becomes ready-to-show: show the window and say why instead
  // of leaving an invisible process behind.
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (!win.isVisible()) win.show();
    dialog.showErrorBox('ArchAI could not start', `The app window failed to load (${description}, ${code}).\n${url}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    // The app is a single page; any navigation away from it is unexpected.
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  if (DEV_URL) void win.loadURL(route ? `${DEV_URL.replace(/\/$/, '')}/${route}` : DEV_URL);
  else void win.loadFile(INDEX_HTML, route ? { hash: `/${route}` } : undefined);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (modelingWindow === win) modelingWindow = null;
    if (renderWindow === win) renderWindow = null;
  });
  return win;
}

let modelingWindow: BrowserWindow | null = null;

/** One modeling window at a time; a second request loads the new asset into it. */
function openModelingWindow(params: { assetId: string; name: string }): void {
  const route: Route = `modeling?${new URLSearchParams({ asset: params.assetId, name: params.name })}`;
  if (modelingWindow && !modelingWindow.isDestroyed()) {
    if (DEV_URL) void modelingWindow.loadURL(`${DEV_URL.replace(/\/$/, '')}/${route}`);
    else void modelingWindow.loadFile(INDEX_HTML, { hash: `/${route}` });
    modelingWindow.focus();
    return;
  }
  modelingWindow = createWindow(route);
}

let renderWindow: BrowserWindow | null = null;

/** The ArchAI Render studio: one window, live-linked to the board through IPC.studioSend. */
function openRenderWindow(): void {
  if (renderWindow && !renderWindow.isDestroyed()) {
    if (renderWindow.isMinimized()) renderWindow.restore();
    renderWindow.focus();
    return;
  }
  renderWindow = createWindow('render');
  renderWindow.maximize();
}

// ---- storage: one file per key under userData/storage, written atomically -----------------

function storageFile(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(STORAGE_DIR, `${safe}.json`);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

const StoredEntry = z.object({ key: z.string(), value: z.string() });

async function storageGet(key: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(storageFile(key), 'utf8');
    const parsed = StoredEntry.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.key === key ? parsed.data.value : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function storageKeys(prefix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(STORAGE_DIR);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const keys: string[] = [];
  // File names are sanitised keys: only files whose name starts like the prefix can match, so
  // the others (large blobs among them) are not read.
  const safePrefix = path.basename(storageFile(prefix)).slice(0, -'.json'.length);
  for (const name of names) {
    if (!name.endsWith('.json') || !name.startsWith(safePrefix)) continue;
    try {
      const raw = await fs.readFile(path.join(STORAGE_DIR, name), 'utf8');
      const parsed = StoredEntry.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.key.startsWith(prefix)) keys.push(parsed.data.key);
    } catch {
      // A corrupt entry must not take the whole listing down.
    }
  }
  return keys;
}

// ---- menu ----------------------------------------------------------------------------------

function toMenuItems(items: MenuItemTemplateT[]): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.type) {
      case 'separator':
        return { type: 'separator' };
      case 'submenu':
        return { label: item.label, submenu: toMenuItems(item.items) };
      case 'command': {
        const { commandId } = item;
        return {
          label: item.label,
          // Shortcuts are handled by the renderer keymap; the accelerator is display-only so
          // there is exactly one keyboard source of truth.
          accelerator: item.accelerator,
          registerAccelerator: false,
          enabled: item.enabled ?? true,
          click: () => mainWindow?.webContents.send(IPC.commandEvent, commandId),
        };
      }
    }
  });
}

// ---- ipc -----------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.filesOpenDocument, async (): Promise<OpenDocumentResult | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'ArchAI document', extensions: [DOCUMENT_FILE_EXTENSION, DOCUMENT_FILE_EXTENSION.toLowerCase(), ...LEGACY_DOCUMENT_FILE_EXTENSIONS] },
        { name: 'Revit model (export it with the ArchAI add-in)', extensions: ['rvt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    knownDocumentPaths.add(file);
    return { path: file, text: await fs.readFile(file, 'utf8') };
  });

  ipcMain.handle(IPC.filesSaveDocumentAs, async (_e, raw): Promise<SaveDocumentResult | null> => {
    if (!mainWindow) return null;
    const input = SaveDocumentAsInput.parse(raw);
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${input.suggestedName}.${DOCUMENT_FILE_EXTENSION}`,
      filters: [{ name: 'ArchAI document', extensions: [DOCUMENT_FILE_EXTENSION, DOCUMENT_FILE_EXTENSION.toLowerCase()] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomic(result.filePath, input.text);
    knownDocumentPaths.add(result.filePath);
    return { path: result.filePath };
  });

  ipcMain.handle(IPC.filesSaveDocumentTo, async (_e, raw): Promise<SaveDocumentResult | null> => {
    const input = SaveDocumentToInput.parse(raw);
    if (knownDocumentPaths.has(input.path)) {
      await writeAtomic(input.path, input.text);
      return { path: input.path };
    }
    // Not a path this session obtained via a dialog (typically a document reopened from a
    // previous session's recent list): confirm the destination instead of writing blindly.
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: input.path,
      filters: [{ name: 'ArchAI document', extensions: [DOCUMENT_FILE_EXTENSION, DOCUMENT_FILE_EXTENSION.toLowerCase()] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomic(result.filePath, input.text);
    knownDocumentPaths.add(result.filePath);
    return { path: result.filePath };
  });

  ipcMain.handle(IPC.filesSaveBinary, async (_e, raw): Promise<SaveDocumentResult | null> => {
    if (!mainWindow) return null;
    const input = SaveBinaryInput.parse(raw);
    const extension = path.extname(input.suggestedName).slice(1).toLowerCase();
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: input.suggestedName,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, input.bytes);
    return { path: result.filePath };
  });

  ipcMain.handle(IPC.filesOpenImage, async (): Promise<OpenImageResult | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: Object.keys(IMAGE_MIME) }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const ext = path.extname(file).toLowerCase().slice(1);
    const bytes = await fs.readFile(file);
    return {
      name: path.basename(file),
      mime: IMAGE_MIME[ext] ?? 'application/octet-stream',
      data: bytes.toString('base64'),
    };
  });

  ipcMain.handle(IPC.filesOpenFiles, async (_e, raw): Promise<OpenFileResult[]> => {
    if (!mainWindow) return [];
    const input = OpenFilesInput.parse(raw);
    const result = await dialog.showOpenDialog(mainWindow, {
      ...(input.title ? { title: input.title } : {}),
      properties: ['openFile', 'multiSelections'],
      filters: input.filters,
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(async (file) => ({ name: path.basename(file), bytes: new Uint8Array(await fs.readFile(file)) })));
  });

  ipcMain.handle(IPC.storageGet, (_e, raw) => storageGet(StorageKeyInput.parse(raw).key));
  ipcMain.handle(IPC.storageSet, async (_e, raw) => {
    const input = StorageSetInput.parse(raw);
    await writeAtomic(storageFile(input.key), JSON.stringify({ key: input.key, value: input.value }));
  });
  ipcMain.handle(IPC.storageDelete, async (_e, raw) => {
    const input = StorageKeyInput.parse(raw);
    await fs.rm(storageFile(input.key), { force: true });
  });
  ipcMain.handle(IPC.storageKeys, (_e, raw) => storageKeys(StorageKeysInput.parse(raw).prefix));

  ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText());
  ipcMain.handle(IPC.clipboardWriteText, (_e, raw) => {
    clipboard.writeText(ClipboardWriteInput.parse(raw).text);
  });

  ipcMain.handle(IPC.menuSet, (_e, raw) => {
    const input = MenuSetInput.parse(raw);
    Menu.setApplicationMenu(Menu.buildFromTemplate(toMenuItems(input.menus)));
  });

  ipcMain.handle(IPC.windowSetTitle, (event, raw) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(WindowSetTitleInput.parse(raw).title);
  });

  ipcMain.handle(IPC.windowOpenModeling, (_e, raw) => openModelingWindow(WindowOpenModelingInput.parse(raw)));
  ipcMain.handle(IPC.windowOpenRender, () => openRenderWindow());
  // Live link with the modelling-app plugins: the board's answers.
  ipcMain.handle(IPC.liveReply, (_e, raw) => liveReply(raw));
  ipcMain.handle(IPC.linkTake, () => {
    const link = pendingLink;
    pendingLink = null;
    return link;
  });
  // Live link between the board and the Render studio: relay to every other app window.
  ipcMain.handle(IPC.studioSend, (event, raw) => {
    const message = StudioMessageInput.parse(raw);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender && !win.isDestroyed()) win.webContents.send(IPC.studioEvent, message);
    }
  });
}

/**
 * One ArchAI at a time: the plugins start it with an `archai://live?...` link (registered by the
 * installer and below) when their live link finds it closed; a second launch only brings the
 * running window forward, and the live link opens the plugin's project there.
 */
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const link = linkOf(argv);
  if (!win) {
    if (link) pendingLink = link;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (link) win.webContents.send(IPC.linkEvent, link);
});

void app.whenReady().then(() => {
  if (!firstInstance) return;
  // The installer registers archai://; an installed copy without it (older install) claims it once.
  // Dev runs and the unpacked build folder never do (they would take it from the installed app).
  if (app.isPackaged && !/win-unpacked/i.test(process.execPath) && !app.isDefaultProtocolClient('archai')) app.setAsDefaultProtocolClient('archai');
  Menu.setApplicationMenu(null);
  registerIpc();
  mainWindow = createWindow();
  startLiveLink(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null), app.getVersion());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
