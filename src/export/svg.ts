/**
 * SVG export of a paper sheet: one self-contained file at the printed size (width/height in
 * millimetres, viewBox in board millimetres), vector layers as groups with inlined styles and
 * 3D views/maps as embedded images, in board paint order. Opens in Illustrator, Inkscape,
 * Affinity and browsers.
 */
import type { ArchaiDocument } from '@/document';
import { composeSheet } from './compose';
import type { PaperPage } from './pdf';
import { MM_PER_INCH, type ColorMode } from './quality';

const SVG_NS = 'http://www.w3.org/2000/svg';

export async function paperSvg(doc: ArchaiDocument, page: PaperPage, options: { dpi?: number; colorMode?: ColorMode; background?: string | null } = {}): Promise<string> {
  const { region, scale } = page;
  const pxPerMm = (options.dpi ?? 300) / MM_PER_INCH / scale;
  const layers = await composeSheet(doc, { region, pxPerMm, excludeIds: page.excludeIds, colorMode: options.colorMode });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('version', '1.1');
  svg.setAttribute('width', `${region.width / scale}mm`);
  svg.setAttribute('height', `${region.height / scale}mm`);
  svg.setAttribute('viewBox', `${region.x} ${region.y} ${region.width} ${region.height}`);
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = page.title;
  svg.append(title);
  const background = options.background === undefined ? '#ffffff' : options.background;
  if (background) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(region.x));
    rect.setAttribute('y', String(region.y));
    rect.setAttribute('width', String(region.width));
    rect.setAttribute('height', String(region.height));
    rect.setAttribute('fill', background);
    svg.append(rect);
  }
  for (const [index, layer] of layers.entries()) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', `layer-${index + 1}`);
    if (layer.kind === 'vector') group.append(...layer.svg.childNodes);
    else {
      const image = document.createElementNS(SVG_NS, 'image');
      image.setAttribute('width', String(layer.width));
      image.setAttribute('height', String(layer.height));
      image.setAttribute('preserveAspectRatio', 'none');
      image.setAttribute('transform', `translate(${layer.x} ${layer.y}) rotate(${layer.rotation})`);
      image.setAttribute('href', layer.canvas.toDataURL(layer.opaque ? 'image/jpeg' : 'image/png', 0.95));
      group.append(image);
    }
    svg.append(group);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
}
