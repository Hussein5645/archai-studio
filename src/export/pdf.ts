/**
 * Vector PDF export of paper sheets: the board's SVG layers are converted to PDF drawing
 * operators (jsPDF + svg2pdf), so lines, hatches and text stay crisp at any zoom; 3D/section
 * views and the site map are the only raster content, rendered for the chosen DPI at their
 * printed size. Several sheets go into one file as pages of their own sizes.
 */
import type { ArchaiDocument } from '@/document';
import type { Rect } from '@/geometry';
import { composeSheet, uprightRaster } from './compose';
import { MM_PER_INCH, type ColorMode } from './quality';

export const MM_TO_PT = 72 / 25.4;

export interface PaperPage {
  /** Board region covered by the sheet, in board millimetres. */
  region: Rect;
  /** Board millimetres per sheet millimetre (1:50 → 50). */
  scale: number;
  title: string;
  /** Elements to leave out (the sheet itself). */
  excludeIds?: string[];
}

export interface PaperPdfOptions {
  /** Resolution of the raster parts (3D views, maps, images). */
  dpi?: number;
  colorMode?: ColorMode;
  /** Document title (defaults to the first page's). */
  title?: string;
}

export interface PaperPdfInput extends PaperPage {
  doc: ArchaiDocument;
}

/** Builds a PDF with one page per sheet; each page is its region divided by its drawing scale. */
export async function papersPdf(doc: ArchaiDocument, pages: PaperPage[], options: PaperPdfOptions = {}): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('No sheets to export');
  // Loaded on demand: svg2pdf patches jsPDF's prototype and expects a browser global scope,
  // so neither belongs in the module graph of the command registry (tests run under Node).
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const dpi = options.dpi ?? 300;
  const size = (page: PaperPage) => ({ width: page.region.width / page.scale, height: page.region.height / page.scale });
  const first = size(pages[0]!);
  const pdf = new jsPDF({ unit: 'mm', format: [first.width, first.height], orientation: first.width >= first.height ? 'landscape' : 'portrait', compress: true });
  pdf.setProperties({ title: options.title ?? pages[0]!.title, creator: 'ArchAI' });

  for (const [index, page] of pages.entries()) {
    const sheet = size(page);
    if (index > 0) pdf.addPage([sheet.width, sheet.height], sheet.width >= sheet.height ? 'landscape' : 'portrait');
    // Raster pixels per board millimetre for this page's scale.
    const pxPerMm = dpi / MM_PER_INCH / page.scale;
    const layers = await composeSheet(doc, { region: page.region, pxPerMm, excludeIds: page.excludeIds, colorMode: options.colorMode, rasterizeNonLatinText: true });
    for (const layer of layers) {
      if (layer.kind === 'vector') {
        layer.svg.setAttribute('width', String(sheet.width));
        layer.svg.setAttribute('height', String(sheet.height));
        await pdf.svg(layer.svg, { x: 0, y: 0, width: sheet.width, height: sheet.height });
        continue;
      }
      const upright = uprightRaster(layer);
      const x = (upright.x - page.region.x) / page.scale;
      const y = (upright.y - page.region.y) / page.scale;
      const w = upright.width / page.scale;
      const h = upright.height / page.scale;
      // Opaque renders compress far better as high-quality JPEG; rotated ones need PNG alpha.
      if (upright.opaque) pdf.addImage(upright.canvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, y, w, h, undefined, 'NONE');
      else pdf.addImage(upright.canvas, 'PNG', x, y, w, h, undefined, 'MEDIUM');
    }
  }
  return new Uint8Array(pdf.output('arraybuffer'));
}

/** One sheet as a PDF. */
export function paperPdf(input: PaperPdfInput, options: PaperPdfOptions = {}): Promise<Uint8Array> {
  return papersPdf(input.doc, [input], options);
}

export function downloadBytes(bytes: Uint8Array, fileName: string, mime = 'application/pdf'): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
