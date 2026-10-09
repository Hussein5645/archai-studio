import { expect, test, type Page } from '@playwright/test';

/** Reads app state through the same public entry point a future agent would use. */
async function state(page: Page) {
  return page.evaluate(() => {
    const s = window.__archai!.store.getState();
    return {
      elements: (Object.values(s.doc.elements) as Array<{ id: string; kind: string; x: number; y: number }>).map((e) => ({
        id: e.id,
        kind: e.kind,
        x: e.x,
        y: e.y,
      })),
      selection: s.ui.selection,
      past: s.history.past.length,
      tool: s.ui.tool,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The app exposes its bridge once it has restored the previous session.
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('new-document');
    await window.__archai!.executor.dispatch('toggle-left-panel');
    await window.__archai!.executor.dispatch('toggle-inspector');
  });
});

test('Element graphics preview reflects Hidden line door colours', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('set-workspace', { viewStyle: 'hidden-line' });
    await executor.dispatch('open-graphics', { type: 'door' });
  });
  const dialog = page.getByTestId('graphics-dialog');
  await expect(dialog).toHaveCSS('resize', 'both');
  await expect(dialog.locator('header h2 svg')).toHaveCount(1);
  await expect(page.getByTestId('graphics-preview')).toBeVisible();
  await page.getByLabel('Leaf and frame', { exact: true }).fill('#ff0000');
  await page.getByLabel('Leaf and frame', { exact: true }).press('Enter');
  await page.getByLabel('Swing', { exact: true }).fill('#006eff');
  await page.getByLabel('Swing', { exact: true }).press('Enter');

  const preview = page.getByTestId('graphics-preview');
  await expect(preview.locator('[stroke="#ff0000"]')).toHaveCount(1);
  await expect(preview.locator('[stroke="#006eff"]')).toHaveCount(1);
});

test('multi-selection shows and edits shared instance parameters', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('toggle-inspector');
    await executor.dispatch('set-workspace', { unit: 'mm' });
    const first = (await executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 })).value as string;
    const second = (await executor.dispatch('create-arch-element', { tool: 'column', x: 2000, y: 0 })).value as string;
    const base = { shape: 'rectangle', depth: 500, height: 3000, elevation: 0, material: 'concrete' };
    await executor.dispatch('set-system-configuration', { id: first, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters: { ...base, width: 600 } });
    await executor.dispatch('set-system-configuration', { id: second, assetId: null, applyTo: 'instance', instanceEditable: ['width'], parameters: { ...base, width: 900 } });
    await executor.dispatch('select', { ids: [first, second] });
    return [first, second];
  });

  const shared = page.getByTestId('shared-instance-parameters');
  await expect(shared).toBeVisible();
  const width = shared.getByLabel('Width', { exact: true });
  await expect(width).toHaveAttribute('placeholder', 'Multiple values');
  await width.fill('800');
  await width.press('Enter');

  await expect.poll(() => page.evaluate((selected) => selected.map((id) => {
    const element = window.__archai!.store.getState().doc.elements[id];
    const arch = element?.meta?.['arch'] as { parameters?: { width?: number } } | undefined;
    return { width: 'width' in (element ?? {}) ? (element as { width: number }).width : null, parameter: arch?.parameters?.width };
  }), ids)).toEqual([{ width: 800, parameter: 800 }, { width: 800, parameter: 800 }]);
});

test('instance-editable custom profiles open the profile drawer', async ({ page }) => {
  const columnId = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('toggle-inspector');
    const id = (await executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 })).value as string;
    await executor.dispatch('set-system-configuration', {
      id,
      assetId: null,
      applyTo: 'instance',
      instanceEditable: ['shape', 'profile'],
      parameters: { shape: 'custom', profile: [[0, 0], [1, 0], [0.5, 1]], width: 500, depth: 500, height: 3000, elevation: 0, material: 'concrete' },
    });
    return id;
  });

  const profile = page.getByTestId('instance-profile-profile');
  await expect(profile).toBeVisible();
  await expect(profile.getByRole('application', { name: 'Custom profile drawing area' })).toHaveAttribute('aria-disabled', 'false');
  await profile.getByRole('button', { name: 'Clear' }).click();
  await expect(profile.getByText('0 of at least 3 points', { exact: false })).toBeVisible();
  await profile.getByRole('button', { name: 'Rectangle' }).click();
  await expect.poll(() => page.evaluate((id) => {
    const arch = window.__archai!.store.getState().doc.elements[id]?.meta?.['arch'] as { parameters?: { profile?: number[][] } } | undefined;
    return arch?.parameters?.profile;
  }, columnId)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
});

