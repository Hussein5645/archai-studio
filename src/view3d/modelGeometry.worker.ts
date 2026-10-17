import * as THREE from 'three';
import { geometryTransfers, packGeometry, unpackGeometry, type GeometryPacket } from './geometryPacket';
import { repairNormals, type NormalMode } from './meshNormals';

export type GeometryTask =
  | { kind: 'extrude'; key: string; points: { x: number; y: number }[]; holes: { x: number; y: number }[][]; depth: number }
  | { kind: 'normals'; key: string; geometry: GeometryPacket; mode: NormalMode };

self.onmessage = (event: MessageEvent<GeometryTask[]>) => {
  try {
    const results = event.data.map((task) => {
      let geometry: THREE.BufferGeometry;
      if (task.kind === 'extrude') {
        const shape = new THREE.Shape(task.points.map((point) => new THREE.Vector2(point.x, point.y)));
        for (const hole of task.holes) if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map((point) => new THREE.Vector2(point.x, point.y))));
        geometry = new THREE.ExtrudeGeometry(shape, { depth: task.depth, bevelEnabled: false });
        geometry.rotateX(Math.PI / 2);
      } else {
        const source = unpackGeometry(task.geometry);
        geometry = repairNormals(source, task.mode);
        source.dispose();
      }
      const packet = packGeometry(geometry);
      geometry.dispose();
      return { key: task.key, geometry: packet };
    });
    self.postMessage({ results }, { transfer: results.flatMap((result) => geometryTransfers(result.geometry)) });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
