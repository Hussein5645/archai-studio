import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

export interface SimplifyInput {
  positions: Float32Array;
  indices: Uint32Array;
  attributes: { name: string; size: number; values: Float32Array }[];
  groups: { start: number; count: number; materialIndex?: number }[];
  ratio: number;
  error: number;
  protectUv?: boolean;
}

/** Attribute-aware edge collapse; protects texture seams and material boundaries. */
export async function simplifyMesh(input: SimplifyInput): Promise<SimplifyInput> {
  await MeshoptSimplifier.ready;
  let count = input.positions.length / 3;
  // Exact welding handles non-indexed CAD exports without erasing UV/normal seams.
  const buffers = [input.positions, ...input.attributes.map((a) => a.values)];
  const sizes = [3, ...input.attributes.map((a) => a.size)];
  const bits = buffers.map((a) => new Uint32Array(a.buffer, a.byteOffset, a.length));
  const representatives = new Uint32Array(count);
  const next = new Int32Array(count).fill(-1);
  const heads = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    let hash = 2166136261;
    for (let b = 0; b < bits.length; b++)
      for (let c = 0; c < sizes[b]!; c++)
        hash = Math.imul(hash ^ bits[b]![i * sizes[b]! + c]!, 16777619);
    let match = heads.get(hash) ?? -1;
    while (match >= 0) {
      let equal = true;
      for (let b = 0; b < bits.length && equal; b++)
        for (let c = 0; c < sizes[b]!; c++)
          if (bits[b]![i * sizes[b]! + c] !== bits[b]![match * sizes[b]! + c]) {
            equal = false;
            break;
          }
      if (equal) break;
      match = next[match]!;
    }
    representatives[i] = match >= 0 ? match : i;
    if (match < 0) {
      next[i] = heads.get(hash) ?? -1;
      heads.set(hash, i);
    }
  }
  for (let i = 0; i < input.indices.length; i++)
    input.indices[i] = representatives[input.indices[i]!]!;
  const [weldRemap, weldedCount] = MeshoptSimplifier.compactMesh(input.indices);
  const weld = (values: Float32Array, size: number) => {
    const result = new Float32Array(weldedCount * size);
    for (let i = 0; i < weldRemap.length; i++) {
      if (weldRemap[i] === 0xffffffff) continue;
      result.set(values.subarray(i * size, (i + 1) * size), weldRemap[i]! * size);
    }
    return result;
  };
  input = {
    ...input,
    positions: weld(input.positions, 3),
    attributes: input.attributes.map((a) => ({ ...a, values: weld(a.values, a.size) })),
  };
  count = weldedCount;
  const positionRemap = MeshoptSimplifier.generatePositionRemap(input.positions, 3);
  const locks = new Uint8Array(count);
  const seamAttributes = input.attributes.filter(
    (a) => a.name === 'color' || (a.name === 'uv' && input.protectUv !== false),
  );
  for (let i = 0; i < count; i++) {
    const other = positionRemap[i]!;
    for (const attribute of seamAttributes)
      for (let c = 0; c < attribute.size; c++)
        if (
          attribute.values[i * attribute.size + c] !== attribute.values[other * attribute.size + c]
        )
          locks[i] = locks[other] = 2;
  }
  // Propagate seam protection to every coincident copy, including normal-only copies.
  for (let i = 0; i < count; i++) if (locks[positionRemap[i]!] === 2) locks[i] = 2;
  const owner = new Int32Array(count).fill(-1);
  input.groups.forEach((group, groupId) => {
    for (let i = group.start; i < group.start + group.count; i++) {
      const vertex = positionRemap[input.indices[i]!]!;
      if (owner[vertex] === -1) owner[vertex] = groupId;
      else if (owner[vertex] !== groupId) locks[vertex] = 1;
    }
  });
  for (let i = 0; i < count; i++) if (locks[positionRemap[i]!] === 1) locks[i] = 1;
  const weighted = input.attributes.filter(
    (a) => ['normal', 'color'].includes(a.name) || (a.name === 'uv' && input.protectUv !== false),
  );
  const stride = weighted.reduce((n, a) => n + a.size, 0);
  const attributes = new Float32Array(count * stride);
  const weights = weighted.flatMap((a) => Array<number>(a.size).fill(a.name === 'uv' ? 10 : 1));
  for (let i = 0; i < count; i++) {
    let offset = i * stride;
    for (const attribute of weighted) {
      attributes.set(
        attribute.values.subarray(i * attribute.size, (i + 1) * attribute.size),
        offset,
      );
      offset += attribute.size;
    }
  }
  const chunks: Uint32Array[] = [];
  const groups: SimplifyInput['groups'] = [];
  let length = 0;
  for (const group of input.groups) {
    const indices = input.indices.slice(group.start, group.start + group.count);
    const target = Math.max(3, Math.floor((indices.length * input.ratio) / 3) * 3);
    const [reduced] = stride
      ? MeshoptSimplifier.simplifyWithAttributes(
          indices,
          input.positions,
          3,
          attributes,
          stride,
          weights,
          locks,
          target,
          input.error,
          ['ErrorAbsolute', 'Permissive', 'Prune'],
        )
      : MeshoptSimplifier.simplify(indices, input.positions, 3, target, input.error, [
          'ErrorAbsolute',
          'Prune',
        ]);
    groups.push({ ...group, start: length, count: reduced.length });
    chunks.push(reduced);
    length += reduced.length;
  }
  const indices = new Uint32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    indices.set(chunk, offset);
    offset += chunk.length;
  }
  const [remap, vertices] = MeshoptSimplifier.compactMesh(indices);
  const compact = (values: Float32Array, size: number) => {
    const result = new Float32Array(vertices * size);
    for (let i = 0; i < remap.length; i++) {
      if (remap[i] === 0xffffffff) continue;
      result.set(values.subarray(i * size, (i + 1) * size), remap[i]! * size);
    }
    return result;
  };
  return {
    ...input,
    indices,
    groups,
    positions: compact(input.positions, 3),
    attributes: input.attributes.map((a) => ({ ...a, values: compact(a.values, a.size) })),
  };
}
