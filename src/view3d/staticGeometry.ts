import {
  Float32BufferAttribute,
  InterleavedBufferAttribute,
  type BufferGeometry,
  type Matrix4,
} from 'three';

/** Flatten transforms without turning mirrored architecture inside out. */
export function applyStaticTransform(geometry: BufferGeometry, matrix: Matrix4): void {
  // Decode quantized/interleaved glTF attributes before world-space transforms.
  // Writing metre coordinates back into normalized integer storage would overflow.
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (
      !(attribute instanceof InterleavedBufferAttribute) &&
      attribute.array instanceof Float32Array
    )
      continue;
    const values = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++)
        values[i * attribute.itemSize + c] = attribute.getComponent(i, c);
    }
    geometry.setAttribute(name, new Float32BufferAttribute(values, attribute.itemSize));
  }
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() >= 0) return;
  const index = geometry.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const second = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, second);
    }
  } else {
    for (const attribute of Object.values(geometry.attributes)) {
      for (let i = 0; i + 2 < attribute.count; i += 3) {
        for (let component = 0; component < attribute.itemSize; component++) {
          const second = attribute.getComponent(i + 1, component);
          attribute.setComponent(i + 1, component, attribute.getComponent(i + 2, component));
          attribute.setComponent(i + 2, component, second);
        }
      }
    }
  }
}
