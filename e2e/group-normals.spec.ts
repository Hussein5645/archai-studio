import { expect, test } from '@playwright/test';
import * as THREE from 'three';

function mixedBox() {
  const g = new THREE.BoxGeometry(1000, 1000, 1000).translate(500, 500, 500).toNonIndexed();
  const p = g.getAttribute('position');
  for (let face = 0; face < 10; face++) {
    const i = face * 3, b = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ...b as [number, number, number]);
  }
  const data = Buffer.from(p.array.buffer);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: data.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.length }], accessors: [{ bufferView: 0, componentType: 5126, count: p.count, type: 'VEC3', min: [0, 0, 0], max: [1000, 1000, 1000] }] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const out = Buffer.alloc(28 + padded.length + data.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(data.length, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); data.copy(out, 28 + padded.length);
  return out.toString('base64');
}

test('Inspector repairs nested imported meshes in one step and export retains the repair', async ({ page }, testInfo) => {
  await page.goto('/'); await page.waitForFunction(() => Boolean(window.__archai));
  const ids = await page.evaluate(async (glb) => {
    const { executor } = window.__archai!;
    const run = async (name: string, input: unknown = {}) => { const r = await executor.dispatch(name, input); if (!r.ok) throw new Error(r.error.message); return String(r.value); };
    await run('new-document');
    const create = (name: string, x: number) => run('create-mesh-element', { name, glb, x, y: 0, size: [1000, 1000, 1000] });
    const a = await create('Mixed box A', 0), b = await create('Mixed box B', 2000);
    const inner = await run('group-selection', { ids: [b], name: 'Nested models' });
    const group = await run('group-selection', { ids: [a, inner], name: 'All imported models' });
    await run('select', { ids: [group] });
    return { a, b, group };
  }, mixedBox());
  const section = page.getByTestId('group-mesh-normals');
  await expect(section).toContainText('2 models');
  await section.getByRole('button', { name: 'Auto repair all mesh normals', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Auto repair applied to 2 models');
  const repaired = await page.evaluate(async ({ a, b }) => {
    const app = window.__archai!;
    const doc = app.store.getState().doc;
    const url = '/src/view3d/vrExport.ts';
    const { buildSurfaces } = await import(url);
    const root = await buildSurfaces(doc, app.catalog);
    const report: { closedShells: number; flippedFaces: number }[] = [];
    root.traverse((child: { geometry?: { userData: { normalRepair?: { closedShells: number; flippedFaces: number } } } }) => { if (child.geometry?.userData.normalRepair) report.push(child.geometry.userData.normalRepair); });
    return { modes: [a, b].map((id) => doc.elements[id]!.meta?.['normalMode']), report };
  }, ids);
  expect(repaired.modes).toEqual(['auto', 'auto']);
  expect(repaired.report).toHaveLength(2);
  for (const report of repaired.report) expect(report).toMatchObject({ closedShells: 1, flippedFaces: 10 });
  await page.screenshot({ path: testInfo.outputPath('group-normals.png') });
  await page.evaluate(async () => { await window.__archai!.executor.dispatch('undo'); });
  expect(await page.evaluate(({ a, b }) => [a, b].map((id) => window.__archai!.store.getState().doc.elements[id]!.meta?.['normalMode'] ?? null), ids)).toEqual([null, null]);
});
