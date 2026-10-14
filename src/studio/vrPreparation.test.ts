import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '@/test/harness';
import { defaultSettings } from './settings';
import { preparationSignature, preparedLinkKey, throwIfCancelled } from './vrPreparation';
import { prepareBakeGeometry } from './bakeGeometry';
import { traceBake, type BakeInput } from './bakeTrace';

describe('VR preparation', () => {
  it('lights both visible sides of an inward-wound flat import independently', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-2, 0, -2, 2, 0, -2, 0, 0, 2], 3),
    );
    const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    const mesh = prepareBakeGeometry(root, 100, 10).children[0] as THREE.Mesh;
    const normals = mesh.geometry.getAttribute('normal');
    expect(normals.count).toBe(6);
    expect(Array.from({ length: 6 }, (_, i) => normals.getY(i)).sort()).toEqual([
      -1, -1, -1, 1, 1, 1,
    ]);
    const colors = traceBake({
      positions: mesh.geometry.getAttribute('position').array as Float32Array,
      normals: normals.array as Float32Array,
      triangles: new Float32Array(),
      albedos: new Float32Array(),
      emission: new Float32Array(),
      sun: [0, 1, 0],
      sunIntensity: Math.PI,
      skyIntensity: 0,
      environment: null,
      samples: 8,
      bounces: 0,
    });
    for (let i = 0; i < normals.count; i++)
      expect(colors[i * 3]).toBeCloseTo(normals.getY(i) > 0 ? 1 : 0);
    expect(geometry.getAttribute('normal')).toBeUndefined();
  });
  it('does not duplicate faces when an import already includes both windings', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-2, 0, -2, 2, 0, -2, 0, 0, 2, 0, 0, 2, 2, 0, -2, -2, 0, -2],
        3,
      ),
    );
    const root = new THREE.Group();
    root.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true }),
      ),
    );
    const baked = prepareBakeGeometry(root, 100, 10).children[0] as THREE.Mesh;
    expect(baked.geometry.index!.count).toBe(6);
  });
  it('invalidates lighting and project edits, including embedded models, without invalidating camera-only settings', () => {
    const doc = createTestApp().store.getState().doc;
    const settings = defaultSettings();
    const initial = preparationSignature(doc, settings, 'balanced');
    expect(preparationSignature(doc, { ...settings, fov: 80, focusDistance: 30 }, 'balanced')).toBe(
      initial,
    );
    expect(preparationSignature(doc, { ...settings, sunIntensity: 4 }, 'balanced')).not.toBe(
      initial,
    );
    expect(
      preparationSignature(
        {
          ...doc,
          blobs: { ...doc.blobs, added: { mime: 'model/gltf-binary', data: 'changed' } },
        } as unknown as typeof doc,
        settings,
        'balanced',
      ),
    ).not.toBe(initial);
    expect(preparationSignature(doc, settings, 'high')).not.toBe(initial);
    expect(
      preparationSignature(
        { ...doc, workspace: { ...doc.workspace, boardElevation: 2000 } },
        settings,
        'balanced',
      ),
    ).not.toBe(initial);
    expect(preparedLinkKey(doc.id, 'baked')).not.toBe(preparedLinkKey(doc.id, 'panorama'));
    const abort = new AbortController();
    abort.abort();
    expect(() => throwIfCancelled(abort.signal)).toThrow('Preparation cancelled');
  });

  it('bakes detached world geometry while preserving source UVs, groups, and the original scene', () => {
    const root = new THREE.Group();
    root.scale.setScalar(0.001);
    const first = new THREE.MeshStandardMaterial({ color: '#aabbcc' });
    const second = new THREE.MeshStandardMaterial({ color: '#445566' });
    const source = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), [
      first,
      second,
      first,
      second,
      first,
      second,
    ]);
    source.position.x = 2000;
    root.add(source);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), first);
    hidden.visible = false;
    root.add(hidden);
    const baked = prepareBakeGeometry(root, 0.5, 100);
    expect(baked.children).toHaveLength(2);
    const bounds = new THREE.Box3().setFromObject(baked);
    expect(bounds.min.x).toBeCloseTo(1.5);
    expect(bounds.max.x).toBeCloseTo(2.5);
    const count = baked.children.reduce(
      (n, child) => n + (child as THREE.Mesh).geometry.index!.count / 3,
      0,
    );
    expect(count).toBeGreaterThan(12);
    expect(count).toBeLessThanOrEqual(100);
    for (const child of baked.children as THREE.Mesh[]) {
      expect(child.geometry.getAttribute('uv').count).toBe(
        child.geometry.getAttribute('position').count,
      );
      expect(child.geometry.getAttribute('normal').count).toBe(
        child.geometry.getAttribute('position').count,
      );
    }
    expect(source.parent).toBe(root);
    expect(source.geometry.index!.count).toBe(36);
    expect(source.geometry.getAttribute('color')).toBeUndefined();
  });

  it('stores direct illumination and occlusion rather than relabelling an unbaked model', () => {
    const input: BakeInput = {
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 1, 0]),
      triangles: new Float32Array(),
      albedos: new Float32Array(),
      emission: new Float32Array(),
      sun: [0, 1, 0],
      sunIntensity: Math.PI,
      skyIntensity: 0,
      environment: null,
      samples: 8,
      bounces: 0,
    };
    const lit = traceBake(input);
    expect(lit[0]).toBeCloseTo(1);
    expect(lit[1]).toBeCloseTo(1);
    const blocked = traceBake({
      ...input,
      triangles: new Float32Array([-10, 1, -10, 10, 1, -10, 0, 1, 10]),
      albedos: new Float32Array([0.5, 0.5, 0.5]),
      emission: new Float32Array([0, 0, 0]),
    });
    expect(blocked[0]).toBeCloseTo(0);
    const dark = traceBake({ ...input, sunIntensity: 0 });
    expect([...dark]).toEqual([0, 0, 0]);
  });
});
