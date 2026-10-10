/**
 * Export of paper sheets: one command for every format (PDF, PNG, JPG, SVG, DXF), one sheet or all
 * sheets, at a chosen DPI and ink colour mode. The paper on the board stays the export frame:
 * what lies under it (and inside it) is what prints, at the paper's scale.
 */
import { z } from 'zod';
import { IdSchema, type ArchaiDocument } from '@/document';
import { boardDoc } from '@/store';
import { CommandError, defineEffect, defineMutation, type EffectContext } from '../contract';
import { paperOf } from './views';
import { startProgress, type ProgressHandle } from '@/progress';

export const EXPORT_FORMATS = ['pdf', 'png', 'jpg', 'svg', 'dxf'] as const;
export const COLOR_MODES = ['color', 'grayscale', 'black'] as const;

const MIME: Record<(typeof EXPORT_FORMATS)[number], string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  dxf: 'image/vnd.dxf',
};

export const ExportSettingsSchema = z.object({
  format: z.enum(EXPORT_FORMATS).default('pdf'),
  /** Print resolution: raster parts of PDF/SVG, every pixel of PNG/JPG. */
  dpi: z.number().int().min(36).max(1200).default(300),
  /** JPEG quality, 0.5–1. */
  quality: z.number().min(0.5).max(1).default(0.92),
  /** PNG/SVG only: leave the paper transparent instead of white. */
  transparent: z.boolean().default(false),
  colorMode: z.enum(COLOR_MODES).default('color'),
  /** DXF only: `sheet` = everything at 1:1 paper mm (plot-ready); `model` = the drawing at true size in real coordinates. */
  dxfScope: z.enum(['sheet', 'model']).default('sheet'),
  /** Every paper in the document (one multi-page PDF, or a ZIP of files). */
  allPapers: z.boolean().default(false),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

interface SheetTarget {
  id: string;
  title: string;
  scale: number;
  region: { x: number; y: number; width: number; height: number };
}

function safeName(name: string, fallback: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || fallback;
}

/** Papers of the document in board order (top-to-bottom, left-to-right), as export targets. */
export function papersOf(doc: ArchaiDocument): SheetTarget[] {
  return Object.values(doc.elements)
    .flatMap((element) => {
      const paper = paperOf(element.meta);
      if (!paper || element.kind !== 'rect' || element.parentId !== null) return [];
      return [
        {
          id: element.id,
          title: paper.title,
          scale: paper.scale,
          region: { x: element.x, y: element.y, width: element.width, height: element.height },
        },
      ];
    })
    .sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x);
}

function sheetTarget(doc: ArchaiDocument, id: string): SheetTarget | null {
  return papersOf(doc).find((sheet) => sheet.id === id) ?? null;
}

async function encodeSheet(
  doc: ArchaiDocument,
  sheet: SheetTarget,
  settings: ExportSettings,
): Promise<Uint8Array> {
  const page = {
    region: sheet.region,
    scale: sheet.scale,
    title: sheet.title,
    excludeIds: [sheet.id],
  };
  if (settings.format === 'dxf') {
    const { paperDxf } = await import('@/export/dxf');
    const text = await paperDxf(doc, { ...page, paperId: sheet.id }, settings.dxfScope, settings.colorMode);
    return new TextEncoder().encode(text);
  }
  if (settings.format === 'pdf') {
    const { papersPdf } = await import('@/export/pdf');
    return papersPdf(doc, [page], { dpi: settings.dpi, colorMode: settings.colorMode });
  }
  if (settings.format === 'svg') {
    const { paperSvg } = await import('@/export/svg');
    return new TextEncoder().encode(
      await paperSvg(doc, page, {
        dpi: settings.dpi,
        colorMode: settings.colorMode,
        background: settings.transparent ? null : '#ffffff',
      }),
    );
  }
  const { rasterizeBoard, canvasBytes } = await import('@/export/raster');
  const pixelsPerMm = settings.dpi / 25.4 / sheet.scale;
  const canvas = await rasterizeBoard(doc, sheet.region, {
    pixelsPerMm,
    background: settings.transparent && settings.format === 'png' ? null : '#ffffff',
    excludeIds: [sheet.id],
    colorMode: settings.colorMode,
  });
  // The density actually used (large sheets at high DPI are clamped to canvas limits).
  const dpi = Math.round((canvas.pixelsPerMm ?? pixelsPerMm) * 25.4 * sheet.scale);
  const { bytes } = await canvasBytes(
    canvas,
    settings.format === 'png' ? 'image/png' : 'image/jpeg',
    settings.quality,
    dpi,
  );
  return bytes;
}

export const exportPaper = defineEffect({
  id: 'export-paper',
  label: 'Export paper…',
  description:
    'Exports the selected paper sheet (or every paper) as PDF, PNG, JPG or SVG at a chosen DPI and colour mode. Everything under the sheet prints at its scale.',
  aliases: ['export', 'print', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'image export'],
  group: 'document',
  palette: false,
  input: ExportSettingsSchema.extend({ id: IdSchema.optional() }).prefault({}),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const doc = boardDoc(state);
    const id =
      input.id ??
      state.ui.selection.find((candidate) => paperOf(doc.elements[candidate]?.meta)) ??
      state.ui.sheet?.paperId;
    const sheets = input.allPapers
      ? papersOf(doc)
      : id
        ? [sheetTarget(doc, id)].filter((sheet): sheet is SheetTarget => sheet !== null)
        : [];
    if (sheets.length === 0)
      throw new CommandError(
        'rejected',
        input.allPapers ? 'There are no papers to export' : 'Select a paper to export',
      );
    const base = safeName(
      sheets.length === 1 ? sheets[0]!.title : doc.meta.name || 'sheets',
      'paper',
    );

    // Sheet mode paints only the open paper: other papers need the board back while they export.
    const openSheet = state.ui.sheet?.paperId ?? null;
    if (openSheet && sheets.some((sheet) => sheet.id !== openSheet)) {
      ctx.dispatchSync('close-sheet', {});
      await nextPaint();
      try {
        return await exportSheets(ctx, doc, sheets, input, base);
      } finally {
        ctx.dispatchSync('open-sheet', { id: openSheet });
      }
    }
    return exportSheets(ctx, doc, sheets, input, base);
  },
});

