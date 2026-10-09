/**
 * Geometry helpers for materials (docs/materials.md §3–4):
 * - `groupByNormal` splits a mesh's triangles into top / bottom / sides groups, so each named
 *   surface can take its own material;
 * - `applyWorldUvs` gives meshes UVs in world millimetres: horizontal faces map plan x / y,
 *   vertical faces map along the face (its horizontal direction) and up. Every face of every
 *   element shares one world frame, so brick courses line up across walls and corners.
 */
import * as THREE from 'three';

export const TOP = 0;
export const BOTTOM = 1;
export const SIDES = 2;

const UP_LIMIT = 0.7;

/** Reorders triangles into groups 0 = top, 1 = bottom, 2 = sides (local +y is up). */
export function groupByNormal(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const attributes = Object.keys(geometry.attributes);
  const buckets: number[][] = [[], [], []];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let triangle = 0; triangle < position.count / 3; triangle++) {
    a.fromBufferAttribute(position, triangle * 3);
    b.fromBufferAttribute(position, triangle * 3 + 1);
    c.fromBufferAttribute(position, triangle * 3 + 2);
    normal.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    buckets[normal.y > UP_LIMIT ? TOP : normal.y < -UP_LIMIT ? BOTTOM : SIDES]!.push(triangle);
  }
  const out = new THREE.BufferGeometry();
  for (const name of attributes) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
    const size = attribute.itemSize;
    const array = new Float32Array(attribute.count * size);
    let cursor = 0;
    for (const bucket of buckets) {
      for (const triangle of bucket) {
        for (let corner = 0; corner < 3; corner++) {
          for (let k = 0; k < size; k++) array[cursor++] = attribute.array[(triangle * 3 + corner) * size + k]!;
        }
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  let start = 0;
  buckets.forEach((bucket, index) => {
    if (bucket.length) out.addGroup(start, bucket.length * 3, index);
    start += bucket.length * 3;
  });
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (geometry !== source) geometry.dispose();
  return out;
}

function hasMaps(material: THREE.Material | THREE.Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((item) => {
    const standard = item as THREE.MeshStandardMaterial;
    return Boolean(standard.map || standard.normalMap || standard.roughnessMap || standard.metalnessMap || standard.aoMap);
  });
}

/**
 * World-millimetre UVs for every textured mesh under `root` (assets keep their own UVs). Call
 * once the object sits where it will be shown; geometry is copied, so shared geometry is safe.
 */
export function applyWorldUvs(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || child.userData['shared'] || child.userData['assetMesh'] || !hasMaps(child.material)) return;
    const geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = new Float32Array(position.count * 2);
    for (let triangle = 0; triangle < position.count / 3; triangle++) {
      for (let corner = 0; corner < 3; corner++) p[corner]!.fromBufferAttribute(position, triangle * 3 + corner).applyMatrix4(child.matrixWorld);
      normal.subVectors(p[2]!, p[1]!).cross(p[0]!.clone().sub(p[1]!)).normalize();
      const horizontal = Math.abs(normal.y) > UP_LIMIT;
      // Along a vertical face: its horizontal direction, so u increases left to right seen from outside.
      if (!horizontal) tangent.set(-normal.z, 0, normal.x).normalize();
      for (let corner = 0; corner < 3; corner++) {
        const point = p[corner]!;
        const index = (triangle * 3 + corner) * 2;
        if (horizontal) {
          uv[index] = point.x;
          uv[index + 1] = normal.y > 0 ? -point.z : point.z;
        } else {
          uv[index] = point.x * tangent.x + point.z * tangent.z;
          uv[index + 1] = point.y;
        }
      }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    child.geometry = geometry;
  });
}