test('parametric graph discovers generic elements at every nested level', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const component = (await executor.dispatch('create-parametric-component', { x: 1000, y: 1000, name: 'Nested rig' })).value as string;
    const first = (await executor.dispatch('create-rect', { x: 0, y: 0, width: 500, height: 300, name: 'Inner panel', parentId: component, select: false })).value as string;
    const second = (await executor.dispatch('create-line', { points: [[0, 0], [500, 0]], name: 'Inner rail', parentId: component, select: false })).value as string;
    await executor.dispatch('select', { ids: [first, second] });
    const group = (await executor.dispatch('group-selection', { name: 'Nested frame' })).value as string;
    return { component, group, first, second };
  });

  const editor = page.getByTestId('parametric-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('article header strong', { hasText: 'Nested frame / Inner panel' })).toBeVisible();
  await expect(editor.locator('article header strong', { hasText: 'Nested frame / Inner rail' })).toBeVisible();
  await expect.poll(() => page.evaluate(({ component }) => {
    const element = window.__archai!.store.getState().doc.elements[component];
    const graph = element?.meta?.['parametricGraph'] as { nodes?: Array<{ elementId?: string }> } | undefined;
    return graph?.nodes?.flatMap((node) => node.elementId ? [node.elementId] : []).sort() ?? [];
  }, ids)).toEqual([ids.first, ids.group, ids.second].sort());
});

test('layer dragging changes board z-order and can lift a child to the board root', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('toggle-left-panel');
    const a = (await executor.dispatch('create-rect', { x: 100, y: 100, width: 500, height: 500 })).value as string;
    const b = (await executor.dispatch('create-rect', { x: 150, y: 150, width: 500, height: 500 })).value as string;
    const c = (await executor.dispatch('create-rect', { x: 200, y: 200, width: 500, height: 500 })).value as string;
    return { a, b, c };
  });

  await page.getByTestId(`layer-${ids.a}`).dragTo(page.getByTestId(`layer-${ids.c}`), { targetPosition: { x: 100, y: 2 } });
  const rootOrder = await page.evaluate(() => {
    const elements = window.__archai!.store.getState().doc.elements;
    const list = Object.values(elements) as Array<{ id: string; parentId: string | null; index: string }>;
    return list.filter((element) => element.parentId === null).sort((a, b) => a.index.localeCompare(b.index)).map((element) => element.id);
  });
  expect(rootOrder).toEqual([ids.b, ids.c, ids.a]);
  await expect(page.locator('[data-testid="world"] [data-element-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-element-id')))).resolves.toEqual(rootOrder);

  const group = await page.evaluate(async ({ a, b }) => {
    const { executor } = window.__archai!;
    await executor.dispatch('select', { ids: [a, b] });
    return (await executor.dispatch('group-selection', {})).value as string;
  }, { a: ids.a, b: ids.b });
  await page.getByTestId(`layer-${ids.a}`).dragTo(page.getByTestId('layers-root-drop'));
  const lifted = await page.evaluate(({ a, group }) => {
    const elements = window.__archai!.store.getState().doc.elements;
    return { parentId: elements[a]?.parentId, groupExists: Boolean(elements[group]) };
  }, { a: ids.a, group });
  expect(lifted).toEqual({ parentId: null, groupExists: true });
});

