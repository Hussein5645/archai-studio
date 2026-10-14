import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box3, Vector3 } from 'three';
import { convertD5Folder, convertD5FolderAsync, d5ActorMatrix, parseD5Mesh } from './d5';
import type { D5FolderResult } from './ipc';

function meshFixture(
  options: { version?: number; indices?: number[]; texture?: boolean; native?: boolean } = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  const uint = (number: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, number, true);
    parts.push(bytes);
  };
  const string = (value: string) => {
    uint(value.length);
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
    parts.push(bytes);
  };
  const numbers = (values: number[], integer = false, counted = true) => {
    if (counted) uint(values.length);
    const bytes = new Uint8Array(values.length * 4),
      view = new DataView(bytes.buffer);
    values.forEach((value, i) =>
      integer ? view.setUint32(i * 4, value, true) : view.setFloat32(i * 4, value, true),
    );
    parts.push(bytes);
  };
  uint(options.version ?? 11);
  string(JSON.stringify(options.native ? { materialVersion: 2 } : { upVector: 2 }));
  uint(options.native ? 0 : 1);
  if (!options.native) {
    string('white');
    string(
      `<Material><DiffuseColor>#FFFFFF</DiffuseColor>${options.texture ? '<DiffuseMap>um/white.png</DiffuseMap>' : ''}</Material>`,
    );
  }
  uint(1);
  string('triangle');
  string('white');
  numbers([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], false, false);
  uint(1);
  string('triangle');
  numbers([0, 0, 0, 100, 0, 0, 0, 0, 100]);
  numbers([0, -1, 0, 0, -1, 0, 0, -1, 0]);
  numbers([0, 0, 1, 0, 0, 1]);
  numbers([]);
  numbers(options.indices ?? [0, 1, 2], true);
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function folder(
  actors: Record<string, unknown>[] = [
    {
      uniqueActorId: 'first',
      resourceId: 'model',
      productData: { id: 'product', title: 'Test model' },
    },
  ],
): D5FolderResult {
  return {
    name: 'Test scene',
    files: [
      {
        name: 'asset/1.save',
        bytes: new TextEncoder().encode(
          JSON.stringify({ furnitureDatas: actors, landscape: { isLandscapeEnabled: true } }),
        ),
      },
      { name: 'resource/model.d5a', bytes: zipSync({ '1.d5mesh': meshFixture() }) },
    ],
  };
}
function gltf(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

describe('D5 folder conversion', () => {
  it('imports native meshes without an axis hint or embedded materials and reports placeholders', () => {
    const input = folder();
    input.files[1] = {
      name: 'resource/model.d5a',
      bytes: zipSync({ '1.d5mesh': meshFixture({ native: true }) }),
    };
    const result = convertD5Folder(input);
    expect(result.report.actors).toBe(1);
    expect(result.report.omitted.join(' ')).toContain('placeholder materials');
    expect(gltf(result.glb).materials[0].name).toBe('white');
  });
  it('loads referenced assets on demand once, reuses repeats, and reports progress', async () => {
    const input = folder([1, 2].map((i) => ({ uniqueActorId: String(i), resourceId: 'model' })));
    const requests: string[][] = [],
      progress: string[] = [];
    const result = await convertD5FolderAsync(
      { ...input, files: input.files.slice(0, 1) },
      async (names) => {
        requests.push(names);
        return input.files.filter((file) => names.includes(file.name)).slice(0, 1);
      },
      (value) => progress.push(value.message),
    );
    expect(result.report).toMatchObject({ actors: 2, triangles: 2 });
    expect(requests).toHaveLength(1);
    expect(progress).toContain('Reading object 2 of 2: Model');
    expect(progress.at(-1)).toBe('Assembling the imported scene');
  });
  it('stops after cancellation before loading another resource', async () => {
    const input = folder(),
      abort = new AbortController();
    let reads = 0;
    await expect(
      convertD5FolderAsync(
        input,
        async () => {
          reads++;
          return [];
        },
        () => abort.abort(),
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it('decodes the mesh and loads the exported GLB at metre scale', async () => {
    const result = convertD5Folder(folder());
    expect(result.report).toMatchObject({
      actors: 1,
      triangles: 1,
      textures: 0,
      omitted: ['D5 terrain is not transferred yet.'],
    });
    const loaded = await new GLTFLoader().parseAsync(result.glb.buffer as ArrayBuffer, '');
    const size = new Box3().setFromObject(loaded.scene).getSize(new Vector3());
    expect(size.x).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(1);
    expect(size.z).toBeCloseTo(0);
  });
  it('reuses geometry for repeated actors without sharing their node parents', () => {
    const result = convertD5Folder(
      folder(
        [1, 2].map((i) => ({
          uniqueActorId: String(i),
          resourceId: 'model',
          furnitureTransform: { translation: { x: i * 100 } },
        })),
      ),
    );
    const doc = gltf(result.glb);
    expect(result.report).toMatchObject({ actors: 2, triangles: 2 });
    expect(doc.meshes).toHaveLength(1);
    const actors = doc.nodes[0].children.map((id: number) => doc.nodes[id]);
    expect(actors[0].children).not.toEqual(actors[1].children);
    expect(actors.map((actor: { matrix: number[] }) => actor.matrix[12])).toEqual([100, 200]);
  });
  it('supports the local mesh path when the resource archive is absent', () => {
    const input = folder([{ productData: { id: 'product', title: 'Local model' } }]);
    input.files[1] = { name: 'asset/d5a/product/1.d5mesh', bytes: meshFixture() };
    expect(convertD5Folder(input).report.actors).toBe(1);
  });
  it('does not import hidden actors or silently drop missing resources', () => {
    const input = folder([
      { resourceId: 'model' },
      { resourceId: 'model', isHide: true },
      { resourceId: 'missing', productData: { title: 'Missing chair' } },
    ]);
    const result = convertD5Folder(input);
    expect(result.report.actors).toBe(1);
    expect(result.report.omitted).toContain('Missing chair: mesh resource is missing.');
  });
  it('embeds an explicitly referenced base colour texture', () => {
    const input = folder();
    input.files[1] = {
      name: 'resource/model.d5a',
      bytes: zipSync({ '1.d5mesh': meshFixture({ texture: true }) }),
    };
    input.files.push({ name: 'asset/um/white.png', bytes: Uint8Array.from([137, 80, 78, 71]) });
    const result = convertD5Folder(input);
    expect(result.report.textures).toBe(1);
    expect(gltf(result.glb).materials[0].pbrMetallicRoughness.baseColorTexture.index).toBe(0);
    expect(gltf(result.glb).images[0].mimeType).toBe('image/png');
  });
  it('rejects unsupported versions, corrupt indices and truncated input', () => {
    expect(() => parseD5Mesh(meshFixture({ version: 99 }))).toThrow('version');
    expect(() => parseD5Mesh(meshFixture({ indices: [0, 1, 9] }))).toThrow('geometry');
    expect(() => parseD5Mesh(meshFixture().slice(0, 20))).toThrow('Truncated');
  });
  it('applies quaternion rotation and non-uniform scale', () => {
    const matrix = d5ActorMatrix({
      rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
      scale3D: { x: 2, y: 3, z: 4 },
    });
    expect(matrix[0]).toBeCloseTo(0);
    expect(matrix[1]).toBeCloseTo(2);
    expect(matrix[4]).toBeCloseTo(-3);
    expect(matrix[10]).toBeCloseTo(4);
  });
});
