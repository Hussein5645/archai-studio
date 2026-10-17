import * as THREE from 'three';

self.onmessage = (event: MessageEvent<{ id: number; positions: Float32Array; indices: Uint32Array | null; angles: number[] }>) => {
  const { id, positions, indices, angles } = event.data;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (indices) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  try {
    const results = angles.map((angle) => {
      const edges = new THREE.EdgesGeometry(geometry, angle);
      const positions = new Float32Array(edges.getAttribute('position').array);
      edges.dispose();
      return { angle, positions };
    });
    self.postMessage({ id, results }, { transfer: results.map((result) => result.positions.buffer) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally { geometry.dispose(); }
};