test('live 3D portals participate in the same layer z-order as drawing elements', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const { executor } = window.__archai!;
    const back = (await executor.dispatch('create-rect', { x: 0, y: 0, width: 300, height: 300 })).value as string;
    const view = (await executor.dispatch('create-view3d', { x: 500, y: 0, width: 800, height: 600 })).value as string;
    const front = (await executor.dispatch('create-rect', { x: 1000, y: 0, width: 300, height: 300 })).value as string;
    return { back, view, front };
  });
  const painted = () => page.getByTestId('world').evaluate((world) =>
    Array.from(world.children).flatMap((child) => {
      const portal = child.getAttribute('data-testid');
      return portal?.startsWith('view3d-portal-') ? [portal.slice('view3d-portal-'.length)] : Array.from(child.querySelectorAll('[data-element-id]')).map((node) => node.getAttribute('data-element-id'));
    }),
  );

  await expect(painted()).resolves.toEqual([ids.back, ids.view, ids.front]);
  await page.evaluate(async ({ view, front }) => {
    await window.__archai!.executor.dispatch('reparent-element', { id: view, parentId: null, targetId: front, placement: 'front' });
  }, { view: ids.view, front: ids.front });
  await expect(painted()).resolves.toEqual([ids.back, ids.front, ids.view]);
});

test('primary flow: draw, select, move, undo, palette, persistence', async ({ page }) => {
  const board = page.getByTestId('workboard');
  await expect(board).toBeVisible();

  // Draw a rectangle with the rectangle tool.
  await page.keyboard.press('r');
  await board.hover({ position: { x: 300, y: 200 } });
  await page.mouse.down();
  await page.mouse.move(500, 350, { steps: 8 });
  await page.mouse.up();
  let s = await state(page);
  expect(s.elements).toHaveLength(1);
  expect(s.elements[0]!.kind).toBe('rect');
  expect(s.selection).toEqual([s.elements[0]!.id]);
  expect(s.tool).toBe('select');
  const before = s.elements[0]!;

  // Drag it: one gesture = one history entry.
  await board.hover({ position: { x: 400, y: 275 } });
  await page.mouse.down();
  await page.mouse.move(520, 335, { steps: 10 });
  await page.mouse.up();
  s = await state(page);
  expect(s.elements[0]!.x).toBeGreaterThan(before.x);
  expect(s.elements[0]!.y).toBeGreaterThan(before.y);
  expect(s.past).toBe(2);

  // Undo restores the position, redo re-applies it.
  await page.keyboard.press('Control+z');
  s = await state(page);
  expect(s.elements[0]!.x).toBe(before.x);
  await page.keyboard.press('Control+Shift+z');
  s = await state(page);
  expect(s.elements[0]!.x).toBeGreaterThan(before.x);

  // Marquee on empty space deselects; clicking the element selects it again.
  await board.click({ position: { x: 100, y: 500 } });
  expect((await state(page)).selection).toEqual([]);
  await board.click({ position: { x: 520, y: 335 } });
  expect((await state(page)).selection).toEqual([s.elements[0]!.id]);

  // Command palette runs commands.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.getByTestId('palette-input').fill('duplicate');
  await page.keyboard.press('Enter');
  s = await state(page);
  expect(s.elements).toHaveLength(2);
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  // Reload: the working copy comes back.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(board).toBeVisible();
  s = await state(page);
  expect(s.elements).toHaveLength(2);
});

test('assets: document definitions and system assets stay out of the storage-backed library', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('create-rect', { x: 0, y: 0, width: 600, height: 600 });
    await executor.dispatch('create-line', { points: [[0, 0], [600, 600]] });
    await executor.dispatch('select-all');
    await executor.dispatch('create-asset-definition', { name: 'Chair' });
  });
  const s = await state(page);
  expect(s.elements.map((e) => e.kind)).toEqual(['instance']);

  // The Assets tab is storage-only: document definitions do not leak into the library surface.
  await page.evaluate(() => window.__archai!.executor.dispatch('show-assets'));
  await expect(page.locator('[data-testid^="definition-"]')).toHaveCount(0);

  await expect(page.getByTestId('system-assets-toggle')).toHaveCount(0);
  await expect(page.getByText('System assets', { exact: true })).toHaveCount(0);
});

