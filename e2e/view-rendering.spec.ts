import { signInFixture } from './fixtures/account';
import { expect, test } from '@playwright/test';

test('each view keeps its renderer, shows a Board preview, and offers scoped layer visibility', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await signInFixture(page);
  const ids = await page.evaluate(async () => {
    const app = window.__archai!;
    let revision = 0;
    const status = () => ({
      available: true,
      state: revision ? ('ready' as const) : ('idle' as const),
      embedded: revision > 0,
      bakeAvailable: true,
      projectId: app.store.getState().doc.id,
      revision,
      meshActors: 1,
      error: null,
    });
    app.platform.unreal = {
      status: async () => status(),
      update: async () => {
        revision++;
        return status();
      },
      viewport: async () => {},
      command: async () => {},
      image: async () =>
        Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4msAAAAASUVORK5CYII=',
          ),
          (c) => c.charCodeAt(0),
        ),
      exportScene: async () => null,
      stop: async () => {},
    };
    await app.executor.dispatch('new-document', { name: 'View rendering' });
    const column = await app.executor.dispatch('create-arch-element', {
      tool: 'column',
      x: 0,
      y: 0,
    });
    const a = await app.executor.dispatch('create-view3d', { x: 0, y: 4000 });
    const b = await app.executor.dispatch('create-view3d', { x: 8000, y: 4000 });
    if (!a.ok || !b.ok || !column.ok) throw new Error('Fixture failed');
    await app.executor.dispatch('set-view3d-settings', { id: a.value, style: 'shaded' });
    await app.executor.dispatch('open-view3d', { id: a.value });
    return { a: a.value as string, b: b.value as string, column: column.value as string };
  });
  const pages = context.pages().length;
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await page.getByTestId('view-settings').getByLabel('View renderer').selectOption('unreal');
  await expect(page.getByTestId('unreal-status')).toContainText('Unreal connected', {
    timeout: 60_000,
  });
  await page.getByRole('radio', { name: 'View', exact: true }).click();
  await expect(page.getByTestId('view-settings').getByLabel('View style')).toHaveValue('shaded');
  await page.getByTestId('tool-render-light').click();
  await page.getByRole('menuitem', { name: 'Spot light', exact: true }).click();
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('create-light', { kind: 'spot', x: 0, y: 0, target: [1000, 0] }); });
  await expect.poll(() => page.evaluate(() => Object.values(window.__archai!.store.getState().doc.elements).filter((e) => (e as { meta?: Record<string, unknown> }).meta?.['renderLight']).length)).toBe(1);
  await page.getByRole('button', { name: 'Export to VR', exact: true }).click();
  await expect(page.getByLabel('Interactive destination')).toHaveValue('link');
  await expect(page.getByLabel('Interactive lighting')).toHaveValue('realtime');
  await page.getByLabel('Close export settings').click();
  await page.getByRole('button', { name: 'Back to Board' }).click();
  const portal = page.getByTestId(`view3d-portal-${ids.a}`);
  await expect(portal.getByAltText('Saved view preview')).toBeVisible();
  await expect(portal.locator('canvas')).toHaveCount(0);
  await page.evaluate(async ({ a }) => {
    await window.__archai!.executor.dispatch('open-view3d', { id: a });
  }, ids);
  await expect.poll(() => page.evaluate(() => Object.values(window.__archai!.store.getState().doc.elements).filter((e) => (e as { meta?: Record<string, unknown> }).meta?.['renderLight']).length)).toBe(1);
  const row = page.getByTestId(`layer-${ids.column}`);
  await row.hover();
  await row.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(row).toHaveAttribute('data-hidden', 'true');
  await row.getByRole('button', { name: 'Show', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide everywhere', exact: true }).click();
  const saved = await page.evaluate(() => window.__archai!.store.getState().doc);
  expect(saved.elements[ids.column]!.visible).toBe(false);
  expect((saved.elements[ids.a]!.meta?.['view3d'] as { renderer: string }).renderer).toBe('unreal');
  expect(
    (saved.elements[ids.b]!.meta?.['view3d'] as { renderer?: string }).renderer,
  ).toBeUndefined();
  expect(context.pages()).toHaveLength(pages);
});

test('a column can be placed directly on the ground in full-screen 3D', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: '3D placement' });
    await app.executor.dispatch('open-view3d');
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('set-tool', { tool: 'arch:column' });
  });
  const canvas = page.getByTestId('view3d-workspace').locator('canvas').first();
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box!.width * 0.5, y: box!.height * 0.65 } });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values(window.__archai!.store.getState().doc.elements).filter(
            (e) =>
              ((e as { meta?: Record<string, unknown> }).meta?.['arch'] as { type?: string })?.type === 'column',
          ).length,
      ),
    )
    .toBe(1);
});

test('creation clicks cross vertical walls and bypass the selection gizmo in a populated view', async ({page})=>{
  test.setTimeout(60000);
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.__archai));
  await page.evaluate(async()=>{
    const api=window.__archai!;
    await api.executor.dispatch('new-document',{name:'Populated 3D placement'});
    const wall=await api.executor.dispatch('create-arch-element',{tool:'wall',points:[[-5000,0],[5000,0]]});
    if(!wall.ok)throw Error(wall.error.message);
    await api.executor.dispatch('select',{ids:[wall.value]});
    await api.executor.dispatch('open-view3d');
  });
  await expect(page.getByTestId('view3d-loading')).toHaveCount(0);
  await page.evaluate(async()=>{await window.__archai!.executor.dispatch('set-tool',{tool:'arch:column'});});
  const canvas=page.getByTestId('view3d-workspace').locator('canvas').first(),box=await canvas.boundingBox();
  await canvas.click({position:{x:box!.width*.5,y:box!.height*.5}});
  await expect.poll(()=>page.evaluate(()=>Object.values(window.__archai!.store.getState().doc.elements).filter(e=>((e as {meta?:Record<string,unknown>}).meta?.['arch'] as {type?:string})?.type==='column').length)).toBe(1);
});
