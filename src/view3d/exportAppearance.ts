import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ViewStyle } from './SceneView';
import { presentationMaterial, FEATURE_EDGE_ANGLE } from './displayMaterials';

/** glTF/Unreal cannot display Three line primitives; use thin solid crease edges. */
export function exportAppearance(
  root: THREE.Object3D,
  style: ViewStyle,
  unit: 'mm' | 'm' = 'mm',
): () => void {
  if (style === 'realistic') return () => {};
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  const owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  const undo: Array<() => void> = [];
  for (const mesh of meshes) {
    const geometryBefore = mesh.geometry,
      materialBefore = mesh.material;
    undo.push(() => {
      mesh.geometry = geometryBefore;
      mesh.material = materialBefore;
    });
    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = originals.map((material) => {
      const appearance = presentationMaterial(material, style) as THREE.MeshStandardMaterial;
      if (!(appearance instanceof THREE.MeshBasicMaterial)) return appearance;
      const lit = new THREE.MeshStandardMaterial({ color: appearance.color, map: appearance.map, alphaMap: appearance.alphaMap, alphaTest: appearance.alphaTest, transparent: appearance.transparent, opacity: appearance.opacity, side: appearance.side, vertexColors: appearance.vertexColors, roughness: 0.9, metalness: 0 });
      appearance.dispose();
      return lit;
    });
    owned.push(...materials);
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0]!;
    if (style !== 'wireframe' && style !== 'hidden-line') continue;
    const edges = new THREE.EdgesGeometry(mesh.geometry, FEATURE_EDGE_ANGLE);
    const p = edges.getAttribute('position');
    mesh.geometry.computeBoundingBox();
    const radius = Math.max(
      unit === 'mm' ? 0.5 : 0.0005,
      mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 0.00035,
    );
    const parts: THREE.BufferGeometry[] = [];
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < p.count; i += 2) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      const length = a.distanceTo(b);
      if (length < 0.001) continue;
      const geometry = new THREE.CylinderGeometry(radius, radius, length, 3, 1, false);
      geometry.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize()),
      );
      geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      parts.push(geometry);
    }
    edges.dispose();
    if (!parts.length) continue;
    const geometry = mergeGeometries(parts)!;
    parts.forEach((part) => part.dispose());
    const material = new THREE.MeshStandardMaterial({ color: '#293543', roughness: 1 });
    owned.push(geometry, material);
    if (style === 'wireframe') {
      mesh.geometry = geometry;
      mesh.material = material;
    } else {
      const lines = new THREE.Mesh(geometry, material);
      lines.name = `${mesh.name}_edges`;
      lines.userData = { ...mesh.userData };
      mesh.add(lines);
      undo.push(() => mesh.remove(lines));
    }
  }
  return () => {
    undo.reverse().forEach((restore) => restore());
    owned.forEach((item) => item.dispose());
  };
}
