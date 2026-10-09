import { expect, test } from '@playwright/test';

/**
 * Analysis data end to end on the GPU: a sun-hours study of a walled courtyard runs in a real
 * 3D view; its grid is exported as CSV through the download path and checked for sense (hours
 * within the day's daylight, less sun behind the south wall), and charts go on a sheet.
 */
test('exports sun-hours samples from the running 3D analysis and charts them on a sheet', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async () => {
    const a = window.__archai!;
    const d = async (id: string, input?: unknown) => {
      const result = await a.executor.dispatch(id, input);
      if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
      return result.value;
    };
    await d('new-document', { name: 'Sun data e2e' });
    const level = (await d('create-level', { x: -2000, y: -2000, width: 16000, height: 14000, name: 'Ground floor' })) as string;
    // A U-shaped courtyard open to the north: south, east and west walls.
    const walls = (await d('create-wall-segments', { points: [[0, 0], [0, 10000], [12000, 10000], [12000, 0]], type: 'wall', parentId: null })) as string[];
    for (const id of walls) await d('set-element-level-link', { id, levelId: level, offset: 0 });
    const view = (await d('create-view3d', { x: 20000, y: 0, width: 12000, height: 9000 })) as string;
    const origin = (await d('create-analysis-origin', { kind: 'sun', x: 6000, y: 5000 })) as string;
    await d('update-analysis', { id: origin, patch: { lat: 51.5, lon: -0.12, utcOffset: 1, date: '2026-06-21', display: 'sun-hours', northAngle: 0 } });
    await d('link-analysis-view', { id: origin, viewId: view, linked: true });
    await d('run-analysis', { id: origin });
    await d('zoom-to-fit');
    return { origin, view };
  });
  // Let the view mount, build the scene and render the analysis once.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-testid^="view3d-portal-"] canvas').length), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2500);

  const downloadPromise = page.waitForEvent('download');
  const result = await page.evaluate((origin) => window.__archai!.executor.dispatch('export-analysis-data', { id: origin, content: 'grid', spacing: 1000 }), ids.origin);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const download = await downloadPromise;
  const path = testInfo.outputPath('sun-grid.csv');
  await download.saveAs(path);
  const fs = await import('node:fs/promises');
  const csv = await fs.readFile(path, 'utf8');
  const [header, ...lines] = csv.trim().split('\n');
  expect(header).toBe('x_mm,y_mm,z_mm,surface,Direct sun hours (h)');
  const rows = lines.map((line) => {
    const [x, y, z, surface, value] = line.split(',');
    return { x: Number(x), y: Number(y), z: Number(z), surface: surface!, value: Number(value) };
  });
  expect(rows.length).toBeGreaterThan(200);
  const ground = rows.filter((row) => row.surface === 'Ground');
  const max = Math.max(...ground.map((row) => row.value));
  // London on 21 June has about 16 h of sun above 1°.
  expect(max).toBeGreaterThan(13);
  expect(max).toBeLessThanOrEqual(17);
  expect(Math.min(...ground.map((row) => row.value))).toBeGreaterThanOrEqual(0);
  // Just inside the courtyard's south wall (board y just below 10 m) gets less sun than open ground far away.
  const behindSouthWall = ground.filter((row) => row.x > 2000 && row.x < 10000 && row.y > 8500 && row.y < 9800);
  const openGround = ground.filter((row) => row.y < -6000 || row.x < -6000 || row.x > 18000);
  const mean = (list: typeof rows) => list.reduce((sum, row) => sum + row.value, 0) / Math.max(1, list.length);
  expect(behindSouthWall.length).toBeGreaterThan(0);
  expect(openGround.length).toBeGreaterThan(0);
  expect(mean(behindSouthWall)).toBeLessThan(mean(openGround) - 1);
  // The level floor was sampled too.
  expect(rows.some((row) => row.surface === 'Ground floor')).toBe(true);

  // Charts and the summary on a sheet.
  const png = await page.evaluate(async (ids) => {
    const a = window.__archai!;
    const d = async (id: string, input?: unknown) => {
      const r = await a.executor.dispatch(id, input);
      if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
      return r.value;
    };
    await d('create-diagram', { kind: 'zone', x: 1000, y: 1000, width: 10000, height: 8000, patch: { text: 'Courtyard' } });
    const paper = (await d('create-paper', { x: 0, y: 40000, size: 'A3', orientation: 'landscape', scale: 100, title: 'Sun study' })) as string;
    await d('add-analysis-chart', { paperId: paper, originId: ids.origin, chart: 'sun-path' });
    await d('add-analysis-chart', { paperId: paper, originId: ids.origin, chart: 'legend' });
    await d('add-analysis-summary', { paperId: paper, originId: ids.origin, spacing: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const s = a.store.getState();
    const p = s.doc.elements[paper] as { x: number; y: number; width: number; height: number };
    const rasterUrl = '/src/export/raster.ts';
    const { rasterizeBoard, canvasBytes } = (await import(rasterUrl)) as {
      rasterizeBoard(doc: unknown, region: unknown, options: unknown): Promise<HTMLCanvasElement>;
      canvasBytes(canvas: HTMLCanvasElement, mime: string): Promise<{ dataUrl: string }>;
    };
    const canvas = await rasterizeBoard(s.doc, { x: p.x, y: p.y, width: p.width, height: p.height }, { pixelsPerMm: 150 / 25.4 / 100, excludeIds: [paper] });
    const table = Object.values(s.doc.elements).find((e) => ((e as { meta?: Record<string, unknown> }).meta?.['chart'] as { kind?: string } | undefined)?.kind === 'table') as { meta: { chart: { rows: { name: string }[] } } };
    return { dataUrl: (await canvasBytes(canvas, 'image/png')).dataUrl, tableRows: table.meta.chart.rows.map((r) => r.name) };
  }, ids);
  // (Thin wall tops rarely land on a 1 m grid, so there may be no Roof row.)
  expect(png.tableRows).toEqual(expect.arrayContaining(['Ground', 'Ground floor', 'Courtyard']));
  await fs.writeFile(testInfo.outputPath('sun-sheet.png'), Buffer.from(png.dataUrl.split(',')[1]!, 'base64'));
});
