/** Experimental, bounded decoder for the supplied D5 v11 mesh layout. No Python or D5 runtime. */
import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { D5FolderResult } from './ipc.js';

const MAX_BYTES = 256 * 1024 * 1024;
const vector = z.object({
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
  z: z.number().finite().default(0),
});
const transform = z.object({
  translation: vector.optional(),
  rotation: vector.extend({ w: z.number().finite().default(1) }).optional(),
  scale3D: z
    .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
    .optional(),
});
const actorSchema = z
  .object({
    uniqueActorId: z.string().default(''),
    groupActorId: z.string().default(''),
    isHide: z.boolean().default(false),
    productData: z
      .object({ id: z.string().default(''), title: z.string().default('Model') })
      .default({ id: '', title: 'Model' }),
    furnitureTransform: transform.default({}),
    furnitureModelPath: z.string().default(''),
    resourceId: z.string().default(''),
  })
  .passthrough();
const sceneSchema = z.object({ furnitureDatas: z.array(actorSchema).default([]) }).passthrough();
type ActorTransform = z.infer<typeof transform>;

export interface D5Report {
  name: string;
  actors: number;
  triangles: number;
  textures: number;
  omitted: string[];
  review: string[];
}
export interface D5ConvertedScene {
  glb: Uint8Array;
  report: D5Report;
}
interface Mesh {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}
interface Instance {
  name: string;
  material: string;
  matrix: number[];
}
interface Material {
  name: string;
  properties: Record<string, string>;
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function canonical(name: string): string {
  return name.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}
function xmlProperties(xml: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const match of xml.matchAll(/<([\w]+)>([^<>]*)<\/\1>/g)) {
    props[match[1]!] = match[2]!
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>');
  }
  return props;
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength)
      throw new Error('Truncated or invalid D5 mesh.');
  }
  uint(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  string(): string {
    const length = this.uint() * 2;
    this.require(length);
    const text = new TextDecoder('utf-16le', { fatal: true }).decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return text;
  }
  numbers(count: number, integer = false): number[] {
    this.require(count * 4);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++, this.offset += 4) {
      const value = integer
        ? this.view.getUint32(this.offset, true)
        : this.view.getFloat32(this.offset, true);
      if (!Number.isFinite(value)) throw new Error('D5 mesh contains a non-finite coordinate.');
      values[i] = value;
    }
    return values;
  }
  count(): number {
    const value = this.uint();
    if (value > 100_000) throw new Error('D5 mesh contains too many records.');
    return value;
  }
}

export function parseD5Mesh(bytes: Uint8Array): {
  materials: Material[];
  instances: Instance[];
  meshes: Mesh[];
  header: Record<string, unknown>;
} {
  if (bytes.byteLength > MAX_BYTES) throw new Error('D5 mesh exceeds 256 MB.');
  const reader = new Reader(bytes);
  if (reader.uint() !== 11)
    throw new Error('This D5 mesh version is not supported yet (supported: version 11).');
  const header = record(JSON.parse(reader.string()));
  if (header['upVector'] !== 2) throw new Error('This D5 mesh axis format is not supported yet.');
  const materials: Material[] = [];
  for (let i = 0, count = reader.count(); i < count; i++)
    materials.push({ name: reader.string(), properties: xmlProperties(reader.string()) });
  const instances: Instance[] = [];
  for (let i = 0, count = reader.count(); i < count; i++)
    instances.push({
      name: reader.string(),
      material: reader.string(),
      matrix: reader.numbers(16),
    });
  const meshes: Mesh[] = [];
  for (let i = 0, count = reader.count(); i < count; i++) {
    const name = reader.string();
    const positions = reader.numbers(reader.uint());
    const normals = reader.numbers(reader.uint());
    const uvs = reader.numbers(reader.uint());
    const colors = reader.numbers(reader.uint());
    const indices = reader.numbers(reader.uint(), true);
    if (
      !positions.length ||
      positions.length % 3 ||
      !indices.length ||
      indices.length % 3 ||
      indices.some((index) => index >= positions.length / 3) ||
      (normals.length && normals.length !== positions.length) ||
      (uvs.length && uvs.length !== (positions.length / 3) * 2)
    ) {
      throw new Error(`Invalid mesh geometry: ${name}`);
    }
    if (meshes.some((mesh) => mesh.name === name))
      throw new Error(`Duplicate D5 mesh name: ${name}`);
    meshes.push({ name, positions, normals, uvs, colors, indices });
  }
  return { materials, instances, meshes, header };
}

