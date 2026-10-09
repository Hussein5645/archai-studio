import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { coplanarFace, pickTopology } from './topology';
import { faceBoundaryLoops, planeOnFace, planeThroughPoint, traceOntoPlane } from './referenceActions';
import { planeFrame } from './kernel/sketch';

function scene() {
  // A 1000 mm cube centred at the origin, seen from the front (+Z) by an orthographic camera.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000));
  const camera = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, 1, 20_000);
  camera.position.set(0, 0, 5000);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  // World (x, y) -> client pixels: 2 mm per pixel, y down.
  const at = (x: number, y: number) => ({ clientX: 500 + x / 2, clientY: 500 - y / 2 });
  return { targets: [{ mesh, source: { kind: 'project' as const } }], view: (x: number, y: number) => ({ camera, rect, ...at(x, y) }), mesh };
}

describe('pickTopology', () => {
  it('prefers a vertex near the pointer, then an edge, then the face', () => {
    const { targets, view } = scene();
    const vertex = pickTopology(targets, view(496, 496), { faces: true });
    expect(vertex?.kind).toBe('vertex');
    expect(vertex?.kind === 'vertex' && vertex.point.map(Math.round)).toEqual([500, 500, 500]);
    const edge = pickTopology(targets, view(0, 494), { faces: true });
    expect(edge?.kind).toBe('edge');
    const face = pickTopology(targets, view(0, 0), { faces: true });
    expect(face?.kind).toBe('face');
    expect(face?.kind === 'face' && Math.round(face.area)).toBe(1_000_000);
    expect(pickTopology(targets, view(0, 0))).toBeNull();
  });

  it('ignores edges hidden behind the surface under the pointer', () => {
    const { targets, view } = scene();
    // The back face's edges project onto the front face's edges in this view, but nothing in
    // the middle of the front face is a hidden edge.
    const hit = pickTopology(targets, view(0, 0), { edgePx: 400 });
    expect(hit?.kind === 'edge' && Math.max(hit.a[2], hit.b[2])).toBe(500);
  });
});

describe('reference actions', () => {
  it('grows a face over its coplanar triangles and traces its outline', () => {
    const { mesh } = scene();
    mesh.updateMatrixWorld();
    const face = coplanarFace(mesh, 8); // BoxGeometry faces: +x, -x, +y, -y, +z (triangles 8 and 9), -z
    expect(face.normal.map((n) => Math.round(n) + 0)).toEqual([0, 0, 1]);
    const loops = faceBoundaryLoops(face.triangles);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    const plane = planeOnFace({ kind: 'face', source: { kind: 'project' }, point: [0, 0, 500], ...face });
    expect(planeFrame(plane).normal.map((n) => Math.round(n) + 0)).toEqual([0, 0, 1]);
    let id = 0;
    const shapes = traceOntoPlane({ kind: 'plane', id: 'front', offset: 0 }, { kind: 'face', source: { kind: 'project' }, point: [0, 0, 500], ...face }, () => `s${id++}`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.kind === 'polyline' && shapes[0]!.points.map(([u, v]) => [Math.round(u), Math.round(v)]).sort()).toEqual([[-500, -500], [-500, 500], [500, -500], [500, 500]]);
  });

  it('moves the work plane through a point without turning it', () => {
    const plane = planeThroughPoint({ kind: 'plane', id: 'top', offset: 0 }, [10, 250, 30]);
    const frame = planeFrame(plane);
    expect(frame.normal).toEqual([0, 1, 0]);
    expect(frame.origin).toEqual([10, 250, 30]);
  });
});

describe('tracing edge-on parts', () => {
  it('leaves out a face that collapses on the work plane', () => {
    const { mesh } = scene();
    mesh.updateMatrixWorld();
    const face = coplanarFace(mesh, 8);
    expect(traceOntoPlane({ kind: 'plane', id: 'top', offset: 0 }, { kind: 'face', source: { kind: 'project' }, point: [0, 0, 500], ...face }, () => 'x')).toEqual([]);
  });
});
