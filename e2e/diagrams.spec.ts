import { expect, type Page, test } from '@playwright/test';

/** Screen position of a board point (world millimetres). */
async function screen(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const v = window.__archai!.store.getState().ui.viewport;
      const box = document.querySelector('[data-testid="workboard"]')!.getBoundingClientRect();
      return { x: box.left + x * v.zoom + v.x, y: box.top + y * v.zoom + v.y };
    },
    { x, y },
  );
}

async function pick(page: Page, label: string) {
  await page.getByTestId('tool-diagram').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

async function diagrams(page: Page) {
  return page.evaluate(() =>
    (Object.values(window.__archai!.store.getState().doc.elements) as { id: string; meta?: Record<string, unknown> }[])
      .filter((e) => e.meta?.['diagram'])
      .map((e) => {
        const meta = e.meta!['diagram'] as Record<string, unknown> & { kind: string };
        return { id: e.id, kind: meta.kind, meta };
      }),
  );
}

test('draws presentation diagrams with the toolbar and exports them', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const a = window.__archai!;
    await a.executor.dispatch('new-document', { name: 'Diagrams e2e' });
    await a.executor.dispatch('create-wall-segments', { points: [[0, 0], [16000, 0]], type: 'wall', parentId: null });
    await a.executor.dispatch('toggle-inspector');
    // Frame the drawing: 1 m = 40 px, origin at (300, 250) on the board.
    const s = a.store.getState();
    a.store.setState({ ui: { ...s.ui, viewport: { x: 300, y: 250, zoom: 0.04 } } });
  });

  // Two zones, dragged out with the Zone tool.
  for (const [x0, y0, x1, y1] of [
    [1000, 3000, 7000, 9000],
    [9000, 3000, 15000, 9000],
  ] as const) {
    await pick(page, 'Zone');
    const a = await screen(page, x0, y0);
    const b = await screen(page, x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
  }
  let items = await diagrams(page);
  const zones = items.filter((item) => item.kind === 'zone').map((item) => item.id);
  expect(zones).toHaveLength(2);
  await page.evaluate((ids) => {
    const a = window.__archai!;
    a.executor.dispatchSync('set-diagram', { ids: [ids[0]], patch: { text: 'Living' } });
    a.executor.dispatchSync('set-diagram', { ids: [ids[1]], patch: { text: 'Kitchen', shape: 'ellipse' } });
  }, zones);

  // Adjacency: click one zone, then the other: glued to both.
  await pick(page, 'Adjacency');
  for (const [x, y] of [[4000, 6000], [12000, 6000]] as const) {
    const p = await screen(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  items = await diagrams(page);
  const adjacency = items.find((item) => item.kind === 'adjacency')!;
  expect([adjacency.meta['from'], adjacency.meta['to']]).toEqual(zones);

  // Chained dimension along the wall (snaps to it): three clicks, double-click to finish.
  await pick(page, 'Dimension');
  const dims = [[0, 40], [8000, 40], [16000, 40]] as const;
  for (const [index, [x, y]] of dims.entries()) {
    const p = await screen(page, x, y);
    if (index === dims.length - 1) await page.mouse.dblclick(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
  }

  // Callout and arrow.
  await pick(page, 'Callout');
  for (const [x, y] of [[8000, 0], [9500, -2000]] as const) {
    const p = await screen(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  await pick(page, 'Arrow');
  for (const [index, [x, y]] of ([[3000, 12000], [8000, 11000], [13000, 12000]] as const).entries()) {
    const p = await screen(page, x, y);
    if (index === 2) await page.mouse.dblclick(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
  }

  // Tag the living zone (off-centre click: the tag lands there).
  await pick(page, 'Tag');
  const tagAt = await screen(page, 2500, 4200);
  await page.mouse.click(tagAt.x, tagAt.y);

  items = await diagrams(page);
  const kinds = items.map((item) => item.kind).sort();
  expect(kinds).toEqual(['adjacency', 'arrow', 'callout', 'dimension', 'tag', 'zone', 'zone']);
  expect(items.find((item) => item.kind === 'tag')!.meta['target']).toBe(zones[0]);
  const dimensionPoints = await page.evaluate(() => {
    const all = Object.values(window.__archai!.store.getState().doc.elements) as { x: number; y: number; points?: [number, number][]; meta?: Record<string, unknown> }[];
    const e = all.find((el) => (el.meta?.['diagram'] as { kind?: string } | undefined)?.kind === 'dimension') as { x: number; y: number; points: [number, number][] };
    return e.points.map(([x, y]) => [Math.round(x + e.x), Math.round(y + e.y)]);
  });
  expect(dimensionPoints).toHaveLength(3);
  expect(dimensionPoints.map(([x]) => x)).toEqual([0, 8000, 16000]);

  // Soft theme, then the drawing as the sheet export sees it.
  await page.getByTestId('tool-diagram').click();
  await page.getByRole('menuitem', { name: /^Soft/ }).click();
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().doc.workspace.diagramTheme)).toBe('soft');
  await page.screenshot({ path: testInfo.outputPath('diagrams-board.png') });
  const png = await page.evaluate(async () => {
    const rasterUrl = '/src/export/raster.ts';
    const { rasterizeBoard, canvasBytes } = (await import(rasterUrl)) as {
      rasterizeBoard(doc: unknown, region: unknown, options: unknown): Promise<HTMLCanvasElement>;
      canvasBytes(canvas: HTMLCanvasElement, mime: string): Promise<{ dataUrl: string }>;
    };
    const doc = window.__archai!.store.getState().doc;
    const canvas = await rasterizeBoard(doc, { x: -1000, y: -4000, width: 18000, height: 18000 }, { pixelsPerMm: 0.1 });
    return (await canvasBytes(canvas, 'image/png')).dataUrl;
  });
  const fs = await import('node:fs/promises');
  await fs.writeFile(testInfo.outputPath('diagrams-export.png'), Buffer.from(png.split(',')[1]!, 'base64'));
});
