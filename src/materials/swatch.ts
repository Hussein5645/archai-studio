/**
 * Swatch thumbnails for the Materials panel and pickers: a square of the material lit from the
 * top left, drawn on a canvas. Patterns and image maps show their texture (a couple of tiles
 * wide), metals get a sharper highlight, glass a checkerboard behind it. Cached per record.
 */
import type { ArchaiDocument, Material } from '@/document';
import { dataUrl } from '@/persistence/base64';
import { renderPattern } from './patterns';

const cache = new WeakMap<Material, string>();
const images = new Map<string, HTMLImageElement>();

function blobImage(doc: Pick<ArchaiDocument, 'blobs'>, blobId: string, onLoad: () => void): HTMLImageElement | null {
  const cached = images.get(blobId);
  if (cached) return cached.complete ? cached : null;
  const blob = doc.blobs[blobId];
  if (!blob) return null;
  const image = new Image();
  image.onload = onLoad;
  image.src = dataUrl(blob.mime, blob.data);
  images.set(blobId, image);
  return null;
}

/**
 * A data URL of the swatch, or null when it cannot be drawn yet (an image still decoding: call
 * again from `onReady`) or there is no canvas.
 */
export function swatchUrl(material: Material, doc: Pick<ArchaiDocument, 'blobs'>, onReady: () => void = () => {}, size = 96): string | null {
  const cached = cache.get(material);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  if (material.opacity < 1) {
    // Checkerboard behind see-through materials.
    for (let y = 0; y < size; y += 12) for (let x = 0; x < size; x += 12) {
      g.fillStyle = (x + y) % 24 === 0 ? '#ffffff' : '#d6d8dd';
      g.fillRect(x, y, 12, 12);
    }
  }
  g.globalAlpha = material.opacity;
  g.fillStyle = material.color;
  g.fillRect(0, 0, size, size);
  const map = material.map;
  if (map && 'pattern' in map) {
    const image = renderPattern(map.pattern, material.color, 256);
    const tile = document.createElement('canvas');
    tile.width = image.width;
    tile.height = image.height;
    tile.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.albedo), image.width, image.height), 0, 0);
    // About 1.2 m of the pattern across the swatch.
    const across = Math.max(1, 1200 / image.periodU);
    const pattern = g.createPattern(tile, 'repeat');
    if (pattern) {
      pattern.setTransform(new DOMMatrix().scale(size / (image.width * across), size / (image.width * across)).rotate(material.rotation));
      g.fillStyle = pattern;
      g.fillRect(0, 0, size, size);
    }
  } else if (map && 'blobId' in map) {
    const image = blobImage(doc, map.blobId, onReady);
    if (!image) return null;
    g.drawImage(image, 0, 0, size, size);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = material.color;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
  }
  g.globalAlpha = 1;
  // Light from the top left; smoother materials get a tighter, brighter highlight.
  const shine = 0.15 + (1 - material.roughness) * 0.45 + material.metalness * 0.15;
  const light = g.createRadialGradient(size * 0.25, size * 0.2, 0, size * 0.25, size * 0.2, size * (0.5 + material.roughness * 0.9));
  light.addColorStop(0, `rgba(255,255,255,${shine})`);
  light.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = light;
  g.fillRect(0, 0, size, size);
  const shade = g.createLinearGradient(0, 0, size, size);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, `rgba(0,0,0,${0.12 + material.metalness * 0.2})`);
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  if (material.emissiveIntensity > 0) {
    g.fillStyle = material.emissive;
    g.globalAlpha = Math.min(0.6, material.emissiveIntensity / 6);
    g.fillRect(0, 0, size, size);
    g.globalAlpha = 1;
  }
  const url = canvas.toDataURL('image/png');
  cache.set(material, url);
  return url;
}
