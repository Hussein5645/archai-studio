import { expect, test } from '@playwright/test';

/**
 * Styling inside view frames end to end: a plan frame entered by double-click, a wall picked by
 * clicking it in the frame and restyled; a camera frame turned into a structure diagram; a
 * duotone-ish image adjustment; then PNG and PDF exports (attached for visual review).
 */
test('picks and styles elements inside sheet views, then exports', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const a = window.__archai!;
    const d = async (id: string, input?: unknown) => {
      const result = await a.executor.dispatch(id, input);
      if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
      return result.value;
    };
    await d('new-document', { name: 'Styling e2e' });
    const level = (await d('create-level', { x: -1000, y: -1000, width: 14000, height: 10000, name: 'Ground' })) as string;
    const walls = [
      ...((await d('create-wall-segments', { points: [[0, 0], [12000, 0], [12000, 8000], [0, 8000], [0, 0]], type: 'wall', parentId: null })) as string[]),
      ...((await d('create-wall-segments', { points: [[6000, 0], [6000, 8000]], type: 'wall', parentId: null })) as string[]),
    ];
    for (const id of walls) await d('set-element-level-link', { id, levelId: level, offset: 0 });
    const camera = (await d('create-camera-view', { a: [-6000, 14000], b: [6000, 4000], eyeHeight: 9000, targetHeight: 0 })) as string;
    const paper = (await d('create-paper', { x: 40000, y: -30000, size: 'A3', orientation: 'landscape', scale: 100, title: 'Diagrams' })) as string;
    await d('open-sheet', { id: paper });
    const plan = (await d('add-sheet-view', { paperId: paper, sourceId: level, scale: 50, x: 15, y: 20 })) as string;
    const cam = (await d('add-sheet-view', { paperId: paper, sourceId: camera, scale: 100, x: 305, y: 20 })) as string;
    return { walls, plan, cam, paper };
  });

  // Double-click the plan frame to enter it.
  const at = async (id: string, fx: number, fy: number) =>
    page.evaluate(
      ({ id, fx, fy }) => {
        const s = window.__archai!.store.getState();
        const el = s.doc.elements[id] as { x: number; y: number; width: number; height: number; parentId: string };
        const paper = s.doc.elements[el.parentId] as { x: number; y: number };
        const v = s.ui.viewport;
        const box = document.querySelector('[data-testid="workboard"]')!.getBoundingClientRect();
        return { x: box.left + (paper.x + el.x + el.width * fx) * v.zoom + v.x, y: box.top + (paper.y + el.y + el.height * fy) * v.zoom + v.y };
      },
      { id, fx, fy },
    );
  const inside = await at(ids.plan, 0.75, 0.75);
  await page.mouse.dblclick(inside.x, inside.y);
  await expect(page.getByTestId('view-styling-section')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.sheet?.viewEdit?.frameId)).toBe(ids.plan);

  // Click the middle wall (x = 6000 of the 14 m crop starting at -1000): u = 7/14.
  const wall = await at(ids.plan, 7000 / 14000, 0.5);
  await page.mouse.click(wall.x, wall.y);
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.sheet?.viewEdit?.picked)).toEqual([ids.walls[4]]);
  await expect(page.getByTestId('view-picked-section')).toBeVisible();
  await page.getByRole('button', { name: 'Similar' }).click();
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.sheet?.viewEdit?.picked.length)).toBe(5);
  // Style: dark walls, the middle one glowing and labelled.
  await page.evaluate(async (walls) => {
    const a = window.__archai!;
    await a.executor.dispatch('set-view-override', { patch: { fill: '#1f2937', stroke: '#111827' } });
    await a.executor.dispatch('set-view-override', { elementIds: [walls[4]], patch: { emphasis: 'glow', accent: '#f59e0b', label: 'Party wall' } });
  }, ids.walls);
  await expect(page.locator(`[data-vf="${ids.plan}"] [data-vo]`)).toHaveCount(5);
  await page.keyboard.press('Escape'); // clears the picks
  await page.keyboard.press('Escape'); // leaves the view
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.sheet?.viewEdit ?? null)).toBeNull();

  // The camera view becomes a structure diagram with a warm tint.
  await page.evaluate(async (cam) => {
    const a = window.__archai!;
    await a.executor.dispatch('apply-diagram-recipe', { id: cam, recipe: 'structure' });
    await a.executor.dispatch('set-view-adjustments', { id: cam, patch: { tint: '#fde68a', tintAmount: 0.3, background: '#ffffff' } });
  }, ids.cam);
  await page.waitForTimeout(800);
  await page.screenshot({ path: testInfo.outputPath('styling-mode.png') });

  const exported = await page.evaluate(async (paperId) => {
    const s = window.__archai!.store.getState();
    const p = s.doc.elements[paperId] as { id: string; x: number; y: number; width: number; height: number };
    const region = { x: p.x, y: p.y, width: p.width, height: p.height };
    // Modules served by the dev server (URLs in the page, not paths for the test's TypeScript).
    const rasterUrl = '/src/export/raster.ts';
    const pdfUrl = '/src/export/pdf.ts';
    const { rasterizeBoard, canvasBytes } = (await import(rasterUrl)) as {
      rasterizeBoard(doc: unknown, region: unknown, options: unknown): Promise<HTMLCanvasElement>;
      canvasBytes(canvas: HTMLCanvasElement, mime: string): Promise<{ dataUrl: string }>;
    };
    const { papersPdf } = (await import(pdfUrl)) as { papersPdf(doc: unknown, pages: unknown[], options: unknown): Promise<Uint8Array> };
    const canvas = await rasterizeBoard(s.doc, region, { pixelsPerMm: 150 / 25.4 / 100, excludeIds: [p.id] });
    const { dataUrl } = await canvasBytes(canvas, 'image/png');
    const pdf = await papersPdf(s.doc, [{ region, scale: 100, title: 'Diagrams', excludeIds: [p.id] }], { dpi: 150 });
    const text = new TextDecoder('latin1').decode(pdf);
    return { dataUrl, pdfBytes: pdf.length, images: (text.match(/\/Subtype \/Image/g) ?? []).length };
  }, ids.paper);
  // The glowing plan is baked for PDF, the camera view is an image: at least two images.
  expect(exported.images).toBeGreaterThanOrEqual(2);
  const fs = await import('node:fs/promises');
  await fs.writeFile(testInfo.outputPath('styled-sheet.png'), Buffer.from(exported.dataUrl.split(',')[1]!, 'base64'));

  // Flatten the camera frame into an image.
  const flattened = await page.evaluate(async (cam) => {
    const a = window.__archai!;
    const result = await a.executor.dispatch('flatten-sheet-view', { id: cam, dpi: 150 });
    const s = a.store.getState();
    return { ok: result.ok, gone: !s.doc.elements[cam], kind: result.ok ? s.doc.elements[result.value as string]?.kind : null };
  }, ids.cam);
  expect(flattened).toEqual({ ok: true, gone: true, kind: 'image' });
});
