import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Opt in with ARCHAI_PERF_DOCUMENT=<saved project id>. Read-only access to mesh
// records; measurements run in Playwright's isolated browser, never the user's app.
test('measures preview reduction using the largest meshes of a saved project', async ({ page }) => {
  const project = process.env.ARCHAI_PERF_DOCUMENT;
  test.skip(!project, 'Set ARCHAI_PERF_DOCUMENT to benchmark a real saved project');
  test.setTimeout(180_000);
  const folder = join(process.env.APPDATA!, 'archai', 'storage');
  const read = (key: string): string => {
    const record = JSON.parse(readFileSync(join(folder, key.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json'), 'utf8'));
    expect(record.key).toBe(key);
    const marker = 'ARCHAI_CHUNKED_STORAGE_V1\n';
    return record.value.startsWith(marker) ? JSON.parse(record.value.slice(marker.length)).map(read).join('') : record.value;
  };
  const doc = JSON.parse(read(`doc:${project}`));
  const ids = [...new Set<string>(Object.values(doc.elements).map((element: unknown) => (element as { meta?: { mesh?: { blobId: string } } }).meta?.mesh?.blobId).filter((id): id is string => Boolean(id)))];
  const models = ids.map(id => {
    const data = doc.blobs[id].data || read(`blob:${project}:${id}`);
    const bytes = Buffer.from(data, 'base64');
    const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());
    let triangles = 0;
    for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) {
      if ((p.mode ?? 4) === 4) triangles += json.accessors[p.indices ?? p.attributes.POSITION].count / 3;
    }
    return { id, data, triangles };
  }).sort((a, b) => b.triangles - a.triangles);
  const total = models.reduce((sum, model) => sum + model.triangles, 0);
  await page.goto('/');
  const results = [];
  for (const model of models.slice(0, 3)) {
    const result = await page.evaluate(async ({ data, target, error }) => {
      const appearance = '/src/view3d/largeScene.ts';
      const { reduceLargeScene, sceneTriangles, disposeReducedScene } = await import(appearance);
      const loaderPath = '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
      const decoderPath = '/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
      const { GLTFLoader } = await import(loaderPath);
      const { MeshoptDecoder } = await import(decoderPath);
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const source = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, '')).scene;
      const before = sceneTriangles(source);
      const geometryInfo: unknown[] = [];
      source.updateWorldMatrix(true, true);
      source.traverse((mesh: { geometry?: { attributes: Record<string, unknown>; computeBoundingBox: () => void; boundingBox: unknown; groups: unknown[] }; matrixWorld: { getMaxScaleOnAxis: () => number } }) => {
        if (!mesh.geometry) return;
        mesh.geometry.computeBoundingBox();
        geometryInfo.push({ attributes: Object.keys(mesh.geometry.attributes), bounds: mesh.geometry.boundingBox, scale: mesh.matrixWorld.getMaxScaleOnAxis(), groups: mesh.geometry.groups.length });
      });
      const start = performance.now();
      const preview = await reduceLargeScene(source, target, error, undefined, false, true);
      const after = sceneTriangles(preview);
      const elapsed = performance.now() - start;
      const unchanged = sceneTriangles(source) === before;
      disposeReducedScene(preview, source);
      return { before, after, target, error, geometryInfo, milliseconds: Math.round(elapsed), unchanged };
    }, { data: model.data, target: Math.floor(350000 * model.triangles / total), error: Number(process.env.ARCHAI_PERF_TOLERANCE) || 10 });
    expect(result.unchanged).toBe(true);
    expect(result.after).toBeLessThan(result.before);
    results.push(result);
  }
  console.log(JSON.stringify({ project: doc.meta.name, sourceTriangles: total, largestMeshes: results }, null, 2));
});
