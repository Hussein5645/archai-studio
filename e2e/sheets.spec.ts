import { expect, test } from '@playwright/test';

/**
 * Sheet editing end to end: a level plan and a section placed on an A3 sheet in sheet mode, with
 * a title block, scale bar and north arrow; the sheet then exports through the real pipeline.
 * The rendered sheet is attached to the report (sheet.png) for visual review.
 */
test('builds a presentation sheet in sheet mode and exports it', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const a = window.__archai!;
    const d = (id: string, input?: unknown) => a.executor.dispatch(id, input);
    await d('new-document', { name: 'Sheet e2e' });
    const level = await d('create-level', { x: -1000, y: -1000, width: 14000, height: 10000, name: 'Ground', planView: true });
    const outer = await d('create-wall-segments', { points: [[0, 0], [12000, 0], [12000, 8000], [0, 8000], [0, 0]], type: 'wall', parentId: null });
    const inner = await d('create-wall-segments', { points: [[6000, 0], [6000, 8000]], type: 'wall', parentId: null });
    for (const id of [...(outer.value as string[]), ...(inner.value as string[])]) await d('set-element-level-link', { id, levelId: level.value, offset: 0 });
    const section = await d('create-section-view', { a: [-500, 4000], b: [12500, 4000] });
    const paper = await d('create-paper', { x: 30000, y: -20000, size: 'A3', orientation: 'landscape', scale: 100, title: 'Ground floor' });
    await d('zoom-to-fit');
    return { level: level.value as string, section: section.value as string, paper: paper.value as string };
  });

  // Double-click the sheet itself, at a spot no floating panel covers, to open it.
  const point = await page.evaluate((paperId) => {
    const s = window.__archai!.store.getState();
    const p = s.doc.elements[paperId] as { x: number; y: number; width: number; height: number };
    const v = s.ui.viewport;
    const board = document.querySelector('[data-testid="workboard"]')!;
    const box = board.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7]) {
      for (const fx of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const x = box.left + (p.x + p.width * fx) * v.zoom + v.x;
        const y = box.top + (p.y + p.height * fy) * v.zoom + v.y;
        const hit = document.elementFromPoint(x, y);
        if (hit && board.contains(hit)) return { x, y };
      }
    }
    throw new Error('The sheet is covered everywhere');
  }, ids.paper);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.getByTestId('sheet-bar')).toBeVisible();
  await expect(page.getByTestId('sheet-toolbar')).toBeVisible();
  // Only the sheet is painted: the level's walls are not on screen outside a frame.
  await expect(page.locator('[data-testid="world"] > svg [data-element-id]')).toHaveCount(1);

  await page.getByTestId(`sheet-source-${ids.level}`).click();
  const planFrame = await page.evaluate(() => window.__archai!.store.getState().ui.selection[0]!);
  await page.evaluate((id) => window.__archai!.executor.dispatch('set-transform', { id, x: 1500, y: 2000 }), planFrame);
  await page.getByTestId(`sheet-source-${ids.section}`).click();
  const sectionFrame = await page.evaluate(() => window.__archai!.store.getState().ui.selection[0]!);
  await page.evaluate(async (id) => {
    await window.__archai!.executor.dispatch('set-sheet-view', { id, scale: 100 });
    await window.__archai!.executor.dispatch('set-transform', { id, x: 31000, y: 3500 });
  }, sectionFrame);
  const tools = page.getByTestId('sheet-toolbar');
  await tools.getByRole('button', { name: 'Title block' }).click();
  await page.evaluate((id) => window.__archai!.executor.dispatch('select', { ids: [id] }), planFrame);
  await tools.getByRole('button', { name: 'Scale bar' }).click();
  await tools.getByRole('button', { name: 'North arrow' }).click();
  await expect(page.getByTestId('north-arrow-section')).toBeVisible();

  // The plan frame redraws the level's five walls as vector; the section renders live.
  await expect(page.locator('[data-testid="world"] svg svg [data-element-id]')).toHaveCount(5);
  await expect(page.locator('image[data-sheet-view-source]')).toHaveCount(1);
  await page.waitForTimeout(600);
  await page.screenshot({ path: testInfo.outputPath('sheet-mode.png') });

  const exported = await page.evaluate(async (paperId) => {
    const s = window.__archai!.store.getState();
    const p = s.doc.elements[paperId] as { id: string; x: number; y: number; width: number; height: number };
    // Modules served by the dev server (URLs in the page, not paths for the test's TypeScript).
    const rasterUrl = '/src/export/raster.ts';
    const pdfUrl = '/src/export/pdf.ts';
    const { rasterizeBoard, canvasBytes } = (await import(rasterUrl)) as {
      rasterizeBoard(doc: unknown, region: unknown, options: unknown): Promise<HTMLCanvasElement>;
      canvasBytes(canvas: HTMLCanvasElement, mime: string): Promise<{ dataUrl: string }>;
    };
    const { papersPdf } = (await import(pdfUrl)) as { papersPdf(doc: unknown, pages: unknown[], options: unknown): Promise<Uint8Array> };
    const region = { x: p.x, y: p.y, width: p.width, height: p.height };
    const canvas = await rasterizeBoard(s.doc, region, { pixelsPerMm: 150 / 25.4 / 100, excludeIds: [p.id] });
    const { dataUrl } = await canvasBytes(canvas, 'image/png');
    const pdf = await papersPdf(s.doc, [{ region, scale: 100, title: 'Ground floor', excludeIds: [p.id] }], { dpi: 150 });
    const text = new TextDecoder('latin1').decode(pdf);
    return { dataUrl, width: canvas.width, height: canvas.height, pdfBytes: pdf.length, images: (text.match(/\/Subtype \/Image/g) ?? []).length };
  }, ids.paper);
  // A3 landscape at 150 dpi.
  expect([exported.width, exported.height]).toEqual([2480, 1754]);
  expect(exported.images).toBeGreaterThanOrEqual(1);
  await testInfo.attach('sheet.png', { body: Buffer.from(exported.dataUrl.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const fs = await import('node:fs/promises');
  await fs.writeFile(testInfo.outputPath('sheet.png'), Buffer.from(exported.dataUrl.split(',')[1]!, 'base64'));

  await page.keyboard.press('Escape'); // clears the selection
  await page.keyboard.press('Escape'); // leaves the sheet
  await expect(page.getByTestId('sheet-bar')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.sheet)).toBeNull();
});
