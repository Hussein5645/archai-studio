import { z } from 'zod';
import { createEmptyDocument, DocumentSchema, type ElementTable } from '@/document';
import { fitBounds, rootBounds } from '@/geometry';
import { parseDocument, serializeDocument } from '@/persistence/serialize';
import { isRevitExchange } from '@/revit/exchange';
import { createDocumentFromTemplate, ArchaiTemplateSchema } from '@/persistence/templates';
import { DEFAULT_VIEWPORT } from '@/store';
import { CommandError, defineEffect, defineMutation, type EffectContext } from '../contract';

/**
 * Whether replacing the current document would lose work: either it has unsaved changes, or it
 * has content but was never saved to a file (only autosaved locally).
 */
export function documentNeedsSaveCopy(state: { doc: { elements: ElementTable }; session: { dirty: boolean; filePath: string | null } }): boolean {
  if (state.session.dirty) return true;
  return state.session.filePath === null && Object.keys(state.doc.elements).length > 0;
}

export const setScreen = defineMutation({
  id: 'set-screen',
  label: 'Switch screen',
  group: 'document',
  palette: false,
  history: 'none',
  input: z.object({ screen: z.enum(['home', 'project']) }),
  run: (ctx, input) => {
    ctx.ui.screen = input.screen;
  },
});

export const goHome = defineEffect({
  id: 'go-home',
  label: 'Home screen',
  description: 'Returns to the project home screen.',
  group: 'document',
  shortcuts: ['Mod+Shift+H'],
  input: z.void(),
  run: async (ctx) => {
    ctx.dispatchSync(setScreen, { screen: 'home' });
  },
});

export const setTemplateSavePrompt = defineMutation({
  id: 'set-template-save-prompt',
  label: 'Set save template prompt state',
  group: 'document',
  palette: false,
  history: 'none',
  input: z.object({ open: z.boolean() }),
  run: (ctx, input) => {
    ctx.ui.templateSavePrompt = input.open;
  },
});

export const setTemplateCreatePrompt = defineMutation({
  id: 'set-template-create-prompt',
  label: 'Set create project template prompt state',
  group: 'document',
  palette: false,
  history: 'none',
  input: z.object({ open: z.boolean() }),
  run: (ctx, input) => {
    ctx.ui.templateCreatePrompt = input.open;
  },
});

export const createProjectFromTemplate = defineMutation({
  id: 'create-project-from-template',
  label: 'Create project from template',
  group: 'document',
  palette: false,
  history: 'none',
  resetsHistory: true,
  input: z.object({
    name: z.string().max(200).optional(),
    template: ArchaiTemplateSchema.nullable().optional(),
  }),
  run: (ctx, input) => {
    const doc = createDocumentFromTemplate(input.template ?? null, input.name || 'Untitled', ctx.ids, ctx.now);
    Object.assign(ctx.doc, doc);
    ctx.ui.selection = [];
    ctx.ui.editingTextId = null;
    ctx.ui.tool = 'select';
    ctx.ui.viewport = { ...DEFAULT_VIEWPORT };
    ctx.session.filePath = null;
    ctx.session.dirty = false;
    ctx.session.savedAt = null;
    ctx.ui.documentPrompt = null;
    ctx.ui.templateCreatePrompt = false;
    ctx.ui.screen = 'project';
    return doc.id;
  },
});

export const setDocumentPrompt = defineMutation({
  id: 'set-document-prompt',
  label: 'Show or hide the new/open file prompt',
  palette: false,
  group: 'document',
  history: 'none',
  input: z.object({ kind: z.enum(['new', 'open']).nullable() }),
  run: (ctx, input) => {
    ctx.ui.documentPrompt = input.kind;
  },
});

export const promptNewDocument = defineMutation({
  id: 'prompt-new-document',
  label: 'New document…',
  description: 'Asks for a name (and whether to save a copy of the current file) before creating a new file.',
  aliases: ['new file', 'clear board'],
  group: 'document',
  shortcuts: ['Mod+N'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.documentPrompt = 'new';
  },
});

