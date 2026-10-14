/** Opt-in diagnostic: npx vitest run --config scripts/bridge-performance.config.ts */
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { expect, it } from 'vitest';
import { createTestApp, run } from '../src/test/harness';
import type { BridgeSyncReport } from '../src/bridge/engine';
import { pullPlan } from '../src/bridge/pull';
import { needsRevert } from '../src/bridge/guard';
import { childLookup } from '../src/bridge/facets';
import { workingCopyText } from '../src/persistence/workingCopy';
import { planOfBlob } from '../src/render/meshPlan';

function glb(triangles: number, variant = 0): string {
  const bin = Buffer.alloc(triangles * 9 * 4);
  for (let i = 0; i < triangles; i++) {
    const x = (i % 1000) * 10 + variant;
    const z = Math.floor(i / 1000) * 10;
    [x, 0, z, x + 5, 0, z, x, 0, z + 5].forEach((v, j) => bin.writeFloatLE(v, (i * 9 + j) * 4));
  }
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: triangles * 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [10000 + variant, 0, 10000],
      },
    ],
  });
  const padded = Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json) / 4) * 4, ' '));
  const out = Buffer.alloc(28 + padded.length + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + padded.length);
  out.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(out, 28 + padded.length);
  return out.toString('base64');
}

const timed = <T>(fn: () => T) => {
  const start = performance.now();
  const value = fn();
  return { ms: +(performance.now() - start).toFixed(2), value };
};

it('measures isolated bridge command, guard, pull planning, save and dense plan costs', () => {
  const rows: unknown[] = [];
  // Harness uses normal command validation, Immer patches and undo; disable development-only invariant checks.
  for (const count of [25, 250, 1000, 2500]) {
    const app = createTestApp();
    app.executor.services.devChecks = false;
    const meshes = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      name: `Mesh ${i}`,
      origin: [i * 20, 0, 0],
      size: [10, 10, 10],
      glb: glb(1, i),
    }));
    const model = { archaiRevit: 1, app: 'Audit', name: 'Synthetic', meshes };
    const sync = (body: unknown, changeId: string) =>
      run<BridgeSyncReport>(app, 'bridge-sync', {
        key: 'audit',
        app: 'Audit',
        name: 'Synthetic',
        model: body,
        complete: false,
        changeId,
      });
    const first = timed(() => sync(model, 'first'));
    expect(first.value.created).toBe(count);
    const unchanged = timed(() => sync(model, 'same'));
    expect(unchanged.value.unchanged).toBe(count);
    const partial = timed(() =>
      sync({ ...model, meshes: [{ ...meshes[0], origin: [999, 0, 0] }] }, 'partial'),
    );
    expect(partial.value.updated).toBe(1);
    const doc = app.store.getState().doc;
    const guard = timed(() => {
      const children = childLookup(doc.elements);
      return Object.keys(doc.bridge!.elements).filter((id) => needsRevert(doc, id, children));
    });
    expect(guard.value).toHaveLength(0);
    const fresh = timed(() => pullPlan(doc, 'receiver', null));
    expect(fresh.value.nodes.size).toBe(count);
    const delta = timed(() => pullPlan(doc, 'receiver', fresh.value.sent));
    expect(delta.value.nodes.size).toBe(0);
    const save = timed(() => workingCopyText(doc));
    if (count > 25)
      rows.push({
        count,
        initialMs: first.ms,
        unchangedMs: unchanged.ms,
        oneObjectPartialMs: partial.ms,
        guardAllMs: guard.ms,
        freshPullPlanMs: fresh.ms,
        unchangedPullPlanMs: delta.ms,
        workingCopyMs: save.ms,
        workingCopyBytes: Buffer.byteLength(save.value),
        payloadBytes: Buffer.byteLength(JSON.stringify(model)),
        heapUsedMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
      });
  }
  const dense = [10000, 100000, 500000].map((triangles) => {
    const data = glb(triangles);
    const result = timed(() => planOfBlob(data));
    expect(result.value.edges.length).toBeGreaterThan(0);
    return {
      triangles,
      binaryMiB: +(Buffer.from(data, 'base64').length / 1048576).toFixed(2),
      planMs: result.ms,
      segments: result.value.edges.length / 4,
    };
  });
  const result = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGiB: +(totalmem() / 1073741824).toFixed(1),
    notes:
      'One sample per case after 25-object warmup. Synthetic valid unique GLBs. Node command timings exclude HTTP, Electron IPC, GPU, host export and asynchronous guard scheduling. Heap is a process snapshot, not peak or isolated case memory.',
    rows,
    dense,
  };
  writeFileSync('docs/bridge-performance-results.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
});
