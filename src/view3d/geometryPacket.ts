import * as THREE from 'three';

export interface GeometryPacket {
  attributes: { name: string; size: number; values: Float32Array }[];
  index: Uint32Array | null;
  groups: { start: number; count: number; materialIndex?: number }[];
  userData: Record<string, unknown>;
}

/** Copy only binary geometry, never a document or Three.js object graph, across the worker boundary. */
export function packGeometry(geometry: THREE.BufferGeometry): GeometryPacket {
  return {
    attributes: Object.entries(geometry.attributes).map(([name, attribute]) => {
      const values = new Float32Array(attribute.count * attribute.itemSize);
      if (attribute instanceof THREE.BufferAttribute && !attribute.normalized) values.set(attribute.array);
      else for (let i = 0; i < attribute.count; i++) for (let c = 0; c < attribute.itemSize; c++) values[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      return { name, size: attribute.itemSize, values };
    }),
    index: geometry.index ? Uint32Array.from(geometry.index.array) : null,
    groups: geometry.groups.map((group) => ({ ...group })),
    userData: { ...geometry.userData },
  };
}

export function unpackGeometry(packet: GeometryPacket): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const attribute of packet.attributes) geometry.setAttribute(attribute.name, new THREE.BufferAttribute(attribute.values, attribute.size));
  if (packet.index) geometry.setIndex(new THREE.BufferAttribute(packet.index, 1));
  for (const group of packet.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.userData = packet.userData;
  return geometry;
}

export function geometryTransfers(packet: GeometryPacket): ArrayBuffer[] {
  return [...packet.attributes.map((attribute) => attribute.values.buffer as ArrayBuffer), ...(packet.index ? [packet.index.buffer as ArrayBuffer] : [])];
}