export const newDocument = defineMutation({
  id: 'new-document',
  label: 'New document',
  description: 'Replaces the current document with an empty one immediately; the UI goes through `prompt-new-document`.',
  group: 'document',
  palette: false,
  history: 'none',
  resetsHistory: true,
  input: z.object({
    name: z.string().max(200).optional(),
    /** Keep this id (a project link whose working copy is not stored yet), so it is not forked. */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
  }).prefault({}),
  run: (ctx, input) => {
    const doc = createEmptyDocument({ ids: ctx.ids, now: ctx.now, name: input.name });
    if (input.id) doc.id = input.id;
    Object.assign(ctx.doc, doc);
    ctx.ui.selection = [];
    ctx.ui.editingTextId = null;
    ctx.ui.tool = 'select';
    ctx.ui.viewport = { ...DEFAULT_VIEWPORT };
    ctx.session.filePath = null;
    ctx.session.dirty = false;
    ctx.session.savedAt = null;
    ctx.ui.documentPrompt = null;
    ctx.ui.screen = 'project';
    return doc.id;
  },
});

export const loadDocument = defineMutation({
  id: 'load-document',
  label: 'Load document',
  description: 'Replaces the current document with an already-validated one.',
  group: 'document',
  palette: false,
  history: 'none',
  resetsHistory: true,
  input: z.object({
    document: DocumentSchema,
    filePath: z.string().nullable().default(null),
  }),
  run: (ctx, input) => {
    Object.assign(ctx.doc, input.document);
    ctx.ui.selection = [];
    ctx.ui.editingTextId = null;
    ctx.ui.tool = 'select';
    const bounds = rootBounds(input.document.elements as ElementTable);
    if (bounds) {
      const next = fitBounds(bounds, ctx.ui.canvasSize);
      ctx.ui.viewport = { x: next.x, y: next.y, zoom: next.zoom };
    } else {
      ctx.ui.viewport = { ...DEFAULT_VIEWPORT };
    }
    ctx.session.filePath = input.filePath;
    ctx.session.dirty = false;
    ctx.session.savedAt = null;
    ctx.ui.screen = 'project';
    return input.document.id;
  },
});

export const markSaved = defineMutation({
  id: 'mark-saved',
  label: 'Mark saved',
  group: 'document',
  palette: false,
  history: 'none',
  input: z.object({ filePath: z.string().nullable(), savedAt: z.string() }),
  run: (ctx, input) => {
    ctx.session.filePath = input.filePath;
    ctx.session.dirty = false;
    ctx.session.savedAt = input.savedAt;
  },
});

export const promptOpenDocument = defineEffect({
  id: 'prompt-open-document',
  label: 'Open…',
  description: 'Opens an ArchAI document (.AIR) from a file, first offering to save a copy of the current one.',
  aliases: ['import document', 'import json', 'load file', 'open file'],
  group: 'document',
  shortcuts: ['Mod+O'],
  input: z.void(),
  run: async (ctx) => {
    if (documentNeedsSaveCopy(ctx.getState())) {
      // The prompt dispatches `open-document` once the user has saved a copy or chosen not to.
      ctx.dispatchSync(setDocumentPrompt, { kind: 'open' });
      return null;
    }
    const result = await ctx.dispatch(openDocument);
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.details);
    return result.value;
  },
});

