import * as THREE from 'three';
import { expect, it } from 'vitest';
import { optimiseVrSurfaces } from './vrOptimise';
import { applyStaticTransform } from './staticGeometry';

it('batches identical opaque materials in world metres and preserves hidden and transparent surfaces', () => {
  const source = new THREE.Group();
  source.scale.setScalar(0.001);
  const material = new THREE.MeshStandardMaterial({ color: '#aa8844', roughness: 0.7 });
  const a = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), material);
  const b = new THREE.Mesh(a.geometry, material.clone());
  b.position.x = 2000;
  const glass = new THREE.Mesh(
    a.geometry,
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.2 }),
  );
  glass.position.z = 2000;
  const hidden = a.clone();
  hidden.position.x = 100_000;
  hidden.visible = false;
  source.add(a, b, glass, hidden);
  const exported = optimiseVrSurfaces(source);
  const visible: THREE.Mesh[] = [];
  exported.traverseVisible((object) => {
    if (object instanceof THREE.Mesh) visible.push(object);
  });
  expect(visible).toHaveLength(2);
  const opaque = visible.find((mesh) => !(mesh.material as THREE.Material).transparent)!;
  expect(opaque.geometry.index!.count).toBe(72);
  expect(new THREE.Box3().setFromObject(opaque).max.x).toBeCloseTo(2.5);
  expect(visible.some((mesh) => (mesh.material as THREE.Material).transparent)).toBe(true);
  expect(source.children).toHaveLength(4);
  expect(a.parent).toBe(source);
});

it('keeps mirrored triangle winding consistent with transformed normals', () => {
  for (const indexed of [true, false]) {
    const box = new THREE.BoxGeometry();
    const geometry = indexed ? box : box.toNonIndexed();
    applyStaticTransform(geometry, new THREE.Matrix4().makeScale(-1, 1, 1));
    const p = geometry.getAttribute('position');
    const i = (vertex: number) => (geometry.index ? geometry.index.getX(vertex) : vertex);
    const a = new THREE.Vector3().fromBufferAttribute(p, i(0));
    const b = new THREE.Vector3().fromBufferAttribute(p, i(1));
    const c = new THREE.Vector3().fromBufferAttribute(p, i(2));
    const face = b.sub(a).cross(c.sub(a)).normalize();
    const normal = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('normal'), i(0));
    expect(face.dot(normal)).toBeCloseTo(1);
  }
});

it('decodes normalized integer positions before flattening a compressed model', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Int16BufferAttribute([-32767, 0, 0, 32767, 0, 0, 0, 32767, 0], 3, true),
  );
  applyStaticTransform(geometry, new THREE.Matrix4().makeScale(10, 10, 10).setPosition(3, 0, 0));
  const position = geometry.getAttribute('position');
  expect(position.array).toBeInstanceOf(Float32Array);
  expect(position.getX(0)).toBeCloseTo(-7);
  expect(position.getX(1)).toBeCloseTo(13);
  expect(position.getY(2)).toBeCloseTo(10);
});
