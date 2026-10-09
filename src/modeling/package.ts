/**
 * Packages the modeled asset as a .CAI: the full model (imported layers and modeled bodies) and
 * (optionally) the low level of detail subset as GLB, the top / front / side views rendered from the model in every display style,
 * the cameras relative to the model, and the metadata / mapping the catalog expects.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createCaiPackage, type CaiPackageFile } from '@/catalog/builder';
import { VIEW_STYLES, type CaiMetadata, type ViewStyleName } from '@/catalog/cai';
import { canvasPngBytes, renderPerspectiveStill, renderStill, type OrthoView } from '@/view3d/offscreen';
import type { ModelingScene } from './scene';
import { slugify, type ModelingState } from './store';
import { BODY_NODE_PREFIX, type ParametricRecipe } from '@/catalog/parametric';
import { liveBindings } from './parameters';

export interface PackageOptions {
  /** Include the low level of detail model (layers flagged `lowLod`). */
  includeLow: boolean;
  onProgress?: (message: string) => void;
}

async function exportGlb(objects: THREE.Object3D[]): Promise<Uint8Array> {
  const result = await new GLTFExporter().parseAsync(objects, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('GLB export did not produce binary data');
  return new Uint8Array(result);
}

export async function packageAsset(state: ModelingState, scene: ModelingScene, options: PackageOptions): Promise<{ bytes: Uint8Array; fileName: string }> {
  const name = state.metadata.name.trim();
  if (!name) throw new Error('Give the asset a name first');
  const id = state.metadata.id.trim() || slugify(name);
  if (!id) throw new Error('The package id is empty');
  const preview = state.cameras.find((camera) => camera.preview) ?? null;
  if (state.cameras.length === 0) throw new Error('Add at least one camera and tick it as the preview camera before packaging');
  if (!preview) throw new Error('Tick one camera as the preview camera: its hidden-line view becomes the thumbnail');
  const layers = state.layers.filter((layer) => layer.visible);
  const bodies = state.bodies.filter((body) => body.visible);
  const objects = [...layers.map((layer) => scene.layerObject(layer.id)), ...bodies.map((body) => scene.bodyObject(body.id))].filter((object): object is THREE.Object3D => object !== null);
  if (objects.length === 0) throw new Error('There is nothing to package: import or model something first');
  if (bodies.some((body) => state.bodyInfo[body.id]?.error)) throw new Error('A body failed to evaluate: fix it (see Layers) before packaging');
  const progress = options.onProgress ?? (() => {});

  // Models are exported as they are shown: realistic materials, no hidden-line edges, no highlights.
  scene.setFaceHighlight('hover', null);
  scene.setFaceHighlight('selected', null);
  scene.applyStyle('realistic');
  scene.applyLod(false, state.layers, state.bodies);
  progress('Exporting model…');
  // Body nodes are named so a board can swap them for bodies rebuilt with other parameters.
  const bodyObjects = bodies.map((body) => [body.id, scene.bodyObject(body.id)] as const).filter((entry): entry is readonly [string, NonNullable<ReturnType<ModelingScene['bodyObject']>>] => entry[1] !== null);
  const names = bodyObjects.map(([id, object]) => {
    const name = object.name;
    object.name = `${BODY_NODE_PREFIX}${id}`;
    return name;
  });
  let high: Uint8Array;
  try {
    high = await exportGlb(objects);
  } finally {
    bodyObjects.forEach(([, object], index) => { object.name = names[index]!; });
  }
  let low: Uint8Array | null = null;
  if (options.includeLow) {
    // The low model is the flagged subset of nodes and bodies: hide the rest and export only what shows.
    const lowLayers = layers.filter((layer) => layer.lowLod);
    const lowBodies = bodies.filter((body) => body.lowLod);
    if (lowLayers.length + lowBodies.length > 0) {
      progress('Exporting low LOD model…');
      scene.applyLod(true, state.layers, state.bodies);
      try {
        low = await exportGlb([...lowLayers.map((layer) => scene.layerObject(layer.id)), ...lowBodies.map((body) => scene.bodyObject(body.id))].filter((object): object is THREE.Object3D => object !== null));
      } finally {
        scene.applyLod(false, state.layers, state.bodies);
      }
    }
  }

  // Views: every plane in every style, cut at the plane like the 2D panes show them.
  const bounds = scene.bounds() ?? new THREE.Box3(new THREE.Vector3(-500, 0, -500), new THREE.Vector3(500, 1000, 500));
  const views: OrthoView[] = ['top', 'front', 'side'];
  const styleViews: Partial<Record<ViewStyleName, { top?: CaiPackageFile; front?: CaiPackageFile; side?: CaiPackageFile }>> = {};
  for (const style of VIEW_STYLES) {
    const set: { top?: CaiPackageFile; front?: CaiPackageFile; side?: CaiPackageFile } = {};
    for (const view of views) {
      progress(`Rendering ${view} view (${style})…`);
      const clones = objects.map((object) => object.clone(true));
      // Line styles read best on white; the realistic/colour views keep a transparent background.
      const background = style === 'hidden-line' || style === 'wireframe' ? 0xffffff : null;
      const canvas = renderStill({ objects: clones, view, style, size: 1024, clipAt: state.planes[view], bounds, background });
      set[view] = { name: `${view}.png`, bytes: await canvasPngBytes(canvas) };
    }
    styleViews[style] = set;
  }
  const realistic = styleViews.realistic!;

  // Thumbnail: hidden-line perspective through the preview camera.
  progress('Rendering preview…');
  const previewCanvas = renderPerspectiveStill({
    objects: objects.map((object) => object.clone(true)),
    eye: preview.eye,
    aim: preview.aim,
    fov: preview.fov,
    style: 'hidden-line',
    width: 640,
    height: 480,
    background: 0xffffff,
  });
  const previewView: CaiPackageFile = { name: 'preview.png', bytes: await canvasPngBytes(previewCanvas) };

  const [width, height, depth] = state.modelSize;
  const tags = state.metadata.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const metadata: CaiMetadata = {
    caiVersion: 1,
    id,
    name,
    category: state.metadata.category,
    kind: 'asset',
    size: { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(depth)) },
    modelHeight: Math.round(height),
    ...(tags.length > 0 ? { tags } : {}),
    lod: { low: low !== null },
    ...(bodies.length > 0 ? { modeled: true } : {}),
    cameras: state.cameras.map((camera) => ({ name: camera.name, eye: camera.eye, aim: camera.aim, fov: camera.fov, ...(camera.preview ? { preview: true } : {}) })),
  };
  // Parameters travel with the package: the recipe lets each placed copy be rebuilt with its own values.
  const recipe: ParametricRecipe | null = state.parameters.length > 0
    ? {
        version: 1,
        // Hidden bodies too: they can be boolean tools of the visible ones.
        bodies: state.bodies,
        sketches: state.sketches,
        materials: state.materials,
        parameters: state.parameters,
        bindings: liveBindings({ bodies: state.bodies, sketches: state.sketches }, state.bindings),
        bounds: { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] },
      }
    : null;
  if (recipe && layers.length > 0) progress('Imported layers stay as they are on placed copies; only modeled bodies follow the parameters');
  progress('Writing package…');
  const bytes = createCaiPackage({
    metadata,
    topView: realistic.top,
    frontView: realistic.front,
    sideView: realistic.side,
    previewView,
    modelGlb: { name: 'model.glb', bytes: high },
    ...(recipe ? { recipe: { name: 'recipe.json', bytes: new TextEncoder().encode(JSON.stringify(recipe)) } } : {}),
    ...(low ? { modelGlbLow: { name: 'model-low.glb', bytes: low } } : {}),
    styleViews: Object.fromEntries(Object.entries(styleViews).filter(([style]) => style !== 'realistic')) as typeof styleViews,
  });
  return { bytes, fileName: `${id}.cai` };
}
