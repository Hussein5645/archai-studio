/**
 * Analysis data out of ArchAI: grid samples, summaries and climate tables as CSV/JSON files, and
 * analysis charts on sheets (sun path, wind rose, colour legend, summary table). See
 * src/analysis/dataExport.ts for what each contains.
 */
import { z } from 'zod';
import { IdSchema, type ArchaiDocument, type Element, type ElementTable, type JsonValue, type RectElement } from '@/document';
import { analysisOf, type AnalysisMeta } from '@/analysis/model';
import { climateCsv, collectSamples, datasetCsv, quantityOf, summarize, summaryCsv, type AnalysisDataset, type Sampler } from '@/analysis/dataExport';
import { mountedViews } from '@/view3d/SceneView';
import { boardDoc } from '@/store';
import { paperScaleOf, type ChartKind } from '@/sheets/model';
import { CommandError, defineEffect, defineMutation, type EffectContext, type MutationContext, type ReadContext } from '../contract';
import { setSelection, topIndex } from '../helpers';
import { paperOf } from './views';

function originOf(ctx: ReadContext | MutationContext, id: string | undefined): { element: Element; meta: AnalysisMeta } {
  const elements = ctx.doc.elements as ElementTable;
  const candidates = [id, ...ctx.ui.selection].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const meta = analysisOf(elements[candidate]);
    if (meta) return { element: elements[candidate]!, meta };
  }
  // Otherwise the running study, if any.
  for (const element of Object.values(elements)) {
    const meta = analysisOf(element);
    if (meta?.active) return { element, meta };
  }
  throw new CommandError('rejected', 'Select a sun, wind or noise analysis origin');
}

/** The live 3D view the study runs in: its renderer holds the analysed values. */
function samplerOf(meta: AnalysisMeta): Sampler {
  if (!meta.active) throw new CommandError('rejected', 'Run the analysis first: its values come from its 3D view');
  for (const id of meta.activeViews ?? meta.views) {
    const view = mountedViews.get(id);
    if (view) return { sample: (spacing, clipTop) => view.analysisSamples(spacing, clipTop) };
  }
  throw new CommandError('rejected', 'The analysis view is not on the board');
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'analysis';
}

export const exportAnalysisData = defineEffect({
  id: 'export-analysis-data',
  label: 'Export analysis data…',
  description:
    'Saves the numbers behind a sun, wind or noise study. `grid`: values on a grid (spacing in mm) on the ground, roofs and each level floor; `summary`: min/mean/max and the share at or above `threshold` per surface, room and zone; `climate`: location, hourly sun positions, wind rose and sunshine. CSV or JSON.',
  aliases: ['analysis csv', 'export analysis', 'sun hours data', 'noise data', 'wind data', 'climate data'],
  group: 'document',
  input: z
    .object({
      id: IdSchema.optional(),
      content: z.enum(['grid', 'summary', 'climate']).default('grid'),
      format: z.enum(['csv', 'json']).default('csv'),
      spacing: z.number().min(100).max(10_000).default(1000),
      threshold: z.number().finite().optional(),
    })
    .prefault({}),
  run: async (ctx, input) => {
    const doc = boardDoc(ctx.getState());
    const { element, meta } = originOf(ctx.read(), input.id);
    const base = safeName(`${element.name ?? meta.kind} ${input.content}`);
    const save = (text: string, extension: 'csv' | 'json') => ctx.platform.files.saveBinary(new TextEncoder().encode(text), `${base}.${extension}`, extension === 'csv' ? 'text/csv' : 'application/json');
    if (input.content === 'climate') {
      const csv = climateCsv(doc, meta);
      if (input.format === 'csv') await save(csv, 'csv');
      else await save(JSON.stringify({ origin: element.id, kind: meta.kind, csv }, null, 2), 'json');
      return element.id;
    }
    const dataset = collectSamples(doc, meta, samplerOf(meta), input.spacing);
    if (dataset.rows.length === 0) throw new CommandError('failed', 'The analysis returned no samples; is the model inside its view?');
    const threshold = input.threshold ?? quantityOf(meta).threshold;
    if (input.content === 'grid') {
      await save(input.format === 'csv' ? datasetCsv(dataset) : JSON.stringify(dataset), input.format);
      return dataset.rows.length;
    }
    const rows = summarize(doc, dataset, threshold);
    await save(input.format === 'csv' ? summaryCsv(rows, dataset, threshold) : JSON.stringify({ quantity: dataset.quantity, unit: dataset.unit, threshold, rows }, null, 2), input.format);
    return rows.length;
  },
});

/** Printed size (paper mm) of each chart on a sheet. */
const CHART_SIZE: Record<ChartKind, { width: number; height: number }> = {
  'sun-path': { width: 90, height: 96 },
  'wind-rose': { width: 80, height: 86 },
  legend: { width: 80, height: 16 },
  table: { width: 120, height: 20 },
};

