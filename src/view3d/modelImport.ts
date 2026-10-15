/**
 * 3D model import (docs/model-import.md): any common 3D file → one binary glTF in millimetres,
 * Y up, sitting on the ground with its plan corner at the origin, ready to become a mesh element
 * (see ./meshes.ts). Loading uses three.js' loaders; files picked together are served to each
 * other by name (an OBJ's .mtl and textures, a glTF's .bin), so multi-file models work.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const MODEL_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;
export type ModelUnit = (typeof MODEL_UNITS)[number];
export type UpAxis = 'y' | 'z';

export const UNIT_MM: Record<ModelUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

interface Format {
  label: string;
  /** Units the format defines (null: unitless, guessed from the size). */
  unit: ModelUnit | null;
  up: UpAxis;
  load: (file: SourceFile, manager: THREE.LoadingManager) => Promise<THREE.Object3D>;
}

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}

const buffer = (file: SourceFile): ArrayBuffer => file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
const text = (file: SourceFile) => new TextDecoder().decode(file.bytes);
const asGroup = (object: THREE.Object3D | THREE.BufferGeometry, material?: THREE.Material): THREE.Object3D => {
  if (object instanceof THREE.BufferGeometry) {
    if (!object.getAttribute('normal')) object.computeVertexNormals();
    return new THREE.Mesh(object, material ?? new THREE.MeshStandardMaterial({ color: 0xc9ccd3, roughness: 0.8, vertexColors: Boolean(object.getAttribute('color')) }));
  }
  return object;
};