test('measure tool creates a labelled two-point dimension', async ({ page }) => {
  const board = page.getByTestId('workboard');
  // Measure lives in the "Draw and annotate" section's overflow menu (each section shows two tools).
  await page.getByTestId('tools-more-1').click();
  await page.getByRole('menuitem', { name: /^Measure/ }).click();
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().ui.tool)).toBe('measure');
  await board.click({ position: { x: 300, y: 260 } });
  await board.hover({ position: { x: 480, y: 260 } });
  await expect(page.locator('svg[aria-hidden="true"] polyline')).toHaveCount(1);
  await board.click({ position: { x: 480, y: 260 } });

  const measure = await page.evaluate(() => {
    const element = (Object.values(window.__archai!.store.getState().doc.elements) as Array<{ kind: string; meta?: Record<string, unknown> }>)[0];
    return { kind: element?.kind, meta: element?.meta, tool: window.__archai!.store.getState().ui.tool };
  });
  expect(measure).toMatchObject({ kind: 'line', meta: { measure: { distance: 3000 } }, tool: 'select' });
  await expect(page.locator('[data-element-id] text')).toContainText('3.00 m');
});

test('regular assets preview under the pointer before placement', async ({ page }) => {
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('begin-catalog-placement', {
      asset: {
        id: 'preview-chair',
        path: 'Furnish/Seating/preview-chair',
        name: 'Preview Chair',
        kind: 'asset',
        image: { url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
        size: { width: 600, height: 600 },
      },
    });
  });
  const board = page.getByTestId('workboard');
  await board.hover({ position: { x: 420, y: 320 } });
  await expect(page.locator('svg[aria-hidden="true"] image')).toHaveCount(1);
  expect((await state(page)).tool).toBe('catalog');
  expect((await state(page)).elements).toHaveLength(0);
  await page.keyboard.press('Escape');
});

test('system tools expose type-driven configuration and assets expose uniform scale', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('create-arch-element', { tool: 'window', x: 0, y: 0 });
    await executor.dispatch('toggle-inspector');
  });
  await expect(page.getByTestId('system-configuration')).toBeVisible();
  await page.getByTestId('system-configuration').getByRole('button').click();
  const configuration = page.getByTestId('system-config-dialog');
  await expect(configuration).toBeVisible();
  await expect(configuration).toHaveCSS('position', 'fixed');
  await expect(configuration).toHaveCSS('resize', 'both');
  await expect(configuration).toHaveAttribute('aria-modal', 'false');
  await expect(configuration.locator('header h2 svg')).toHaveCount(1);
  await expect(page.getByText('Mechanism', { exact: true })).toBeVisible();
  await expect(page.getByLabel('System configuration')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
  await expect(page.getByTestId('inspector').getByLabel('Uniform scale')).toBeVisible();

  await page.getByLabel('Mechanism', { exact: true }).selectOption('casement');
  await expect(configuration.getByText('Unapplied changes')).toBeVisible();
  page.once('dialog', async (warning) => {
    expect(warning.message()).toContain('unapplied changes');
    await warning.dismiss();
  });
  await configuration.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(configuration).toBeVisible();

  await configuration.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(configuration).toBeVisible();
  await expect(configuration.getByText('Unapplied changes')).toHaveCount(0);
  await configuration.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(configuration).toHaveCount(0);
});

test('doors expose configuration but no scaling controls', async ({ page }) => {
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('create-arch-element', { tool: 'door', x: 0, y: 0 });
    await executor.dispatch('toggle-inspector');
  });
  await expect(page.getByTestId('system-configuration')).toBeVisible();
  await expect(page.getByLabel('Uniform scale')).toHaveCount(0);
  await expect(page.getByLabel('Width', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Height', { exact: true })).toBeDisabled();
});

test('selected doors expose overlay controls for both flip directions', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const result = await window.__archai!.executor.dispatch('create-arch-element', { tool: 'door', x: 600, y: 600 });
    if (!result.ok) throw new Error(result.error.message);
    return result.value as string;
  });
  await expect(page.getByTestId('flip-door-handing')).toBeVisible();
  await expect(page.getByTestId('flip-door-opening-side')).toBeVisible();

  await page.getByTestId('flip-door-handing').click();
  await page.getByTestId('flip-door-opening-side').click();
  const parameters = await page.evaluate((doorId) => {
    const element = window.__archai!.store.getState().doc.elements[doorId];
    return (element?.meta?.['arch'] as { parameters?: { handing?: string; openingSide?: string } } | undefined)?.parameters;
  }, id);
  expect(parameters).toMatchObject({ handing: 'right', openingSide: 'outside' });
});

