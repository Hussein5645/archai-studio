import { expect, test, type CDPSession, type Page } from '@playwright/test';

/**
 * Tablet use: real touch input (CDP touch events, multi-touch capable) with touch mode on. The
 * gestures mirror what was verified on a physical Android tablet.
 */
test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

type Point = [number, number];

class Finger {
  constructor(private readonly cdp: CDPSession) {}

  private send(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  }

  async tap([x, y]: Point) {
    await this.send('touchStart', [[x, y]]);
    await this.send('touchEnd', []);
  }

  /** One finger from `from` to `to` in small steps. */
  async drag(from: Point, to: Point, steps = 10) {
    await this.send('touchStart', [from]);
    for (let s = 1; s <= steps; s++) await this.send('touchMove', [[from[0] + ((to[0] - from[0]) * s) / steps, from[1] + ((to[1] - from[1]) * s) / steps]]);
    await this.send('touchEnd', []);
  }
}

async function setup(page: Page, path = '/'): Promise<Finger> {
  await page.addInitScript(() => localStorage.setItem('archai.touchMode', 'on'));
  await page.goto(path);
  return new Finger(await page.context().newCDPSession(page));
}

/** Board origin on screen with the viewport at (x, y, zoom): world = (screen - board - offset) / zoom. */
async function boardSetup(page: Page) {
  const finger = await setup(page);
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    // The side panels float over the board where the gestures happen.
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    if (store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    await executor.dispatch('set-viewport', { x: 0, y: 0, zoom: 0.1 });
    await executor.dispatch('set-workspace', { snap: { enabled: false } });
  });
  const box = (await page.getByTestId('workboard').boundingBox())!;
  const at = (worldX: number, worldY: number): Point => [box.x + worldX * 0.1, box.y + worldY * 0.1];
  return { finger, at };
}

const viewport = (page: Page) => page.evaluate(() => window.__archai!.store.getState().ui.viewport);
const selection = (page: Page) => page.evaluate(() => window.__archai!.store.getState().ui.selection);

test('board: one finger pans empty space, taps select and deselect, drags move', async ({ page }) => {
  const { finger, at } = await boardSetup(page);
  const id = await page.evaluate(async () => (await window.__archai!.executor.dispatch('create-rect', { x: 4000, y: 4000, width: 2000, height: 2000 })).value as string);
  await page.evaluate(() => window.__archai!.executor.dispatch('clear-selection'));

  await finger.drag(at(3000, 3000), at(3500, 3500));
  expect(await viewport(page)).toMatchObject({ x: 50, y: 50 });
  await page.evaluate(() => window.__archai!.executor.dispatch('set-viewport', { x: 0, y: 0, zoom: 0.1 }));

  await finger.tap(at(5000, 5000));
  expect(await selection(page)).toEqual([id]);
  await expect(page.getByTestId('touch-delete')).toBeVisible();

  await finger.drag(at(5000, 5000), at(6000, 5000));
  expect(await page.evaluate((rect) => window.__archai!.store.getState().doc.elements[rect]!.x, id)).toBe(5000);

  await finger.tap(at(1000, 1000));
  expect(await selection(page)).toEqual([]);
});

test('board: Select area turns one finger drag into a box selection, once', async ({ page }) => {
  const { finger, at } = await boardSetup(page);
  const id = await page.evaluate(async () => (await window.__archai!.executor.dispatch('create-rect', { x: 4000, y: 4000, width: 2000, height: 2000 })).value as string);
  await page.evaluate(() => window.__archai!.executor.dispatch('clear-selection'));
  await page.getByTestId('touch-mod-selectArea').click();
  await expect(page.getByTestId('touch-mod-selectArea')).toHaveAttribute('data-state', 'once');
  await finger.drag(at(3000, 3000), at(7000, 7000));
  expect(await selection(page)).toEqual([id]);
  expect(await viewport(page)).toMatchObject({ x: 0, y: 0 });
  await expect(page.getByTestId('touch-mod-selectArea')).toHaveAttribute('data-state', 'off');
});

test('board: walls place where the finger lifts, with Undo point and Done', async ({ page }) => {
  const { finger, at } = await boardSetup(page);
  await page.evaluate(() => window.__archai!.executor.dispatch('set-tool', { tool: 'arch:wall' }));
  // Aim: the point lands at the lift position, not where the finger first touched.
  await finger.drag(at(1000, 1000), at(2000, 2000));
  await finger.tap(at(6000, 2000));
  await finger.tap(at(6000, 6000));
  await page.getByTestId('touch-undo-point').click();
  await page.getByTestId('touch-done').click();
  const walls = await page.evaluate(() => {
    type Wall = { x: number; y: number; points: [number, number][]; meta?: { arch?: { type?: string } } };
    return (Object.values(window.__archai!.store.getState().doc.elements) as unknown as Wall[])
      .filter((element) => element.meta?.arch?.type === 'wall')
      .map((wall) => wall.points.map(([x, y]) => [Math.round(x + wall.x), Math.round(y + wall.y)]));
  });
  expect(walls).toEqual([[[2000, 2000], [6000, 2000]]]);
});

test('modeling: a drawing tool starts a sketch, and rectangles draw tap to tap', async ({ page }) => {
  const finger = await setup(page, '/modeling?asset=e2e-touch&name=Touch');
  await page.waitForFunction(() => Boolean((window as unknown as { __modeling?: unknown }).__modeling));
  const shapes = () =>
    page.evaluate(() => {
      const modeling = (window as unknown as { __modeling: { store: { getState(): { sketches: { shapes: { kind: string }[] }[] } } } }).__modeling;
      const sketches = modeling.store.getState().sketches;
      return { sketches: sketches.length, shapes: sketches.flatMap((sketch) => sketch.shapes.map((shape) => shape.kind)) };
    });
  await page.evaluate(() => (window as unknown as { __modeling: { store: { getState(): { setTool(tool: string): void } } } }).__modeling.store.getState().setTool('rect'));
  const pane = (await page.locator('[class*="_pane_"]').first().boundingBox())!;
  const point = (fx: number, fy: number): Point => [pane.x + pane.width * fx, pane.y + pane.height * fy];
  await finger.tap(point(0.4, 0.45));
  await expect(page.getByTestId('touch-done')).toBeVisible();
  await finger.tap(point(0.55, 0.6));
  expect(await shapes()).toEqual({ sketches: 1, shapes: ['rect'] });
});
