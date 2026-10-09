import * as THREE from 'three';
import type { ArchaiDocument } from '@/document';
import { buildScene } from '@/view3d/geometry';

/**
 * Builds a 3D scene group of the project document where all meshes are rendered
 * in a ghosted, semi-transparent slate gray reference material.
 * Raycasting is explicitly disabled on every object so it cannot be selected,
 * moved, or transformed by modeling tools.
 */
export function createGrayedOutProjectGroup(doc: ArchaiDocument): THREE.Group {
  const built = buildScene(doc, { textures: new Map(), models: new Map(), lod: 'low' });
  const group = new THREE.Group();
  group.name = 'project-reference-group';

  const grayMaterial = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.9,
    metalness: 0.05,
    transparent: true,
    opacity: 0.35,
    depthWrite: true,
  });

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x64748b,
    transparent: true,
    opacity: 0.45,
  });

  for (const item of built) {
    group.add(item.object);
  }

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = grayMaterial;
      child.castShadow = false;
      child.receiveShadow = false;
      child.userData['projectReference'] = true;
      child.userData['locked'] = true;
    } else if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.material = edgeMaterial;
      child.userData['projectReference'] = true;
      child.userData['locked'] = true;
    }
  });

  return group;
}

import { planeFrame, toPlane } from './kernel/sketch';
import type { SketchPlane, Vec2 } from './kernel/types';

export interface ProjectSnapCandidate {
  point: Vec2;
  point3D: [number, number, number];
  label: string;
  type: 'body-vertex' | 'edge-intersection' | 'endpoint';
}

interface CachedProjectGeometry {
  vertices: THREE.Vector3[];
  edges: [THREE.Vector3, THREE.Vector3][];
}

function getOrBuildCachedGeometry(group: THREE.Group): CachedProjectGeometry {
  const cached = group.userData['cachedProjectGeometry'] as CachedProjectGeometry | undefined;
  if (cached) return cached;

  group.updateMatrixWorld(true);
  const vertexMap = new Map<string, THREE.Vector3>();
  const edgeMap = new Map<string, [THREE.Vector3, THREE.Vector3]>();

  const vertexKey = (v: THREE.Vector3) => `${Math.round(v.x * 10)},${Math.round(v.y * 10)},${Math.round(v.z * 10)}`;
  const edgeKey = (k1: string, k2: string) => (k1 < k2 ? `${k1}:${k2}` : `${k2}:${k1}`);

  group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geom = child.geometry;
      const pos = geom.getAttribute('position');
      if (!pos) return;
      const matrix = child.matrixWorld;

      const getVertex = (index: number): THREE.Vector3 => {
        const v = new THREE.Vector3().fromBufferAttribute(pos, index).applyMatrix4(matrix);
        const key = vertexKey(v);
        let existing = vertexMap.get(key);
        if (!existing) {
          existing = v;
          vertexMap.set(key, existing);
        }
        return existing;
      };

      const indices = geom.index;
      if (indices) {
        for (let i = 0; i < indices.count; i += 3) {
          const v0 = getVertex(indices.getX(i));
          const v1 = getVertex(indices.getX(i + 1));
          const v2 = getVertex(indices.getX(i + 2));
          const k0 = vertexKey(v0);
          const k1 = vertexKey(v1);
          const k2 = vertexKey(v2);
          edgeMap.set(edgeKey(k0, k1), [v0, v1]);
          edgeMap.set(edgeKey(k1, k2), [v1, v2]);
          edgeMap.set(edgeKey(k2, k0), [v2, v0]);
        }
      } else {
        for (let i = 0; i < pos.count; i += 3) {
          const v0 = getVertex(i);
          const v1 = getVertex(i + 1);
          const v2 = getVertex(i + 2);
          const k0 = vertexKey(v0);
          const k1 = vertexKey(v1);
          const k2 = vertexKey(v2);
          edgeMap.set(edgeKey(k0, k1), [v0, v1]);
          edgeMap.set(edgeKey(k1, k2), [v1, v2]);
          edgeMap.set(edgeKey(k2, k0), [v2, v0]);
        }
      }
    } else if ((child instanceof THREE.Line || child instanceof THREE.LineSegments) && child.geometry) {
      const pos = child.geometry.getAttribute('position');
      if (!pos) return;
      const matrix = child.matrixWorld;
      for (let i = 0; i < pos.count - 1; i += 2) {
        const v0 = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix);
        const v1 = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(matrix);
        const k0 = vertexKey(v0);
        const k1 = vertexKey(v1);
        if (!vertexMap.has(k0)) vertexMap.set(k0, v0);
        if (!vertexMap.has(k1)) vertexMap.set(k1, v1);
        edgeMap.set(edgeKey(k0, k1), [vertexMap.get(k0)!, vertexMap.get(k1)!]);
      }
    }
  });

  const result: CachedProjectGeometry = {
    vertices: Array.from(vertexMap.values()),
    edges: Array.from(edgeMap.values()),
  };
  group.userData['cachedProjectGeometry'] = result;
  return result;
}

/**
 * Extracts 3D vertices from the project reference group that can be snapped to in modeling.
 */
export function extractProjectReferenceSnapPoints(group: THREE.Group): THREE.Vector3[] {
  return getOrBuildCachedGeometry(group).vertices;
}

/**
 * Extracts 2D snap points projected from project elements onto a sketch plane,
 * including 3D vertices and edge intersections with the plane.
 */
export function extractProjectElementSnapPoints(
  group: THREE.Group,
  plane: SketchPlane,
): ProjectSnapCandidate[] {
  const { vertices, edges } = getOrBuildCachedGeometry(group);
  const frame = planeFrame(plane);
  const normal = frame.normal;
  const origin = frame.origin;

  const candidates: ProjectSnapCandidate[] = [];
  const visited2D = new Set<string>();

  const addCandidate = (candidate: ProjectSnapCandidate) => {
    const key = `${Math.round(candidate.point[0] * 10)},${Math.round(candidate.point[1] * 10)}`;
    if (!visited2D.has(key)) {
      visited2D.add(key);
      candidates.push(candidate);
    }
  };

  // 1. Edge intersections crossing the plane
  for (const [a, b] of edges) {
    const da = (a.x - origin[0]) * normal[0] + (a.y - origin[1]) * normal[1] + (a.z - origin[2]) * normal[2];
    const db = (b.x - origin[0]) * normal[0] + (b.y - origin[1]) * normal[1] + (b.z - origin[2]) * normal[2];

    if (da * db < -1e-4) {
      const t = da / (da - db);
      const ix = a.x + t * (b.x - a.x);
      const iy = a.y + t * (b.y - a.y);
      const iz = a.z + t * (b.z - a.z);
      const p2d = toPlane(plane, [ix, iy, iz]);
      addCandidate({
        point: p2d,
        point3D: [ix, iy, iz],
        label: 'Project Intersection',
        type: 'edge-intersection',
      });
    }
  }

  // 2. Vertices projected onto the plane
  for (const v of vertices) {
    const p2d = toPlane(plane, [v.x, v.y, v.z]);
    addCandidate({
      point: p2d,
      point3D: [v.x, v.y, v.z],
      label: 'Project Element',
      type: 'body-vertex',
    });
  }

  return candidates;
}