function requirePaper(ctx: MutationContext, id: string | undefined): RectElement {
  const paperId = id ?? ctx.ui.sheet?.paperId ?? ctx.ui.selection.find((candidate) => paperOf(ctx.doc.elements[candidate]?.meta));
  const paper = paperId ? ctx.doc.elements[paperId] : undefined;
  if (!paper || paper.kind !== 'rect' || !paperOf(paper.meta)) throw new CommandError('rejected', 'Select or open a paper');
  return paper;
}

function placeChart(ctx: MutationContext, paper: RectElement, kind: ChartKind, chart: Record<string, JsonValue>, rows = 0): string {
  const s = paperScaleOf(paper);
  const size = CHART_SIZE[kind];
  const height = kind === 'table' ? 14 + rows * 6 : size.height;
  const id = ctx.ids.next('el');
  // Stacked from the top-left margin, below charts already there.
  const below = Object.values(ctx.doc.elements).filter((element) => element.parentId === paper.id && element.meta?.['chart'] && element.kind === 'rect') as RectElement[];
  const y = below.reduce((bottom, element) => Math.max(bottom, element.y + element.height + 6 * s), 12 * s);
  ctx.doc.elements[id] = {
    id,
    kind: 'rect',
    parentId: paper.id,
    index: topIndex(ctx.doc.elements as ElementTable, paper.id),
    x: 12 * s,
    y: Math.min(y, paper.height - height * s - 10 * s),
    rotation: 0,
    visible: true,
    locked: false,
    width: size.width * s,
    height: height * s,
    radius: 0,
    style: { fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
    name: String(chart['title'] ?? kind),
    meta: { chart: { kind, ...chart } },
  };
  setSelection(ctx, [id]);
  return id;
}

export const addAnalysisChart = defineMutation({
  id: 'add-analysis-chart',
  label: 'Add analysis chart to sheet',
  description: "Places a live analysis chart on a paper: `sun-path` (the site's sun paths: study date, solstices, equinox), `wind-rose` (fetched wind statistics, else the study wind) or `legend` (the study's colour scale).",
  aliases: ['sun path', 'sun path diagram', 'wind rose', 'legend', 'analysis chart'],
  group: 'create',
  history: 'record',
  input: z.object({ paperId: IdSchema.optional(), originId: IdSchema.optional(), chart: z.enum(['sun-path', 'wind-rose', 'legend']).default('legend') }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    const { element, meta } = originOf(ctx, input.originId);
    if (input.chart === 'sun-path' && meta.kind !== 'sun') throw new CommandError('rejected', 'A sun path needs a sun analysis origin');
    if (input.chart === 'wind-rose' && meta.kind !== 'wind') throw new CommandError('rejected', 'A wind rose needs a wind analysis origin');
    const { quantity, unit } = quantityOf(meta);
    const title = input.chart === 'sun-path' ? 'Sun path' : input.chart === 'wind-rose' ? 'Wind rose' : quantity;
    return placeChart(ctx, paper, input.chart, { originId: element.id, title, unit, threshold: 0, rows: [] });
  },
});

export const addAnalysisSummary = defineEffect({
  id: 'add-analysis-summary',
  label: 'Add analysis summary table to sheet',
  description: 'Samples the running study and places a table on a paper: min, mean, max and the share at or above `threshold` per surface, room and zone (a snapshot; add it again after changes).',
  aliases: ['analysis table', 'sun hours table', 'noise table'],
  group: 'create',
  input: z.object({ paperId: IdSchema.optional(), originId: IdSchema.optional(), spacing: z.number().min(100).max(10_000).default(1000), threshold: z.number().finite().optional() }).prefault({}),
  run: async (ctx: EffectContext, input) => {
    const doc = boardDoc(ctx.getState()) as ArchaiDocument;
    const { element, meta } = originOf(ctx.read(), input.originId);
    const dataset: AnalysisDataset = collectSamples(doc, meta, samplerOf(meta), input.spacing);
    const threshold = input.threshold ?? quantityOf(meta).threshold;
    const rows = summarize(doc, dataset, threshold).slice(0, 24);
    const result = ctx.dispatchSync(addSummaryTable, { paperId: input.paperId, originId: element.id, title: `${dataset.quantity} summary`, unit: dataset.unit, threshold, rows });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message);
    return result.value;
  },
});

/** Places a computed summary (the mutation half of add-analysis-summary, so it undoes as one step). */
export const addSummaryTable = defineMutation({
  id: 'add-analysis-summary-table',
  label: 'Place analysis summary table',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    paperId: IdSchema.optional(),
    originId: IdSchema,
    title: z.string().max(120),
    unit: z.string().max(20),
    threshold: z.number(),
    rows: z.array(z.object({ name: z.string(), kind: z.string(), min: z.number(), mean: z.number(), max: z.number(), share: z.number() })).max(40),
  }),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    return placeChart(ctx, paper, 'table', { originId: input.originId, title: input.title, unit: input.unit, threshold: input.threshold, rows: input.rows as unknown as JsonValue }, input.rows.length);
  },
});

export const analysisDataCommands = [exportAnalysisData, addAnalysisChart, addAnalysisSummary, addSummaryTable];