export const openDocument = defineEffect({
  id: 'open-document',
  label: 'Open file',
  description: 'Opens an ArchAI document (.AIR) from a file without asking about the current one; the UI goes through `prompt-open-document`.',
  group: 'document',
  palette: false,
  input: z.void(),
  run: async (ctx) => {
    ctx.dispatchSync(setDocumentPrompt, { kind: null });
    const file = await ctx.platform.files.openDocument();
    if (!file) return null;
    if (/.(rvt|rfa|rte)$/i.test(file.name)) {
      throw new CommandError('rejected', `${file.name}: Revit files open through the ArchAI add-in for Revit. In Revit choose ArchAI > Send to ArchAI, then open the exported .AIR file here.`);
    }
    const revit = revitExchangeOf(file.text);
    if (revit) {
      // A Revit export: a new project built from it with ArchAI's own commands (one undo step).
      const name = typeof revit['name'] === 'string' && revit['name'].trim() ? revit['name'] : file.name.replace(/.[^.]+$/, '');
      ctx.dispatchSync('new-document', { name });
      const imported = ctx.dispatchSync('import-revit-model', { model: revit });
      if (!imported.ok) throw new CommandError(imported.error.code, `${file.name}: ${imported.error.message}`, imported.error.details);
      ctx.dispatchSync('zoom-to-fit', {});
      return { id: ctx.getState().doc.id, path: null, migratedFrom: null, revit: imported.value };
    }
    const parsed = parseDocument(file.text);
    if (!parsed.ok) throw new CommandError('rejected', `${file.name}: ${parsed.error.message}`, parsed.error.details);
    const result = ctx.dispatchSync(loadDocument, { document: parsed.document, filePath: file.path });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.details);
    return { id: parsed.document.id, path: file.path, migratedFrom: parsed.migratedFrom };
  },
});

/** The parsed JSON when a file is a Revit export (see src/revit/exchange.ts), else null. */
function revitExchangeOf(text: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(text);
    return isRevitExchange(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The text of a saved .AIR file: the document plus its 3D snapshot (`scene3d`, what the ArchAI
 * plugins for other apps import; docs/plugins.md). Saving never fails over the snapshot.
 */
async function fileText(ctx: EffectContext): Promise<string> {
  const doc = ctx.getState().doc;
  try {
    // Loaded on demand: the exporter and three.js stay out of the command registry's import graph.
    const [{ exportSceneSnapshot }, { bytesToBase64 }] = await Promise.all([import('@/view3d/vrExport'), import('@/persistence/base64')]);
    const glb = await exportSceneSnapshot(doc, ctx.catalog);
    return serializeDocument(doc, { format: 'glb', version: 1, units: 'm', up: 'y', data: bytesToBase64(new Uint8Array(glb)) });
  } catch {
    return serializeDocument(doc);
  }
}

async function saveAs(ctx: EffectContext): Promise<{ path: string | null } | null> {
  const state = ctx.getState();
  const text = await fileText(ctx);
  const saved = await ctx.platform.files.saveDocumentAs(text, state.doc.meta.name || 'Untitled');
  if (!saved) return null;
  ctx.dispatchSync(markSaved, { filePath: saved.path, savedAt: ctx.now() });
  return saved;
}

export const saveDocumentAs = defineEffect({
  id: 'save-document-as',
  label: 'Save as…',
  description: 'Saves the document as versioned JSON to a location you choose.',
  aliases: ['export document', 'export json', 'download'],
  group: 'document',
  shortcuts: ['Mod+Shift+S'],
  input: z.void(),
  run: async (ctx) => saveAs(ctx),
});

export const saveDocument = defineEffect({
  id: 'save-document',
  label: 'Save',
  aliases: ['save file'],
  group: 'document',
  shortcuts: ['Mod+S'],
  input: z.void(),
  run: async (ctx) => {
    const state = ctx.getState();
    if (!state.session.filePath) return saveAs(ctx);
    const text = await fileText(ctx);
    const saved = await ctx.platform.files.saveDocumentTo(state.session.filePath, text);
    if (!saved) return null;
    ctx.dispatchSync(markSaved, { filePath: saved.path, savedAt: ctx.now() });
    return saved;
  },
});

export const documentCommands = [
  setScreen,
  goHome,
  setTemplateSavePrompt,
  setTemplateCreatePrompt,
  createProjectFromTemplate,
  setDocumentPrompt,
  promptNewDocument,
  newDocument,
  loadDocument,
  markSaved,
  promptOpenDocument,
  openDocument,
  saveDocumentAs,
  saveDocument,
];