export function d5ActorMatrix(input: ActorTransform): number[] {
  const q = input.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!length) throw new Error('D5 actor has a zero-length rotation.');
  const [x, y, z, w] = [q.x / length, q.y / length, q.z / length, q.w / length];
  const s = input.scale3D ?? { x: 1, y: 1, z: 1 };
  const t = input.translation ?? { x: 0, y: 0, z: 0 };
  return [
    (1 - 2 * (y! * y! + z! * z!)) * s.x,
    2 * (x! * y! + z! * w!) * s.x,
    2 * (x! * z! - y! * w!) * s.x,
    0,
    2 * (x! * y! - z! * w!) * s.y,
    (1 - 2 * (x! * x! + z! * z!)) * s.y,
    2 * (y! * z! + x! * w!) * s.y,
    0,
    2 * (x! * z! + y! * w!) * s.z,
    2 * (y! * z! - x! * w!) * s.z,
    (1 - 2 * (x! * x! + y! * y!)) * s.z,
    0,
    t.x,
    t.y,
    t.z,
    1,
  ];
}

type Node = {
  name: string;
  matrix?: number[];
  children?: number[];
  mesh?: number;
  extras?: Record<string, string>;
};
class GlbWriter {
  readonly nodes: Node[] = [
    {
      name: 'D5 scene',
      children: [],
      matrix: [0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, 0, 0, 1],
    },
  ];
  readonly meshes: { name: string; primitives: Record<string, unknown>[] }[] = [];
  readonly materials: Record<string, unknown>[] = [];
  private readonly views: Record<string, number>[] = [];
  private readonly accessors: Record<string, unknown>[] = [];
  private readonly images: { bufferView: number; mimeType: string }[] = [];
  private readonly textures: { source: number }[] = [];
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  view(bytes: Uint8Array, target?: number): number {
    const padding = -this.byteLength & 3;
    if (padding) {
      this.chunks.push(new Uint8Array(padding));
      this.byteLength += padding;
    }
    this.views.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
    if (this.byteLength > MAX_BYTES) throw new Error('Converted D5 scene exceeds 256 MB.');
    return this.views.length - 1;
  }
  accessor(values: number[], width: number, type: string, index = false, bounds = false): number {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) =>
      index ? view.setUint32(i * 4, value, true) : view.setFloat32(i * 4, value, true),
    );
    const info: Record<string, unknown> = {
      bufferView: this.view(bytes, index ? 34963 : 34962),
      componentType: index ? 5125 : 5126,
      count: values.length / width,
      type,
    };
    if (bounds) {
      const min = Array<number>(width).fill(Infinity),
        max = Array<number>(width).fill(-Infinity);
      values.forEach((v, i) => {
        min[i % width] = Math.min(min[i % width]!, v);
        max[i % width] = Math.max(max[i % width]!, v);
      });
      info['min'] = min;
      info['max'] = max;
    }
    this.accessors.push(info);
    return this.accessors.length - 1;
  }
  texture(bytes: Uint8Array, mimeType: string): number {
    this.images.push({ bufferView: this.view(bytes), mimeType });
    this.textures.push({ source: this.images.length - 1 });
    return this.textures.length - 1;
  }
  write(): Uint8Array {
    const doc = {
      asset: { version: '2.0', generator: 'ArchAI D5 importer' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      bufferViews: this.views,
      accessors: this.accessors,
      buffers: [{ byteLength: this.byteLength }],
      ...(this.images.length ? { images: this.images, textures: this.textures } : {}),
    };
    const encoded = new TextEncoder().encode(JSON.stringify(doc));
    const jsonLength = encoded.length + (-encoded.length & 3),
      binaryLength = this.byteLength + (-this.byteLength & 3);
    const result = new Uint8Array(28 + jsonLength + binaryLength);
    const view = new DataView(result.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, result.length, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    result.fill(32, 20, 20 + jsonLength);
    result.set(encoded, 20);
    view.setUint32(20 + jsonLength, binaryLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    let offset = 28 + jsonLength;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function colour(hex: string): number[] {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Invalid D5 material colour: ${hex}`);
  return [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
}
function factor(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid D5 material property.');
  return Math.max(0, Math.min(1, number));
}

export function convertD5Folder(folder: D5FolderResult): D5ConvertedScene {
  if (folder.files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_BYTES)
    throw new Error('D5 folder exceeds 256 MB.');
  const files = new Map(folder.files.map((file) => [canonical(file.name), file.bytes]));
  const save = files.get('asset/1.save');
  if (!save) throw new Error('Choose the D5 project folder containing asset/1.save.');
  const scene = sceneSchema.parse(json(save));
  const writer = new GlbWriter();
  const report: D5Report = {
    name: folder.name,
    actors: 0,
    triangles: 0,
    textures: 0,
    omitted: [],
    review: [
      'ArchAI recalculates lighting when baking. D5 lighting, environment, effects and saved cameras are not transferred.',
      'Check scale, orientation and materials against D5 before publishing. This importer is experimental.',
    ],
  };
  const cache = new Map<string, { children: Node[]; triangles: number }>();
  for (const actor of scene.furnitureDatas) {
    if (actor.isHide) continue;
    const sourceNames = [
      `resource/${actor.resourceId}.d5a`,
      `asset/${actor.furnitureModelPath}/1.d5mesh`,
      `asset/d5a/${actor.productData.id}/1.d5mesh`,
    ].map(canonical);
    const source = sourceNames.find((name) => files.has(name));
    if (!source) {
      report.omitted.push(`${actor.productData.title}: mesh resource is missing.`);
      continue;
    }
    if (actor.groupActorId) {
      report.omitted.push(`${actor.productData.title}: grouped placement is not supported yet.`);
      continue;
    }
    if (!cache.has(source)) {
      const resource = files.get(source)!;
      let expandedBytes = 0;
      const archive = source.endsWith('.d5a')
        ? unzipSync(resource, {
            filter: (entry) => {
              if (entry.originalSize > MAX_BYTES)
                throw new Error('D5 archive entry exceeds 256 MB.');
              const include = entry.name === '1.d5mesh' || /\.(png|jpe?g)$/i.test(entry.name);
              if (include) expandedBytes += entry.originalSize;
              if (expandedBytes > MAX_BYTES) throw new Error('Expanded D5 archive exceeds 256 MB.');
              return include;
            },
          })
        : {};
      if (Object.values(archive).reduce((sum, value) => sum + value.length, 0) > MAX_BYTES)
        throw new Error('Expanded D5 archive exceeds 256 MB.');
      const meshBytes = source.endsWith('.d5a') ? archive['1.d5mesh'] : resource;
      if (!meshBytes) throw new Error(`${actor.productData.title}: archive contains no 1.d5mesh.`);
      const asset = parseD5Mesh(meshBytes);
      const materialIds = new Map<string, number>();
      for (const material of asset.materials) {
        const p = material.properties;
        const alpha = factor(p['Opacity'], 1);
        const pbr: Record<string, unknown> = {
          baseColorFactor: [...colour(p['DiffuseColor'] ?? '#CCCCCC'), alpha],
          roughnessFactor: factor(p['Roughness'], 0.5),
          metallicFactor: factor(p['Metallic'], 0),
        };
        // Only explicit base-colour image fields are interpreted; no guesses by file basename.
        const texturePath =
          p['DiffuseMap'] || p['DiffuseTexture'] || p['TextureFilename'] || p['ImageFile'];
        if (texturePath) {
          const key = canonical(texturePath);
          const image = files.get(key) ?? files.get(`asset/${key}`) ?? archive[texturePath];
          const mime = /\.png$/i.test(key)
            ? 'image/png'
            : /\.jpe?g$/i.test(key)
              ? 'image/jpeg'
              : null;
          if (image && mime) {
            pbr['baseColorTexture'] = { index: writer.texture(image, mime) };
            report.textures++;
          } else
            report.omitted.push(`${material.name}: base colour texture is missing or unsupported.`);
        }
        for (const [key, value] of Object.entries(p)) {
          if (
            value &&
            /map|image|texture/i.test(key) &&
            ![
              'ImageFade',
              'TextureWidth',
              'TextureHeight',
              'DiffuseMap',
              'DiffuseTexture',
              'TextureFilename',
              'ImageFile',
            ].includes(key)
          )
            report.omitted.push(`${material.name}: ${key} requires material review.`);
        }
        if (Number(p['EmissiveStrength'] ?? 0) !== 0)
          report.omitted.push(`${material.name}: emission requires material review.`);
        materialIds.set(material.name, writer.materials.length);
        writer.materials.push({
          name: material.name,
          doubleSided: true,
          pbrMetallicRoughness: pbr,
          ...(alpha < 1 ? { alphaMode: 'BLEND' } : {}),
        });
      }
      const meshIds = new Map<string, { attributes: Record<string, number>; indices: number }>();
      for (const mesh of asset.meshes) {
        const attributes: Record<string, number> = {
          POSITION: writer.accessor(mesh.positions, 3, 'VEC3', false, true),
        };
        if (mesh.normals.length) attributes['NORMAL'] = writer.accessor(mesh.normals, 3, 'VEC3');
        if (mesh.uvs.length) attributes['TEXCOORD_0'] = writer.accessor(mesh.uvs, 2, 'VEC2');
        if (mesh.colors.length && asset.header['LoadVertexColors'])
          report.omitted.push(`${mesh.name}: source vertex colours require conversion.`);
        meshIds.set(mesh.name, {
          attributes,
          indices: writer.accessor(mesh.indices, 1, 'SCALAR', true),
        });
      }
      const children: Node[] = [];
      let triangles = 0;
      const used = new Set<string>();
      for (const instance of asset.instances) {
        const primitive = meshIds.get(instance.name),
          material = materialIds.get(instance.material);
        if (!primitive || material === undefined)
          throw new Error(`Unresolved D5 mesh or material: ${instance.name}`);
        if (
          instance.matrix[3] !== 0 ||
          instance.matrix[7] !== 0 ||
          instance.matrix[11] !== 0 ||
          instance.matrix[15] !== 1
        )
          throw new Error('Unsupported D5 instance matrix.');
        writer.meshes.push({ name: instance.name, primitives: [{ ...primitive, material }] });
        children.push({
          name: instance.name,
          mesh: writer.meshes.length - 1,
          matrix: instance.matrix,
        });
        triangles += asset.meshes.find((mesh) => mesh.name === instance.name)!.indices.length / 3;
        used.add(instance.name);
      }
      if (used.size !== asset.meshes.length)
        throw new Error('D5 mesh has missing instances; import stopped to avoid losing geometry.');
      cache.set(source, { children, triangles });
    }
    const asset = cache.get(source)!;
    const children = asset.children.map((child) => {
      writer.nodes.push({ ...child });
      return writer.nodes.length - 1;
    });
    writer.nodes.push({
      name: actor.productData.title,
      matrix: d5ActorMatrix(actor.furnitureTransform),
      children,
      extras: { d5ActorId: actor.uniqueActorId },
    });
    writer.nodes[0]!.children!.push(writer.nodes.length - 1);
    report.actors++;
    report.triangles += asset.triangles;
    const overrides = record(actor['userData'])['d5mList'];
    if (Array.isArray(overrides) && overrides.length)
      report.omitted.push(
        `${actor.productData.title}: scene material overrides require conversion.`,
      );
    for (const key of ['hISMInfo', 'hISMInfo_V2', 'brushInfo'])
      if (Array.isArray(actor[key]) && actor[key].length)
        report.omitted.push(`${actor.productData.title}: scattered copies are not transferred.`);
  }
  for (const key of [
    'meshSyncActorDatas',
    'scatterActorDatas',
    'pureLightDatas',
    'pureDecalActorDatas',
    'gaussianPointCloudDatas',
    'cityActorDatas',
    'cityTemplateActorDatas',
    'landscapeTemplateActorDatas',
    'bPFurnitureActorData',
    'pureNiagaraActorData',
    'skpStyleDatas',
    'wallStyleDatas',
    'pathSplineActorDatas',
  ]) {
    const entries = scene[key];
    if (Array.isArray(entries) && entries.length)
      report.omitted.push(`${key}: ${entries.length} unsupported scene entries.`);
  }
  const terrain = record(scene['landscape']);
  if (terrain['isLandscapeEnabled'] && !terrain['isHide'])
    report.omitted.push('D5 terrain is not transferred yet.');
  report.omitted = [...new Set(report.omitted)];
  if (!report.actors)
    throw new Error(`No supported visible mesh actors were found. ${report.omitted.join(' ')}`);
  return { glb: writer.write(), report };
}
