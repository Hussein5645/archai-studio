import * as THREE from 'three';
import type { ViewStyle } from './SceneView';

/** Styling copies keep source colour attributes, textures and cutout silhouettes. */
export function presentationMaterial(base: THREE.Material, style: ViewStyle): THREE.Material {
  const source = base as THREE.MeshStandardMaterial;
  const color = source.color?.clone() ?? new THREE.Color('#bfc3ca');
  const silhouette = { side: base.side, alphaMap: source.alphaMap ?? null, alphaTest: base.alphaTest, transparent: base.transparent, opacity: base.opacity, depthWrite: base.depthWrite };
  if (style === 'consistent') return new THREE.MeshBasicMaterial({ ...silhouette, color, map: source.map ?? null, vertexColors: base.vertexColors, toneMapped: false });
  if (style === 'hidden-line') return new THREE.MeshBasicMaterial({ ...silhouette, color: '#fffdf8', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, toneMapped: false });
  if (style === 'wireframe') return new THREE.MeshBasicMaterial({ color: '#b7c0cb', side: THREE.DoubleSide, transparent: true, opacity: 0.08, depthWrite: false, toneMapped: false });
  if (style === 'section') return new THREE.MeshBasicMaterial({ color: '#f2f2f0', side: THREE.DoubleSide, toneMapped: false });
  return new THREE.MeshStandardMaterial({ ...silhouette, color: '#c5b49a', roughness: 0.93, metalness: 0, side: THREE.DoubleSide, flatShading: source.flatShading });
}

export const FEATURE_EDGE_ANGLE = 25;
export const FEATURE_EDGE_LOOK = {
  realistic: { color: '#313a40', opacity: 0.28 },
  consistent: { color: '#313a40', opacity: 0.45 },
  shaded: { color: '#514637', opacity: 0.36 },
  'hidden-line': { color: '#242b31', opacity: 0.95 },
  wireframe: { color: '#293543', opacity: 0.9 },
};

/** The same crease edges for ordinary and hardware-instanced source meshes. */
export function featureEdgeObject(mesh: THREE.Mesh, source: THREE.BufferGeometry, look: { color: string; opacity: number }): THREE.LineSegments {
  const material = new THREE.LineBasicMaterial({ ...look, transparent: true, toneMapped: false, depthWrite: false });
  let geometry = source;
  if (mesh instanceof THREE.InstancedMesh) {
    const instanced = new THREE.InstancedBufferGeometry();
    instanced.setAttribute('position', source.getAttribute('position'));
    instanced.setAttribute('edgeInstanceMatrix', new THREE.InstancedBufferAttribute(mesh.instanceMatrix.array, 16));
    instanced.instanceCount = mesh.count;
    geometry = instanced;
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute mat4 edgeInstanceMatrix;')
        .replace('#include <begin_vertex>', 'vec3 transformed = (edgeInstanceMatrix * vec4(position, 1.0)).xyz;');
    };
    material.customProgramCacheKey = () => 'archai-instanced-feature-edges-v1';
  }
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = !(mesh instanceof THREE.InstancedMesh);
  object.userData['ownsEdgeGeometry'] = geometry !== source;
  return object;
}
