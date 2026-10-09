import DxfParser from 'dxf-parser';
import { expect, test } from '@playwright/test';

type Entity = { type: string; layer: string; lineweight?: number; vertices?: { x: number; y: number }[]; shape?: boolean; text?: string; startPoint?: { x: number; y: number }; textHeight?: number };

/** Draws parsed DXF entities as an SVG (y flipped back) for a visual check of the CAD output. */
function preview(entities: Entity[]): string {
  const points = entities.flatMap((e) => e.vertices ?? (e.startPoint ? [e.startPoint] : []));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = (maxX - minX) * 0.03;
  const colors: Record<string, string> = { 'A-WALL': '#111', 'A-ANNO-TTLB': '#555', 'A-ANNO-VIEW': '#0ea5e9', 'A-ANNO-SHEET': '#bbb', 'A-ANNO-SYMB': '#7c3aed', 'A-ANNO-TEXT': '#16a34a' };
  const body = entities
    .map((e) => {
      const stroke = colors[e.layer] ?? '#e11d48';
      const width = Math.max(0.1, (e.lineweight ?? 25) / 100);
      if (e.type === 'LWPOLYLINE' && e.vertices) return `<polyline points="${e.vertices.map((v) => `${v.x},${-v.y}`).join(' ')}${e.shape ? ` ${e.vertices[0]!.x},${-e.vertices[0]!.y}` : ''}" fill="none" stroke="${stroke}" stroke-width="${Math.max(1, width * 4)}" vector-effect="non-scaling-stroke"/>`;
      if (e.type === 'TEXT' && e.startPoint) return `<text x="${e.startPoint.x}" y="${-e.startPoint.y}" font-size="${(e.textHeight ?? 2) / 0.72}" fill="${stroke}" font-family="sans-serif">${(e.text ?? '').replace(/[<&]/g, '')}</text>`;
      return '';
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" style="background:#fff;width:100vw;height:100vh">${body}</svg>`;
}

test('exports a sheet as DXF in sheet and model space', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const files = await page.evaluate(async () => {
    const a = window.__archai!;
    const d = async (id: string, input?: unknown) => {
      const result = await a.executor.dispatch(id, input);
      if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
      return result.value;
    };
    await d('new-document', { name: 'DXF e2e' });
    const level = (await d('create-level', { x: -1000, y: -1000, width: 14000, height: 10000, name: 'Ground' })) as string;
    const walls = [
      ...((await d('create-wall-segments', { points: [[0, 0], [12000, 0], [12000, 8000], [0, 8000], [0, 0]], type: 'wall', parentId: null })) as string[]),
      ...((await d('create-wall-segments', { points: [[6000, 0], [6000, 8000]], type: 'wall', parentId: null })) as string[]),
    ];
    for (const id of walls) await d('set-element-level-link', { id, levelId: level, offset: 0 });
    const camera = (await d('create-camera-view', { a: [-6000, 14000], b: [6000, 4000], eyeHeight: 9000, targetHeight: 0 })) as string;
    const paper = (await d('create-paper', { x: 40000, y: -30000, size: 'A3', orientation: 'landscape', scale: 100, title: 'Ground floor' })) as string;
    await d('open-sheet', { id: paper });
    await d('add-sheet-view', { paperId: paper, sourceId: level, scale: 50, x: 15, y: 20 });
    await d('add-sheet-view', { paperId: paper, sourceId: camera, scale: 100, x: 305, y: 20 });
    await d('add-title-block', { paperId: paper, project: 'Harbour House' });
    await d('add-scale-bar', { paperId: paper });
    await d('add-north-arrow', { paperId: paper });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const s = a.store.getState();
    const p = s.doc.elements[paper] as { x: number; y: number; width: number; height: number };
    const dxfUrl = '/src/export/dxf.ts';
    const { paperDxf } = (await import(dxfUrl)) as { paperDxf(doc: unknown, page: unknown, scope: string): Promise<string> };
    const page = { region: { x: p.x, y: p.y, width: p.width, height: p.height }, scale: 100, title: 'Ground floor', paperId: paper, excludeIds: [paper] };
    return { sheet: await paperDxf(s.doc, page, 'sheet'), model: await paperDxf(s.doc, page, 'model') };
  });

  const parse = (text: string) => new DxfParser().parseSync(text) as unknown as { header: Record<string, unknown>; entities: Entity[] };
  const sheet = parse(files.sheet);
  const model = parse(files.model);
  const fs = await import('node:fs/promises');
  await fs.writeFile(testInfo.outputPath('sheet.dxf'), files.sheet);
  await fs.writeFile(testInfo.outputPath('model.dxf'), files.model);
  for (const [name, parsed] of [['sheet', sheet], ['model', model]] as const) {
    await page.setContent(`<body style="margin:0">${preview(parsed.entities)}</body>`);
    await page.screenshot({ path: testInfo.outputPath(`${name}-dxf-preview.png`) });
  }
  expect(sheet.header['$INSUNITS']).toBe(4);

  // Sheet space: millimetres on an A3 landscape sheet (with the border), layered by type.
  const sheetPoints = sheet.entities.flatMap((e) => e.vertices ?? []);
  expect(Math.min(...sheetPoints.map((p) => p.x))).toBeGreaterThanOrEqual(-0.01);
  expect(Math.max(...sheetPoints.map((p) => p.x))).toBeCloseTo(420, 0);
  expect(Math.max(...sheetPoints.map((p) => p.y))).toBeCloseTo(297, 0);
  const sheetLayers = new Set(sheet.entities.map((e) => e.layer));
  for (const layer of ['A-WALL', 'A-ANNO-TTLB', 'A-ANNO-SYMB', 'A-ANNO-VIEW', 'A-ANNO-SHEET']) expect(sheetLayers).toContain(layer);
  expect(sheet.entities.some((e) => e.type === 'TEXT' && e.text === 'Harbour House')).toBe(true);
  expect(sheet.entities.some((e) => e.type === 'TEXT' && e.text === 'A-101')).toBe(true);

  // Model space: only the drawing, at true size where the walls really are (y flipped).
  const modelLayers = new Set(model.entities.map((e) => e.layer));
  expect([...modelLayers]).not.toContain('A-ANNO-TTLB');
  const wallPoints = model.entities.filter((e) => e.layer === 'A-WALL').flatMap((e) => e.vertices ?? []);
  expect(wallPoints.length).toBeGreaterThan(0);
  const [minX, maxX] = [Math.min(...wallPoints.map((p) => p.x)), Math.max(...wallPoints.map((p) => p.x))];
  const [minY, maxY] = [Math.min(...wallPoints.map((p) => p.y)), Math.max(...wallPoints.map((p) => p.y))];
  // 12 × 8 m between centrelines, plus half a wall thickness each side.
  expect(minX).toBeGreaterThan(-400);
  expect(minX).toBeLessThan(1);
  expect(maxX).toBeGreaterThan(11_999);
  expect(maxX).toBeLessThan(12_400);
  expect(maxY).toBeLessThan(400);
  expect(minY).toBeLessThan(-7_999);
  // Printed wall weight at 1:50 from the board's stroke, snapped to a DXF lineweight.
  expect(model.entities.find((e) => e.layer === 'A-WALL')?.lineweight).toBeGreaterThan(0);

});
