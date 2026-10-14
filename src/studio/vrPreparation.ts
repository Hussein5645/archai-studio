import type { ArchaiDocument } from '@/document';
import type { RenderSettings } from './settings';

export const VR_QUALITY = {
  fast: {
    label: 'Fast',
    samples: 8,
    bounces: 1,
    edge: 2,
    triangles: 150_000,
    textureSize: 1024,
    panoramaWidth: 2048,
    panoramaSamples: 64,
  },
  balanced: {
    label: 'Balanced',
    samples: 24,
    bounces: 2,
    edge: 1,
    triangles: 350_000,
    textureSize: 2048,
    panoramaWidth: 4096,
    panoramaSamples: 256,
  },
  high: {
    label: 'High Quality',
    samples: 64,
    bounces: 3,
    edge: 0.5,
    triangles: 700_000,
    textureSize: 2048,
    panoramaWidth: 8192,
    panoramaSamples: 512,
  },
} as const;
export type VrQuality = keyof typeof VR_QUALITY;
export type PreparedOutput = 'baked' | 'panorama';

export const preparedLinkKey = (docId: string, output: PreparedOutput) =>
  `vr-tour:${docId}:${output}`;
export const preparationKey = (docId: string) => `vr-preparation:${docId}`;
const documentSignatures = new WeakMap<ArchaiDocument, string>();
function contentHash(value: unknown): string {
  let a = 2166136261,
    b = 5381;
  const add = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul(b, 33) ^ c;
    }
  };
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      add('[');
      for (const item of entry) visit(item);
      add(']');
    } else if (entry && typeof entry === 'object') {
      add('{');
      for (const key of Object.keys(entry).sort()) {
        add(JSON.stringify(key));
        visit((entry as Record<string, unknown>)[key]);
      }
      add('}');
    } else add(JSON.stringify(entry) ?? 'undefined');
    add('|');
  };
  visit(value);
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

/** Camera moves do not invalidate a 3D bake; project and lighting changes do. */
export function preparationSignature(
  doc: ArchaiDocument,
  settings: RenderSettings,
  quality: VrQuality,
): string {
  const {
    fov: _fov,
    depthOfField: _dof,
    focusDistance: _focus,
    fStop: _stop,
    ...lighting
  } = settings;
  // A deterministic content signature avoids treating a live-link retransmission as an edit.
  let content = documentSignatures.get(doc);
  if (!content) {
    content = contentHash([
      doc.id,
      doc.elements,
      doc.materials,
      doc.definitions,
      doc.blobs,
      doc.workspace,
    ]);
    documentSignatures.set(doc, content);
  }
  return `${content}:${contentHash([lighting, quality])}`;
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
}