/** Every importable format by extension (lower case, no dot). */
export const MODEL_FORMATS: Record<string, Format> = {
  glb: { label: 'glTF binary', unit: 'm', up: 'y', load: async (file, manager) => (await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer(file), '')).scene },
  gltf: { label: 'glTF', unit: 'm', up: 'y', load: async (file, manager) => (await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(text(file), '')).scene },
  fbx: { label: 'FBX', unit: null, up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/FBXLoader.js')).FBXLoader(manager).parse(buffer(file), '') },
  obj: {
    label: 'OBJ',
    unit: null,
    up: 'y',
    load: async (file, manager) => {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader(manager);
      const source = text(file);
      // Materials from the .mtl it names, when that file was picked too.
      const library = source.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      if (library && manager.resolveURL(library) !== library) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const materials = await new MTLLoader(manager).loadAsync(library).catch(() => null);
        if (materials) {
          materials.preload();
          loader.setMaterials(materials);
        }
      }
      return loader.parse(source);
    },
  },
  stl: { label: 'STL', unit: 'mm', up: 'z', load: async (file) => asGroup(new (await import('three/examples/jsm/loaders/STLLoader.js')).STLLoader().parse(buffer(file))) },
  ply: { label: 'PLY', unit: null, up: 'z', load: async (file) => asGroup(new (await import('three/examples/jsm/loaders/PLYLoader.js')).PLYLoader().parse(buffer(file))) },
  dae: { label: 'Collada', unit: null, up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/ColladaLoader.js')).ColladaLoader(manager).parse(text(file), '')?.scene ?? new THREE.Group() },
  '3mf': { label: '3MF', unit: 'mm', up: 'z', load: async (file, manager) => new (await import('three/examples/jsm/loaders/3MFLoader.js')).ThreeMFLoader(manager).parse(buffer(file)) },
  '3ds': { label: '3DS', unit: null, up: 'z', load: async (file, manager) => new (await import('three/examples/jsm/loaders/TDSLoader.js')).TDSLoader(manager).parse(buffer(file), '') },
  amf: { label: 'AMF', unit: 'mm', up: 'z', load: async (file, manager) => new (await import('three/examples/jsm/loaders/AMFLoader.js')).AMFLoader(manager).parse(buffer(file)) },
  wrl: { label: 'VRML', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/VRMLLoader.js')).VRMLLoader(manager).parse(text(file), '') },
  vrml: { label: 'VRML', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/VRMLLoader.js')).VRMLLoader(manager).parse(text(file), '') },
  usdz: { label: 'USDZ', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/USDLoader.js')).USDLoader(manager).parse(buffer(file)) },
  usd: { label: 'USD', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/USDLoader.js')).USDLoader(manager).parse(buffer(file)) },
  usda: { label: 'USD', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/USDLoader.js')).USDLoader(manager).parse(buffer(file)) },
  usdc: { label: 'USD', unit: 'm', up: 'y', load: async (file, manager) => new (await import('three/examples/jsm/loaders/USDLoader.js')).USDLoader(manager).parse(buffer(file)) },
  lwo: {
    label: 'LightWave',
    unit: 'm',
    up: 'y',
    load: async (file, manager) => {
      const { LWOLoader } = await import('three/examples/jsm/loaders/LWOLoader.js');
      const group = new THREE.Group();
      for (const mesh of new LWOLoader(manager).parse(buffer(file), '', file.name).meshes) group.add(mesh);
      return group;
    },
  },
  vtk: { label: 'VTK', unit: null, up: 'z', load: async (file) => asGroup(new (await import('three/examples/jsm/loaders/VTKLoader.js')).VTKLoader().parse(buffer(file), '')) },
  vtp: { label: 'VTK', unit: null, up: 'z', load: async (file) => asGroup(new (await import('three/examples/jsm/loaders/VTKLoader.js')).VTKLoader().parse(buffer(file), '')) },
  kmz: { label: 'KMZ', unit: 'm', up: 'y', load: async (file) => (await new (await import('three/examples/jsm/loaders/KMZLoader.js')).KMZLoader().parse(buffer(file))).scene },

};

export const MODEL_EXTENSIONS = Object.keys(MODEL_FORMATS);
const COMPANION_EXTENSIONS = ['bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'];
export const MODEL_ACCEPT = [...MODEL_EXTENSIONS, ...COMPANION_EXTENSIONS].map((extension) => `.${extension}`).join(',');

/** File-type list for a native open dialog: all models, each format on its own, companions, all files. */
export function modelFileFilters(): { name: string; extensions: string[] }[] {
  const byLabel = new Map<string, string[]>();
  for (const [extension, format] of Object.entries(MODEL_FORMATS)) byLabel.set(format.label, [...(byLabel.get(format.label) ?? []), extension]);
  return [
    { name: 'All 3D models', extensions: [...MODEL_EXTENSIONS, ...COMPANION_EXTENSIONS] },
    ...[...byLabel].map(([name, extensions]) => ({ name, extensions })),
    { name: 'Materials, buffers and textures', extensions: COMPANION_EXTENSIONS },
    { name: 'All files', extensions: ['*'] },
  ];
}

export function extensionOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

/** The file to load among those picked together (the rest are its companions). */
export function primaryModelFile(files: readonly SourceFile[]): SourceFile | null {
  return files.find((file) => MODEL_FORMATS[extensionOf(file.name)]) ?? null;
}

/** Guesses the units of a unitless model from its size (in file units). */
export function guessUnit(largest: number): ModelUnit {
  if (largest <= 30) return 'm';
  if (largest <= 600) return 'cm';
  return 'mm';
}

export interface ConvertedModel {
  glb: Uint8Array;
  /** Plan size (x, y) and height, mm. */
  size: [number, number, number];
  unit: ModelUnit;
  up: UpAxis;
  format: string;
  triangles: number;
}

/** Loads the picked files and converts the model; `unit` / `up` override the detected ones. */
export async function convertModel(files: readonly SourceFile[], options: { unit?: ModelUnit | 'auto'; up?: UpAxis | 'auto' } = {}): Promise<ConvertedModel> {
  const primary = primaryModelFile(files);
  if (!primary) throw new Error(`No supported 3D file (${MODEL_EXTENSIONS.join(', ')})`);
  const format = MODEL_FORMATS[extensionOf(primary.name)]!;
  // Companion files are served by name, whatever folder the model refers to them in.
  const urls = new Map<string, string>();
  for (const file of files) {
    if (file === primary) continue;
    urls.set(file.name.toLowerCase(), URL.createObjectURL(new Blob([file.bytes as BlobPart])));
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? url).toLowerCase();
    return urls.get(name) ?? url;
  });
  try {
    // A loader that never settles (a missing companion file, a blocked worker) must not hang the import.
    let timer = 0;
    const loaded = await Promise.race([
      format.load(primary, manager),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${format.label} file did not finish loading`)), 120_000);
      }),
    ]).finally(() => window.clearTimeout(timer));
    return await bake(loaded, format.label, options.unit && options.unit !== 'auto' ? options.unit : format.unit, options.up && options.up !== 'auto' ? options.up : format.up);
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
}

/** Re-bakes an imported GLB in other units / with another up axis (relative to how it was baked). */
export async function rebakeModel(glb: Uint8Array, from: { unit: ModelUnit; up: UpAxis }, to: { unit: ModelUnit; up: UpAxis }): Promise<ConvertedModel> {
  const scene = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '')).scene;
  // Back to the source frame: undo the old scale and up axis, then bake with the new ones.
  const undo = new THREE.Group();
  undo.add(scene);
  undo.scale.setScalar(1 / UNIT_MM[from.unit]);
  if (from.up === 'z') undo.rotation.x = Math.PI / 2;
  return bake(undo, 'glTF', to.unit, to.up);
}

async function bake(loaded: THREE.Object3D, label: string, unit: ModelUnit | null, up: UpAxis): Promise<ConvertedModel> {
  // Surfaces only: no lights, cameras, helper lines or point clouds.
  const strip: THREE.Object3D[] = [];
  loaded.traverse((child) => {
    if ((child as THREE.Light).isLight || (child as THREE.Camera).isCamera || child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Sprite) strip.push(child);
  });
  for (const child of strip) child.parent?.remove(child);
  const root = new THREE.Group();
  const frame = new THREE.Group();
  frame.add(loaded);
  if (up === 'z') frame.rotation.x = -Math.PI / 2;
  root.add(frame);
  root.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(root);
  if (raw.isEmpty()) throw new Error('The file has no surfaces to import');
  const rawSize = raw.getSize(new THREE.Vector3());
  const resolvedUnit = unit ?? guessUnit(Math.max(rawSize.x, rawSize.y, rawSize.z));
  frame.scale.setScalar(UNIT_MM[resolvedUnit]);
  root.updateMatrixWorld(true);
  // On the ground, plan corner at the origin.
  const box = new THREE.Box3().setFromObject(root);
  frame.position.sub(box.min);
  root.updateMatrixWorld(true);
  let triangles = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  const exported = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  if (!(exported instanceof ArrayBuffer)) throw new Error('The model could not be converted');
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return { glb: new Uint8Array(exported), size: [Math.round(size.x), Math.round(size.z), Math.round(size.y)], unit: resolvedUnit, up, format: label, triangles: Math.round(triangles) };
}