test('doors snap to angled walls and cut a wall opening', async ({ page }) => {
  const setup = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const wall = await executor.dispatch('create-arch-element', { tool: 'wall', points: [[0, 0], [3000, 3000]] });
    if (!wall.ok) throw new Error(wall.error.message);
    await executor.dispatch('tool-arch-door');
    return { wallId: wall.value as string, viewport: store.getState().ui.viewport };
  });
  const board = page.getByTestId('workboard');
  await board.click({
    position: {
      x: 1500 * setup.viewport.zoom + setup.viewport.x,
      y: 1500 * setup.viewport.zoom + setup.viewport.y,
    },
  });

  const result = await page.evaluate((wallId) => {
    const s = window.__archai!.store.getState();
    const door = (Object.values(s.doc.elements) as Array<{ x: number; y: number; rotation: number; meta?: Record<string, unknown> }>).find(
      (element) => element.meta?.['arch'] && (element.meta['arch'] as { type?: string }).type === 'door',
    );
    return { door, wallId };
  }, setup.wallId);
  expect(result.door).toMatchObject({ rotation: 45, meta: { arch: { type: 'door', opening: { wallId: setup.wallId, segment: 0 } } } });

  const path = page.locator(`[data-element-id="${setup.wallId}"] path[fill="none"][d*=" Z"]`);
  await expect(path).toHaveAttribute('d', /M .* L .* M .* L/);

  // Dragging an attached door re-snaps it and moves the opening instead of leaving the old gap behind.
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const angle = (result.door!.rotation * Math.PI) / 180;
  const inside = {
    x: result.door!.x + Math.cos(angle) * 450 - Math.sin(angle) * 300,
    y: result.door!.y + Math.sin(angle) * 450 + Math.cos(angle) * 300,
  };
  const screenX = (world: number) => box!.x + world * setup.viewport.zoom + setup.viewport.x;
  const screenY = (world: number) => box!.y + world * setup.viewport.zoom + setup.viewport.y;
  await page.mouse.move(screenX(inside.x), screenY(inside.y));
  await page.mouse.down();
  await page.mouse.move(screenX(inside.x + 700), screenY(inside.y + 700), { steps: 8 });
  await page.mouse.up();
  const movedStart = await page.evaluate(() => {
    const element = (Object.values(window.__archai!.store.getState().doc.elements) as Array<{ meta?: Record<string, unknown> }>).find(
      (item) => (item.meta?.['arch'] as { type?: string } | undefined)?.type === 'door',
    );
    return ((element?.meta?.['arch'] as { opening?: { start: number } }).opening?.start ?? 0);
  });
  expect(movedStart).toBeGreaterThan((result.door!.meta!['arch'] as { opening: { start: number } }).opening.start);
  await expect(path).toHaveAttribute('d', /M .* L .* M .* L/);
});

test('a pinned canvas element remains selectable and can be unpinned', async ({ page }) => {
  const setup = await page.evaluate(async () => {
    const { executor, store } = window.__archai!;
    const created = await executor.dispatch('create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    if (!created.ok) throw new Error(created.error.message);
    await executor.dispatch('lock-selection', {});
    await executor.dispatch('clear-selection');
    return { id: created.value as string, viewport: store.getState().ui.viewport };
  });
  const board = page.getByTestId('workboard');
  await board.click({
    position: {
      x: 500 * setup.viewport.zoom + setup.viewport.x,
      y: 500 * setup.viewport.zoom + setup.viewport.y,
    },
  });
  expect((await state(page)).selection).toEqual([setup.id]);

  await page.evaluate(() => window.__archai!.executor.dispatch('toggle-inspector'));
  const pinned = page.getByRole('switch', { name: 'Pinned' });
  await expect(pinned).toHaveAttribute('aria-checked', 'true');
  await pinned.click();
  await expect(pinned).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate((id) => window.__archai!.store.getState().doc.elements[id]!.locked, setup.id)).toBe(false);
});
