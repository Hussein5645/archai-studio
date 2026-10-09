import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document');
    if (store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    if (store.getState().ui.panels.left) await executor.dispatch('toggle-left-panel');
    await executor.dispatch('set-viewport', { x: 200, y: 80, zoom: 0.2 });
    await executor.dispatch('set-workspace', { grid: { size: 1000, visible: true }, snap: { enabled: true }, viewStyle: 'hidden-line' });
  });
});

test('drawing a branch from a wall keeps the grid coordinate and creates a clean T-junction', async ({ page }) => {
  const hostId = await page.evaluate(async () => {
    const result = await window.__archai!.executor.dispatch('create-wall-segments', { points: [[0, 0], [0, 2000]] });
    await window.__archai!.executor.dispatch('set-tool', { tool: 'arch:wall' });
    return (result.value as string[])[0]!;
  });
  const board = page.getByTestId('workboard');
  await board.click({ position: { x: 203, y: 277 } });
  await board.click({ position: { x: 600, y: 278 } });
  await page.keyboard.press('Enter');
  const branch = await page.evaluate((hostId) => {
    const elements = window.__archai!.store.getState().doc.elements;
    const lines = Object.values(elements) as Array<{ id: string; kind: string; points: [number, number][]; x: number; y: number; meta?: Record<string, unknown> }>;
    const element = lines.find((element) => element.id !== hostId && element.kind === 'line');
    if (!element || element.kind !== 'line') return null;
    return { points: element.points.map(([x, y]) => [x + element.x, y + element.y]), arch: element.meta?.['arch'] };
  }, hostId);
  expect(branch?.points).toEqual([[0, 1000], [2000, 1000]]);
  expect(branch?.arch).toMatchObject({ joints: { start: { enabled: true, with: [hostId] } } });
  await board.screenshot({ path: 'test-results/wall-t-junction.png' });
});

test('dragging a wall snaps its centreline origin, not its stroke bounds', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const result = await window.__archai!.executor.dispatch('create-wall-segments', { points: [[0, 0], [2000, 0]], parameters: { layers: [{ name: 'Core', role: 'core', thickness: 173 }] } });
    await window.__archai!.executor.dispatch('clear-selection');
    return (result.value as string[])[0]!;
  });
  const board = page.getByTestId('workboard');
  const box = (await board.boundingBox())!;
  await page.mouse.move(box.x + 400, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 467, box.y + 147, { steps: 10 });
  await page.mouse.up();
  const point = await page.evaluate((id) => {
    const element = window.__archai!.store.getState().doc.elements[id];
    return element?.kind === 'line' ? [element.x + element.points[0]![0], element.y + element.points[0]![1]] : [];
  }, id);
  expect(point).toEqual([300, 300]);
});
