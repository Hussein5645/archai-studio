/**
 * Material records → three.js materials. Geometry carries UVs in world millimetres (see
 * src/view3d/surfaceUv.ts), so every map is scaled by the material's tile size here: a 215 mm
 * brick is 215 mm on any wall. Procedural patterns are rendered once per (pattern, colour) and
 * shared; image maps decode asynchronously and announce themselves through `onMaterialTextures`
 * so live views redraw when they arrive.
 */
import * as THREE from 'three';
import type { ArchaiDocument, Material, TextureRef } from '@/document';
import { dataUrl } from '@/persistence/base64';
import { patternKey, renderPattern, type PatternImage } from './patterns';

const listeners = new Set<() => void>();

/** Called whenever an image texture finished decoding. Returns the unsubscribe. */
export function onMaterialTextures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const hasCanvas = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

interface PatternTextures {
  image: PatternImage;
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
}

const patternCache = new Map<string, PatternTextures | null>();

function canvasTexture(width: number, height: number, pixels: Uint8ClampedArray, colour: boolean): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  if (colour) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function patternTextures(ref: Extract<TextureRef, { pattern: unknown }>, baseColor: string): PatternTextures | null {
  const key = patternKey(ref.pattern, baseColor);
  if (patternCache.has(key)) return patternCache.get(key)!;
  if (!hasCanvas()) {
    patternCache.set(key, null);
    return null;
  }
  const image = renderPattern(ref.pattern, baseColor);
  const textures: PatternTextures = {
    image,
    albedo: canvasTexture(image.width, image.height, image.albedo, true),
    normal: canvasTexture(image.width, image.height, image.normal, false),
    roughness: canvasTexture(image.width, image.height, image.roughness, false),
  };
  patternCache.set(key, textures);
  return textures;
}

const blobCache = new Map<string, THREE.Texture>();

function blobTexture(doc: Pick<ArchaiDocument, 'blobs'>, blobId: string): THREE.Texture | null {
  const cached = blobCache.get(blobId);
  if (cached) return cached;
  const blob = doc.blobs[blobId];
  if (!blob || !hasCanvas()) return null;
  const texture = new THREE.Texture();
  const image = new Image();
  image.onload = () => {
    texture.image = image;
    texture.needsUpdate = true;
    for (const listener of listeners) listener();
  };
  image.src = dataUrl(blob.mime, blob.data);
  blobCache.set(blobId, texture);
  return texture;
}

/** A copy of `source` placed at the material's real-world tiling (world-mm UVs). */
function placed(source: THREE.Texture, material: Material, tileU: number, tileV: number, colour: boolean): THREE.Texture {
  const texture = source.clone();
  // Clones share the source's image; image textures that decode later update through `source`.
  texture.source = source.source;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (colour) texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(1 / tileU, 1 / tileV);
  texture.offset.set(material.offsetX / tileU, material.offsetY / tileV);
  texture.rotation = (material.rotation * Math.PI) / 180;
  texture.needsUpdate = true;
  return texture;
}

/** Whether a material has any texture map (meshes then need UVs). */
export function materialHasMaps(material: Material): boolean {
  return Boolean(material.map || material.normalMap || material.roughnessMap || material.metalnessMap || material.aoMap);
}

interface Built {
  three: THREE.Material;
  blobs: ArchaiDocument['blobs'];
}

const cache = new WeakMap<Material, Map<string, Built>>();

/**
 * The three.js material of a record. Cached per record (records are immutable) and per side,
 * so every mesh using a material shares one instance.
 */
export function threeMaterial(material: Material, doc: Pick<ArchaiDocument, 'blobs'>, doubleSided = false): THREE.Material {
  let byKey = cache.get(material);
  if (!byKey) cache.set(material, (byKey = new Map()));
  const key = doubleSided ? 'double' : 'front';
  const hit = byKey.get(key);
  if (hit && (hit.blobs === doc.blobs || !usesBlobs(material))) return hit.three;

  const physical = material.transmission > 0 || material.clearcoat > 0;
  const parameters: THREE.MeshPhysicalMaterialParameters = {
    name: material.name,
    color: new THREE.Color(material.color),
    roughness: material.roughness,
    metalness: material.metalness,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    emissive: new THREE.Color(material.emissive),
    emissiveIntensity: material.emissiveIntensity,
  };
  if (material.opacity < 1) Object.assign(parameters, { transparent: true, opacity: material.opacity, depthWrite: false });
  const three = physical
    ? new THREE.MeshPhysicalMaterial({ ...parameters, transmission: material.transmission, ior: material.ior, clearcoat: material.clearcoat, thickness: 10 })
    : new THREE.MeshStandardMaterial(parameters);

  const tile = (ref: TextureRef | undefined): { texture: THREE.Texture | null; u: number; v: number; pattern: PatternTextures | null } => {
    if (!ref) return { texture: null, u: 1, v: 1, pattern: null };
    if ('blobId' in ref) return { texture: blobTexture(doc, ref.blobId), u: material.tileWidth, v: material.tileHeight, pattern: null };
    const pattern = patternTextures(ref, material.color);
    return { texture: pattern?.albedo ?? null, u: pattern?.image.periodU ?? 1, v: pattern?.image.periodV ?? 1, pattern };
  };
  const albedo = tile(material.map);
  if (albedo.texture) {
    three.map = placed(albedo.texture, material, albedo.u, albedo.v, true);
    // A pattern already carries the colour; an image is tinted by it (white = as drawn).
    if (albedo.pattern) three.color.set('#ffffff');
  }
  const normal = material.normalMap ? tile(material.normalMap) : albedo.pattern ? albedo : null;
  const normalSource = normal?.pattern ? normal.pattern.normal : normal?.texture ?? null;
  if (normal && normalSource) {
    three.normalMap = placed(normalSource, material, normal.u, normal.v, false);
    three.normalScale.set(material.normalStrength, material.normalStrength);
  }
  const rough = material.roughnessMap ? tile(material.roughnessMap) : albedo.pattern ? albedo : null;
  const roughSource = rough?.pattern ? rough.pattern.roughness : rough?.texture ?? null;
  if (rough && roughSource) three.roughnessMap = placed(roughSource, material, rough.u, rough.v, false);
  if (material.metalnessMap) {
    const metal = tile(material.metalnessMap);
    if (metal.texture) three.metalnessMap = placed(metal.texture, material, metal.u, metal.v, false);
  }
  if (material.aoMap) {
    const ao = tile(material.aoMap);
    if (ao.texture) {
      three.aoMap = placed(ao.texture, material, ao.u, ao.v, false);
      three.aoMapIntensity = material.aoStrength;
    }
  }
  three.userData['materialId'] = material.id;
  // Flat-colour view styles show textured materials in their own colour, not the map's white tint.
  three.userData['materialColor'] = material.color;
  byKey.set(key, { three, blobs: doc.blobs });
  return three;
}

function usesBlobs(material: Material): boolean {
  return [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap].some((ref) => ref && 'blobId' in ref);
}
