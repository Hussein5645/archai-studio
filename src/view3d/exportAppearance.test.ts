import * as THREE from 'three';
import { expect, it } from 'vitest';
import { exportAppearance } from './exportAppearance';

it('can switch through all render styles without corrupting cached source geometry or materials', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(200, 300, 200);
  const material = new THREE.MeshStandardMaterial({ color: '#c0a080' });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData = { archai: { id: 'column' } };
  root.add(mesh);
  for (const style of ['wireframe', 'hidden-line', 'consistent', 'shaded', 'realistic'] as const) {
    const restore = exportAppearance(root, style);
    if (style === 'hidden-line') expect(mesh.children).toHaveLength(1);
    restore();
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(mesh.children).toHaveLength(0);
    expect(mesh.geometry.getAttribute('position').count).toBe(24);
  }
  geometry.dispose(); material.dispose();
});
