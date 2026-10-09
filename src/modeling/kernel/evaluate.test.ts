import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateBody, FeatureError, KernelCache } from './evaluate';
import { meshOf } from './mesh';
import { identityPlacement, type Body, type Feature } from './types';

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function body(features: Feature[], id = 'body-1'): Body {
  return { id, name: 'Test', visible: true, lowLod: false, material: 'oak', placement: identityPlacement(), features };
}

const box = (size: [number, number, number], placement = identityPlacement()): Feature => ({ kind: 'primitive', id: 'f-box', shape: 'box', size, placement });

describe('evaluateBody', () => {
  it('builds a box of the given volume, centred in plan and resting on the ground', () => {
    const { manifold } = evaluateBody(wasm, body([box([100, 200, 300])]));
    expect(manifold.volume()).toBeCloseTo(100 * 200 * 300, 3);
    const bounds = manifold.boundingBox();
    expect(bounds.min).toEqual([-50, 0, -150]);
    expect(bounds.max).toEqual([50, 200, 150]);
    expect(manifold.status()).toBe('NoError');
  });

  it('stands a cylinder up along Y with the diameter taken from the width', () => {
    const { manifold } = evaluateBody(wasm, body([{ kind: 'primitive', id: 'f', shape: 'cylinder', size: [100, 300, 100], segments: 128, placement: identityPlacement() }]));
    const bounds = manifold.boundingBox();
    expect(bounds.min[1]).toBeCloseTo(0, 6);
    expect(bounds.max[1]).toBeCloseTo(300, 6);
    expect(bounds.max[0]).toBeCloseTo(50, 6);
    // A 128-gon is within 0.2% of the true circle.
    expect(manifold.volume()).toBeCloseTo(Math.PI * 50 * 50 * 300, -4);
  });

  it('puts a sphere and a cone on the ground', () => {
    const sphere = evaluateBody(wasm, body([{ kind: 'primitive', id: 'f', shape: 'sphere', size: [200, 200, 200], placement: identityPlacement() }])).manifold.boundingBox();
    expect(sphere.min[1]).toBeCloseTo(0, 6);
    expect(sphere.max[1]).toBeCloseTo(200, 6);
    const cone = evaluateBody(wasm, body([{ kind: 'primitive', id: 'f', shape: 'cone', size: [200, 500, 200], placement: identityPlacement() }])).manifold;
    expect(cone.volume()).toBeCloseTo((Math.PI * 100 * 100 * 500) / 3, -4);
  });

  it('applies the primitive placement and transform features in order', () => {
    const features: Feature[] = [box([100, 100, 100], { position: [1000, 0, 0], rotation: [0, 0, 0] }), { kind: 'transform', id: 'f-move', translate: [0, 50, 0], scale: 2 }];
    const { manifold } = evaluateBody(wasm, body(features));
    const bounds = manifold.boundingBox();
    // Scale doubles about the origin (x 950..1050 → 1900..2100), then the translation lifts it.
    expect(bounds.min).toEqual([1900, 50, -100]);
    expect(bounds.max).toEqual([2100, 250, 100]);
  });

  it('persists direct vertex and edge edits in the evaluated recipe', () => {
    const features: Feature[] = [
      box([100, 100, 100]),
      { kind: 'direct-edit', id: 'move-edge', points: [[-50, 100, -50], [50, 100, -50]], delta: [0, 25, 0] },
    ];
    const { manifold } = evaluateBody(wasm, body(features));
    const bounds = manifold.boundingBox();
    expect(bounds.max[1]).toBeCloseTo(125, 5);
    expect(manifold.status()).toBe('NoError');
  });

  it('reuses cached prefixes and prunes what an edit no longer needs', () => {
    const cache = new KernelCache();
    const first = evaluateBody(wasm, body([box([100, 100, 100]), { kind: 'transform', id: 't', translate: [10, 0, 0] }]), cache);
    const second = evaluateBody(wasm, body([box([100, 100, 100]), { kind: 'transform', id: 't', translate: [20, 0, 0] }]), cache);
    expect(second.manifold).not.toBe(first.manifold);
    expect(second.manifold.boundingBox().min[0]).toBe(-30);
    // The primitive entry survived: evaluating the same recipe again returns the same handles.
    const third = evaluateBody(wasm, body([box([100, 100, 100]), { kind: 'transform', id: 't', translate: [20, 0, 0] }]), cache);
    expect(third.manifold).toBe(second.manifold);
  });

  it('rejects impossible dimensions with the feature that failed', () => {
    expect(() => evaluateBody(wasm, body([box([0, 100, 100])]))).toThrow(FeatureError);
    try {
      evaluateBody(wasm, body([box([100, -1, 100])]));
    } catch (error) {
      expect((error as FeatureError).featureId).toBe('f-box');
    }
    expect(() => evaluateBody(wasm, body([]))).toThrow(/no features/);
    expect(() => evaluateBody(wasm, body([{ kind: 'transform', id: 't', translate: [1, 0, 0] }]))).toThrow(/Nothing to transform/);
  });
});

describe('meshOf', () => {
  it('returns GL arrays with smoothed normals and the run per feature', () => {
    const mesh = meshOf(evaluateBody(wasm, body([{ kind: 'primitive', id: 'f-cyl', shape: 'cylinder', size: [100, 300, 100], segments: 48, placement: identityPlacement() }])));
    expect(mesh.triangles).toBeGreaterThan(48 * 2);
    expect(mesh.indices.length).toBe(mesh.triangles * 3);
    expect(mesh.positions.length).toBe(mesh.normals.length);
    expect(mesh.faceIds.length).toBe(mesh.triangles);
    expect(mesh.runs).toEqual([{ start: 0, count: mesh.indices.length, featureId: 'f-cyl' }]);
    expect(mesh.volume).toBeCloseTo(Math.PI * 50 * 50 * 300, -5);
    expect(mesh.bounds.max[1]).toBeCloseTo(300, 6);
    // Every normal is unit length; the side normals are horizontal (smoothed around the barrel).
    let horizontal = 0;
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const [x, y, z] = [mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!];
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 4);
      if (Math.abs(y) < 1e-4) horizontal++;
    }
    expect(horizontal).toBeGreaterThanOrEqual(48 * 2);
  });

  it('keeps a box faceted: six distinct face normals', () => {
    const mesh = meshOf(evaluateBody(wasm, body([box([100, 100, 100])])));
    const normals = new Set<string>();
    for (let i = 0; i < mesh.normals.length; i += 3) normals.add([mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]].map((v) => Math.round(v! * 100) / 100).join(','));
    expect(normals.size).toBe(6);
    expect(mesh.triangles).toBe(12);
  });
});