/** Resolves after the board has re-rendered (two animation frames). */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve();
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function exportSheets(
  ctx: EffectContext,
  doc: ArchaiDocument,
  sheets: SheetTarget[],
  input: ExportSettings,
  base: string,
): Promise<string | string[]> {
  const format = input.format.toUpperCase();
  const task = startProgress(sheets.length === 1 ? `Exporting ${format}` : `Exporting ${sheets.length} sheets as ${format}`, '', 0);
  try {
    return await exportWithProgress(ctx, doc, sheets, input, base, task);
  } catch (error) {
    task.failed();
    throw error;
  }
}

async function exportWithProgress(
  ctx: EffectContext,
  doc: ArchaiDocument,
  sheets: SheetTarget[],
  input: ExportSettings,
  base: string,
  task: ProgressHandle,
): Promise<string | string[]> {
  // The progress card closes before the Save dialog opens.
  const save = async (bytes: Uint8Array, name: string, mime: string) => {
    task.done();
    await ctx.platform.files.saveBinary(bytes, name, mime);
  };
  if (sheets.length === 1) {
    task.update(`Rendering ${sheets[0]!.title} at ${input.dpi} dpi`, null);
    await task.paint();
    const bytes = await encodeSheet(doc, sheets[0]!, input);
    await save(bytes, `${base}.${input.format}`, MIME[input.format]);
    return sheets[0]!.id;
  }
  if (input.format === 'pdf') {
    task.update(`Rendering ${sheets.length} pages at ${input.dpi} dpi`, null);
    await task.paint();
    const { papersPdf } = await import('@/export/pdf');
    const bytes = await papersPdf(
      doc,
      sheets.map((sheet) => ({
        region: sheet.region,
        scale: sheet.scale,
        title: sheet.title,
        excludeIds: [sheet.id],
      })),
      { dpi: input.dpi, colorMode: input.colorMode, title: doc.meta.name },
    );
    await save(bytes, `${base}.pdf`, MIME.pdf);
    return sheets.map((sheet) => sheet.id);
  }
  // Several image files: one ZIP, names numbered in board order.
  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  for (const [index, sheet] of sheets.entries()) {
    task.step(index, sheets.length, `Sheet ${index + 1} of ${sheets.length}: ${sheet.title}`, 0, 0.95);
    await task.paint();
    const name = `${String(index + 1).padStart(2, '0')} ${safeName(sheet.title, 'paper')}.${input.format}`;
    files[name] = await encodeSheet(doc, sheet, input);
  }
  task.update('Packing the ZIP', 0.97);
  await task.paint();
  await save(zipSync(files, { level: 0 }), `${base}.zip`, 'application/zip');
  return sheets.map((sheet) => sheet.id);
}

export const exportPaperPdf = defineEffect({
  id: 'export-paper-pdf',
  label: 'Export paper as PDF',
  description:
    'Exports everything on the selected paper sheet (plan, views, images) as a vector PDF at the sheet size (300 dpi for 3D views and maps).',
  aliases: ['print', 'pdf'],
  group: 'document',
  input: z
    .object({ id: IdSchema.optional(), dpi: z.number().int().min(36).max(1200).default(300) })
    .prefault({}),
  run: (ctx, input) =>
    ctx.dispatch(exportPaper, { id: input.id, format: 'pdf', dpi: input.dpi }).then((result) => {
      if (!result.ok) throw new CommandError(result.error.code, result.error.message);
      return result.value;
    }),
});

export const openExportDialog = defineMutation({
  id: 'open-export-dialog',
  label: 'Export…',
  description:
    'Opens the export dialog for the selected paper (PDF, PNG, JPG, SVG; DPI, colour mode, all sheets).',
  aliases: ['export', 'print', 'save as pdf', 'save as image'],
  group: 'document',
  history: 'none',
  shortcuts: ['Mod+Shift+P'],
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  run: (ctx, input) => {
    const id =
      input.id ??
      ctx.ui.selection.find((candidate) => paperOf(ctx.doc.elements[candidate]?.meta)) ??
      ctx.ui.sheet?.paperId;
    const paperId =
      id && paperOf(ctx.doc.elements[id]?.meta)
        ? id
        : (papersOf(ctx.doc as ArchaiDocument)[0]?.id ?? null);
    if (!paperId)
      throw new CommandError(
        'rejected',
        'Add a paper first: exports are framed by a paper sheet (Shift+P)',
      );
    ctx.ui.exportDialog = { open: true, paperId };
  },
});

export const closeExportDialog = defineMutation({
  id: 'close-export-dialog',
  label: 'Close export dialog',
  group: 'document',
  palette: false,
  history: 'none',
  input: z.object({}).prefault({}),
  run: (ctx) => {
    ctx.ui.exportDialog = { open: false, paperId: null };
  },
});

export const exportCommands = [exportPaper, exportPaperPdf, openExportDialog, closeExportDialog];
