/**
 * The model of a VR tour (and the 3D snapshot saved in .AIR files): the document's 3D scene (as the 3D view builds it, at high detail)
 * exported as one binary glTF in metres, plus a ground disc so visitors never look into a void.
 * Board-only helpers (point markers, level datums, edge lines) are left out: a headset gets
 * surfaces only.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { AssetCatalog } from '@/catalog';
import { childrenOf, type ArchaiDocument, type Element } from '@/document';
import { prepareMassing } from '@/analysis/massing';
import { modelStore, textureStore } from './assets';
import { archTypeOf } from '@/assets/arch-meta';
import { parentLevelOf } from '@/layers/hierarchy';
import { buildScene, sceneCentre, type Built } from './geometry';
import { prepareParametric } from './parametricModels';
import { meshStore } from './meshes';
import { optimiseVrSurfaces } from './vrOptimise';

/** The document's 3D scene at high detail, in metres, without board-only helpers. */
export async function buildSurfaces(doc: ArchaiDocument, catalog: AssetCatalog, wrap: (item: Built) => THREE.Object3D = (item) => item.object,
  include?: (id: string) => boolean,
): Promise<THREE.Group> {
  modelStore.configure(catalog);
  // Prepare output subtrees; keep all host/level/opening context for geometry construction.
  let prepared = doc;
  if (include) {
    const elements: Record<string, Element> = {};
    const visit = (element: Element) => {
      elements[element.id] = element;
      for (const child of childrenOf(doc.elements, element.id)) visit(child);
    };
    for (const root of childrenOf(doc.elements, null)) if (include(root.id)) visit(root);
    prepared = { ...doc, elements };
  }
  await Promise.all([modelStore.prepare(prepared), textureStore.prepare(prepared), prepareMassing(prepared), prepareParametric(prepared), meshStore.prepare(prepared)]);
  const built = buildScene(doc, { textures: textureStore.textures, models: modelStore.models, lowModels: modelStore.lowModels, lod: 'high',
    include,
  });

  const root = new THREE.Group();
  root.name = doc.meta.name || 'ArchAI';
  // Millimetres → metres. Board x / y are already the scene's x / z with y up, as glTF wants.
  root.scale.setScalar(0.001);
  for (const item of built) root.add(wrap(item));
  const strip: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child.userData['pointMarker'] || child.userData['pointStem'] || child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Sprite) strip.push(child);
  });
  for (const child of strip) child.parent?.remove(child);
  // Groups left empty (level datums, reference points) are noise in other apps.
  for (const child of [...root.children]) {
    let meshes = 0;
    child.traverse((c) => { if (c instanceof THREE.Mesh) meshes++; });
    if (meshes === 0) root.remove(child);
  }
  return root;
}

/**
 * The 3D snapshot saved inside .AIR files (`scene3d`, see docs/plugins.md): what the ArchAI
 * plugins for AutoCAD, Rhino, SketchUp, Blender, 3ds Max and Unreal import. One node per element,
 * named after it, with `extras.archai = { id, kind, type, level }`.
 *
 * Live Bridge pulls select output roots before building. Dependency queries still see the full
 * document so walls keep their openings. Extras describe the nodes and the complete delta.
 */
export async function exportSceneSnapshot(
  doc: ArchaiDocument,
  catalog: AssetCatalog,
  options: { include?: (id: string) => boolean; extras?: (id: string) => Record<string, unknown> | undefined; root?: Record<string, unknown>;
  } = {},
): Promise<ArrayBuffer> {
  const root = await buildSurfaces(doc, catalog, (item) => {
    if (options.include && !options.include(item.id)) return new THREE.Group();
    const element = doc.elements[item.id];
    const levelId = element ? parentLevelOf(doc.elements, element.id) : null;
    const level = levelId ? doc.elements[levelId] : undefined;
    const node = new THREE.Group();
    node.name = element?.name?.trim() || archTypeOf(element) || element?.kind || 'Element';
    node.userData = { archai: { id: item.id, kind: element?.kind ?? '', type: archTypeOf(element) ?? '', level: level?.name?.trim() || null, ...options.extras?.(item.id) } };
    node.add(item.object);
    return node;
  },
    options.include,
  );
  if (options.root) root.userData = { ...root.userData, ...options.root };
  root.updateMatrixWorld(true);
  const exported = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: 1024 });
  if (!(exported instanceof ArrayBuffer)) throw new Error('The 3D snapshot could not be exported');
  return exported;
}

export async function exportVrModel(doc: ArchaiDocument, catalog: AssetCatalog): Promise<ArrayBuffer> {
  const root = await buildSurfaces(doc, catalog);

  const { centre, radius } = sceneCentre(doc);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(Math.max(radius * 4, 60_000), 64), new THREE.MeshStandardMaterial({ name: 'Ground', color: 0xd9dbd5, roughness: 1 }));
  ground.name = 'Ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centre.x, -25, centre.z);
  root.add(ground);
  root.updateMatrixWorld(true);

  const optimized = optimiseVrSurfaces(root);
  try {
    const exported = await new GLTFExporter().parseAsync(optimized, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
    if (!(exported instanceof ArrayBuffer)) throw new Error('The model could not be exported');
    return exported;
  } finally {
    // Batched geometry is owned by the export, the cloned source geometry is shared.
    for (const child of optimized.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
  }
}
