import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createEmptyDocument, sequentialIds } from '@/document';
import { canonicalJson, createScenePackage } from './scenePackage';
import { defaultSettings } from './settings';

describe('scene interchange package', () => {
  it('exports separate portable assets and stable source/render revisions', async () => {
    const doc = createEmptyDocument({ ids: sequentialIds(), now: () => '2026-10-20T00:00:00Z' });
    const settings = defaultSettings();
    const model = new Uint8Array([1, 2, 3]).buffer;
    const first = await createScenePackage(doc, settings, model);
    const second = await createScenePackage(doc, { ...settings, exposure: 2 }, model);
    expect(first.manifest.sourceRevision).toBe(second.manifest.sourceRevision);
    expect(first.manifest.renderRevision).not.toBe(second.manifest.renderRevision);
    const files = unzipSync(first.bytes);
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'render.json', 'scene.glb']);
    expect(files['scene.glb']).toEqual(new Uint8Array(model));
    expect(JSON.parse(strFromU8(files['render.json']!))).toMatchObject({ projectId: doc.id, settings });
    expect(first.manifest.model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.capabilities.unrealRuntime).toBe(false);
  });

  it('canonicalizes object keys while preserving array ordering', () => {
    expect(canonicalJson({ b: 1, a: { z: 2, x: 3 } })).toBe(canonicalJson({ a: { x: 3, z: 2 }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
