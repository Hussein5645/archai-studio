/**
 * Rebuilt models of placed parametric .CAI copies (see src/catalog/parametric.ts). A copy whose
 * parameters differ from the package's defaults is rebuilt from the recipe in the modeling
 * kernel worker; the results are cached by definition and values, so buildScene (which is
 * synchronous) can use them, and `prepareParametric` fills the cache before a rebuild — the same
 * pattern as the site-concept massing.
 */
import * as THREE from 'three';
import type { ArchaiDocument, AssetDefinition } from '@/document';
import { BODY_NODE_PREFIX, instanceOverrides, parametricInstanceOf, rebuildKey, recipeOf, type Footprint, type ParametricRecipe } from '@/catalog/parametric';
import { kernel } from '@/modeling/kernel/client';
import type { Body, EvaluationContext, MeshData, PbrMaterial } from '@/modeling/kernel/types';
import { applyParameters } from '@/modeling/parameters';

export interface RebuiltModel {
  /** The rebuilt bodies, in the model frame (like the package GLB's body nodes). */
  object: THREE.Group;
  bounds: THREE.Box3;
  footprint: Footprint;
}

type Entry = { status: 'ready'; model: RebuiltModel } | { status: 'error'; message: string };

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const listeners = new Set<() => void>();
let generation = 0;

/** Called when a rebuild finishes (2D plan symbols re-render then). */
export function onParametricRebuilt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function parametricGeneration(): number {
  return generation;
}

function material(source: PbrMaterial | undefined): THREE.MeshStandardMaterial {
  const opacity = source?.opacity ?? 1;
  return new THREE.MeshStandardMaterial({ name: source?.name ?? 'Material', color: source?.color ?? '#9a9aa3', roughness: source?.roughness ?? 0.8, metalness: source?.metalness ?? 0, opacity, transparent: opacity < 1 });
}

function meshOf(body: Body, data: MeshData, materials: Record<string, PbrMaterial>): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  const list: THREE.Material[] = [material(materials[body.material])];
  const slots = new Map<string | null, number>([[null, 0]]);
  for (const group of data.groups) {
    let slot = slots.get(group.material);
    if (slot === undefined) {
      slot = list.length;
      list.push(material(group.material ? materials[group.material] : undefined));
      slots.set(group.material, slot);
    }
    geometry.addGroup(group.start, group.count, slot);
  }
  const mesh = new THREE.Mesh(geometry, data.groups.length ? list : list[0]!);
  mesh.name = `${BODY_NODE_PREFIX}${body.id}`;
  const [x, y, z] = body.placement.position;
  const [rx, ry, rz] = body.placement.rotation.map(THREE.MathUtils.degToRad) as [number, number, number];
  mesh.position.set(x, y, z);
  // World X, then Y, then Z: the modeling kernel's placement convention.
  mesh.rotation.set(rx, ry, rz, 'ZYX');
  const [sx, sy, sz] = body.placement.scale ?? [1, 1, 1];
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

let requestSerial = 0;

/** Evaluates a recipe with parameter overrides into a model (every visible body). */
export async function evaluateRecipe(recipe: ParametricRecipe, overrides: Readonly<Record<string, number>>): Promise<RebuiltModel> {
  const driven = applyParameters(recipe, recipe.parameters, recipe.bindings, overrides);
  const problems = Object.values(driven.errors);
  if (problems.length) throw new Error(problems[0]);
  // The kernel keeps one request per body id: give this evaluation its own ids so copies with
  // different values never supersede each other.
  const tag = `p${++requestSerial}:`;
  const renamed = driven.bodies.map((body) => ({
    ...body,
    id: `${tag}${body.id}`,
    features: body.features.map((feature) => (feature.kind === 'boolean' ? { ...feature, tool: `${tag}${feature.tool}` } : feature)),
  }));
  const context: EvaluationContext = { sketches: Object.fromEntries(driven.sketches.map((sketch) => [sketch.id, sketch])), bodies: Object.fromEntries(renamed.map((body) => [body.id, body])) };
  const object = new THREE.Group();
  object.name = 'parametric-rebuild';
  await Promise.all(
    driven.bodies.map(async (body, index) => {
      if (!body.visible) return;
      const data = await kernel.evaluate(renamed[index]!, context);
      if (data) object.add(meshOf(body, data, recipe.materials));
    }),
  );
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error('The parameters leave nothing to build');
  return { object, bounds, footprint: { minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z } };
}

/** The finished rebuild for these values: a model, an error, or undefined while not built yet. */
export function rebuiltModel(definitionId: string, overrides: Readonly<Record<string, number>>): Entry | undefined {
  return cache.get(rebuildKey(definitionId, overrides));
}

export function requestRebuild(definition: AssetDefinition, recipe: ParametricRecipe, overrides: Readonly<Record<string, number>>): Promise<Entry> {
  const key = rebuildKey(definition.id, overrides);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  let running = pending.get(key);
  if (!running) {
    running = evaluateRecipe(recipe, overrides)
      .then((model): Entry => ({ status: 'ready', model }))
      .catch((error: unknown): Entry => ({ status: 'error', message: error instanceof Error ? error.message : String(error) }))
      .then((entry) => {
        pending.delete(key);
        cache.set(key, entry);
        // Keep memory bounded: drop the oldest rebuilds.
        while (cache.size > 64) {
          const oldest = cache.keys().next().value as string;
          const dropped = cache.get(oldest);
          if (dropped?.status === 'ready') dropped.model.object.traverse((child) => { if (child instanceof THREE.Mesh) child.geometry.dispose(); });
          cache.delete(oldest);
        }
        generation++;
        for (const listener of listeners) listener();
        return entry;
      });
    pending.set(key, running);
  }
  return running;
}

/** Builds every rebuild the document needs; resolves true when something new is ready. */
export async function prepareParametric(doc: ArchaiDocument): Promise<boolean> {
  if (typeof Worker === 'undefined') return false;
  const work: Promise<Entry>[] = [];
  for (const element of Object.values(doc.elements)) {
    if (element.kind !== 'instance') continue;
    const definition = doc.definitions[element.definitionId];
    const recipe = recipeOf(definition);
    if (!definition || !recipe) continue;
    const overrides = instanceOverrides(recipe, parametricInstanceOf(element));
    if (Object.keys(overrides).length === 0 || cache.has(rebuildKey(definition.id, overrides))) continue;
    work.push(requestRebuild(definition, recipe, overrides));
  }
  if (!work.length) return false;
  const entries = await Promise.all(work);
  return entries.length > 0;
}

/**
 * The model a copy shows: the package model with its body nodes replaced by the rebuilt ones.
 * Imported (non-body) layers of the package stay as they are.
 */
export function composeRebuilt(packageModel: THREE.Object3D | undefined, rebuilt: RebuiltModel): THREE.Group {
  const group = new THREE.Group();
  if (packageModel) {
    const clone = packageModel.clone(true);
    const bodies: THREE.Object3D[] = [];
    clone.traverse((child) => {
      if (child.name.startsWith(BODY_NODE_PREFIX)) bodies.push(child);
    });
    for (const body of bodies) body.removeFromParent();
    clone.traverse((child) => {
      child.userData['shared'] = true;
    });
    group.add(clone);
  }
  const rebuiltClone = rebuilt.object.clone(true);
  rebuiltClone.traverse((child) => {
    child.userData['shared'] = true; // geometry and materials belong to the cache
  });
  group.add(rebuiltClone);
  return group;
}
