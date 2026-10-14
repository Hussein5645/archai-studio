import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyStaticTransform } from './staticGeometry';

/** Batch compatible opaque surfaces. Transparent/animated meshes keep their own nodes. */
export function optimiseVrSurfaces(source: THREE.Group): THREE.Group {
  const root = source.clone(true);
  root.updateWorldMatrix(true, true);
  const buckets = new Map<
    string,
    { material: THREE.Material; meshes: THREE.Mesh[]; geometries: THREE.BufferGeometry[] }
  >();
  root.traverseVisible((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      object instanceof THREE.SkinnedMesh ||
      object instanceof THREE.InstancedMesh ||
      Array.isArray(object.material)
    )
      return;
    const material = object.material;
    if (
      material.transparent ||
      material.opacity < 1 ||
      !['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshBasicMaterial'].includes(
        material.type,
      ) ||
      object.geometry.drawRange.count !== Infinity
    )
      return;
    // UUID/name/extras do not affect appearance. All public serializable material
    // properties, texture identities and attribute layouts do affect compatibility.
    const appearance = Object.fromEntries(
      Object.entries(material).flatMap(([key, value]) => {
        if (
          ['id', 'uuid', 'name', 'userData', 'version', '_listeners'].includes(key) ||
          typeof value === 'function'
        )
          return [];
        if (value instanceof THREE.Texture) return [[key, value.uuid]];
        if (
          value instanceof THREE.Color ||
          value instanceof THREE.Vector2 ||
          value instanceof THREE.Vector3
        )
          return [[key, value.toArray()]];
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
          return [[key, value]];
        return [];
      }),
    );
    const sourceGeometry = object.geometry as THREE.BufferGeometry;
    if (Object.keys(sourceGeometry.morphAttributes).length) return;
    const layout = Object.entries(sourceGeometry.attributes).map(([key, attribute]) => [
      key,
      attribute.itemSize,
      attribute.normalized,
      attribute.array.constructor.name,
    ]);
    const key = JSON.stringify([appearance, layout]);
    const geometry = sourceGeometry.clone();
    applyStaticTransform(geometry, object.matrixWorld);
    const bucket: {
      material: THREE.Material;
      meshes: THREE.Mesh[];
      geometries: THREE.BufferGeometry[];
    } = buckets.get(key) ?? { material, meshes: [], geometries: [] };
    bucket.meshes.push(object);
    bucket.geometries.push(geometry);
    buckets.set(key, bucket);
  });
  const output = new THREE.Group();
  output.name = source.name;
  output.add(root);
  for (const bucket of buckets.values()) {
    // Matching material meshes may mix indexed and non-indexed geometries.
    const geometries = bucket.geometries.map((geometry) =>
      geometry.index ? geometry.toNonIndexed() : geometry,
    );
    const merged = mergeGeometries(geometries, false);
    if (merged) {
      for (const mesh of bucket.meshes) mesh.removeFromParent();
      const indexed = mergeVertices(merged);
      merged.dispose();
      const mesh = new THREE.Mesh(indexed, bucket.material);
      mesh.name = bucket.material.name || 'VR surfaces';
      output.add(mesh);
    }
    for (const geometry of new Set([...geometries, ...bucket.geometries])) geometry.dispose();
  }
  return output;
}
