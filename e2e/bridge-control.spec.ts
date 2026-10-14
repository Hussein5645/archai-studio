import { expect, test } from '@playwright/test';
import type { BridgeBinding } from '../src/document/bridge';

function triangleGlb(): string {
  const binary = Buffer.alloc(36);
  [0, 0, 0, 500, 0, 0, 0, 0, 500].forEach((value, i) => binary.writeFloatLE(value, i * 4));
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [500, 0, 500] }] });
  const text = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const bytes = Buffer.alloc(28 + text.length + binary.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(text.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); text.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + text.length); bytes.writeUInt32LE(0x004e4942, 24 + text.length); binary.copy(bytes, 28 + text.length);
  return bytes.toString('base64');
}

test('ArchAI paint survives source changes and source-view hide/unhide retains the painted binding', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async glb => {
    const { executor } = window.__archai!;
    await executor.dispatch('new-document', { name: 'Visible source and paint' });
    await executor.dispatch('bridge-sync', { key: 'revit:test-view', app: 'Revit', name: 'View', complete: false,
      model: { archaiRevit: 1, viewScope: { visible: ['a'] }, meshes: [{ id: 'a', origin: [0,0,0], size: [500,500,10], glb }] } });
    const win = window.__archai!;
    const id = Object.keys(win.store.getState().doc.bridge!.elements)[0]!;
    const created = await executor.dispatch('create-material', { material: { name: 'ArchAI finish', color: '#ff6600' } });
    if (!created.ok) throw new Error(created.error.message);
    await executor.dispatch('paint-element', { ids: [id], materialId: created.value });
  }, triangleGlb());
  await expect(page.locator('[data-mesh-plan="true"]')).toHaveCount(1);
  const original = await page.evaluate(() => {
    const doc = window.__archai!.store.getState().doc;
    const id = Object.keys(doc.bridge!.elements)[0]!;
    return { id, materials: doc.elements[id]!.meta!['materials'] };
  });
  await page.evaluate(async () => {
    const result = await window.__archai!.executor.dispatch('bridge-sync', { key: 'revit:test-view', app: 'Revit', complete: false,
      model: { archaiRevit: 1, viewScope: { visible: [] }, meshes: [] } });
    if (!result.ok) throw new Error(result.error.message);
  });
  await expect.poll(() => page.evaluate(id => window.__archai!.store.getState().doc.elements[id]!.visible, original.id)).toBe(false);
  await expect(page.locator('[data-mesh-plan="true"]')).toHaveCount(0);
  await page.evaluate(async glb => {
    await window.__archai!.executor.dispatch('bridge-sync', { key: 'revit:test-view', app: 'Revit', complete: false,
      model: { archaiRevit: 1, viewScope: { visible: ['a'] }, meshes: [{ id: 'a', name: 'Source updated', origin: [1500,0,0], size: [500,500,10], glb }] } });
  }, triangleGlb());
  await expect(page.locator('[data-mesh-plan="true"]')).toHaveCount(1);
  expect(await page.evaluate(id => {
    const doc = window.__archai!.store.getState().doc;
    return { id, materials: doc.elements[id]!.meta!['materials'], visible: doc.elements[id]!.visible, x: (doc.elements[id] as {x:number}).x };
  }, original.id)).toEqual({ ...original, visible: true, x: 1500 });
});

test('bridge model selection controls its geometry in bulk and plans arrive from the worker', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async (glb) => {
    const { executor, store } = window.__archai!;
    await executor.dispatch('new-document', { name: 'Bridge control check' });
    const result = await executor.dispatch('bridge-sync', { key: 'test', app: 'Rhino', name: 'Facade', model: { archaiRevit: 1, meshes: ['a', 'b'].map((id, i) => ({ id, name: `Panel ${id}`, origin: [i * 1000, 0, 0], size: [500, 500, 10], glb })) } });
    if (!result.ok) throw new Error(result.error.message);
    if (!store.getState().ui.panels.inspector) await executor.dispatch('toggle-inspector');
    const group = store.getState().doc.bridge!.sources['test']!.groupId!;
    await executor.dispatch('select', { ids: [group] });
  }, triangleGlb());
  await expect(page.locator('[data-mesh-plan="true"]')).toHaveCount(2);
  const inspector = page.getByTestId('bridge-inspector');
  await expect(inspector.getByRole('button', { name: 'Place in ArchAI' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Place in ArchAI' }).click();
  await expect.poll(() => page.evaluate(() => Object.values(window.__archai!.store.getState().doc.bridge!.elements).map((binding) => (binding as BridgeBinding).owners?.transform))).toEqual(['archai', 'archai']);
  await inspector.getByRole('button', { name: 'Shared control', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.values(window.__archai!.store.getState().doc.bridge!.elements).map((binding) => (binding as BridgeBinding).owners?.geometry))).toEqual(['shared', 'shared']);
  await page.getByTestId('live-link-chip').click();
  const panel = page.getByTestId('live-bridge-panel');
  await panel.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('send-only');
  await expect.poll(() => page.evaluate(() => window.__archai!.store.getState().doc.bridge!.sources['test']!.receives)).toBe('nothing');
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(panel.locator('[data-status="Paused"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/bridge-controls.png' });
});
