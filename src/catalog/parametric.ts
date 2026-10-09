/**
 * Parametric assets: a `.CAI` modeled in ArchAI can ship its recipe (`recipe.json`: bodies,
 * sketches, materials, parameters and the formulas binding them). The board then keeps the
 * package's model as the default look, and rebuilds a placed copy from the recipe when its
 * exposed parameters differ from the defaults (see src/view3d/parametricModels.ts).
 *
 * - the recipe lives on the placed definition (`definition.meta.parametric`), so documents stay
 *   self-contained;
 * - each instance keeps its own values in `meta.parametric.values` (by parameter name), and the
 *   plan bounds of its current model in `meta.parametric.footprint` so the instance box follows
 *   the rebuilt model at the same scale (see `footprintFit`).
 */
import type { AssetDefinition, Element, JsonValue } from '@/document';
import type { Body, PbrMaterial, Sketch, Vec3 } from '@/modeling/kernel/types';
import { resolveParameters, type Bindings, type Parameter } from '@/modeling/parameters';

/** GLB nodes of modeled bodies are named with this prefix, so a rebuild can swap them out. */
export const BODY_NODE_PREFIX = 'archai-body_';

export interface ParametricRecipe {
  version: 1;
  bodies: Body[];
  sketches: Sketch[];
  materials: Record<string, PbrMaterial>;
  parameters: Parameter[];
  bindings: Bindings;
  /** Bounds of the packaged (default) model in the model frame: X width, Y up, Z depth (mm). */
  bounds: { min: Vec3; max: Vec3 };
}

/** Plan bounds of a model (mm, model frame): X across, Z along the depth. */
export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ParametricInstance {
  values: Record<string, number>;
  footprint?: Footprint;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item));

/** Reads a recipe from JSON (a package's recipe.json or a definition's meta); null when invalid. */
export function parseRecipe(value: unknown): ParametricRecipe | null {
  if (!isRecord(value) || value['version'] !== 1) return null;
  const { bodies, sketches, materials, parameters, bindings, bounds } = value;
  if (!Array.isArray(bodies) || !Array.isArray(sketches) || !Array.isArray(parameters) || !isRecord(bindings) || !isRecord(materials)) return null;
  if (!isRecord(bounds) || !isVec3(bounds['min']) || !isVec3(bounds['max'])) return null;
  const validParameter = (item: unknown): item is Parameter =>
    isRecord(item) && typeof item['id'] === 'string' && typeof item['name'] === 'string' && typeof item['value'] === 'number' && typeof item['type'] === 'string' && typeof item['exposed'] === 'boolean';
  if (!parameters.every(validParameter)) return null;
  if (!Object.values(bindings).every((binding) => isRecord(binding) && typeof binding['expression'] === 'string')) return null;
  return value as unknown as ParametricRecipe;
}

export function recipeOf(definition: AssetDefinition | undefined): ParametricRecipe | null {
  return definition ? parseRecipe(definition.meta?.['parametric']) : null;
}

/** Parameters a placed copy can change (inputs marked exposed). */
export function editableParameters(recipe: ParametricRecipe): Parameter[] {
  return recipe.parameters.filter((parameter) => parameter.exposed && parameter.expression === undefined);
}

/** Exposed derived parameters: read-only results shown on the copy (and graph outputs). */
export function derivedParameters(recipe: ParametricRecipe): Parameter[] {
  return recipe.parameters.filter((parameter) => parameter.exposed && parameter.expression !== undefined);
}

export function parametricInstanceOf(element: Element | undefined): ParametricInstance {
  const value = element?.meta?.['parametric'];
  if (!isRecord(value)) return { values: {} };
  const values = isRecord(value['values']) ? Object.fromEntries(Object.entries(value['values']).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) : {};
  const footprint = value['footprint'];
  const fp = isRecord(footprint) && ['minX', 'maxX', 'minZ', 'maxZ'].every((key) => typeof footprint[key] === 'number') ? (footprint as unknown as Footprint) : undefined;
  return { values, ...(fp ? { footprint: fp } : {}) };
}

/** The instance's overrides, limited to editable parameters and differing from the defaults. */
export function instanceOverrides(recipe: ParametricRecipe, instance: ParametricInstance): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const parameter of editableParameters(recipe)) {
    const value = instance.values[parameter.name];
    if (value !== undefined && Math.abs(value - parameter.value) > 1e-9) overrides[parameter.name] = value;
  }
  return overrides;
}

/** Every parameter value of a placed copy (defaults, overrides, derived results). */
export function instanceValues(recipe: ParametricRecipe, instance: ParametricInstance): Record<string, number> {
  return resolveParameters(recipe.parameters, instanceOverrides(recipe, instance)).values;
}

/** A stable cache key for one rebuild: the definition and its overrides. */
export function rebuildKey(definitionId: string, overrides: Readonly<Record<string, number>>): string {
  return `${definitionId}|${JSON.stringify(Object.keys(overrides).sort().map((key) => [key, overrides[key]]))}`;
}

export function footprintOfBounds(bounds: { min: Vec3; max: Vec3 }): Footprint {
  return { minX: bounds.min[0], maxX: bounds.max[0], minZ: bounds.min[2], maxZ: bounds.max[2] };
}

export function sameFootprint(a: Footprint, b: Footprint, tolerance = 0.5): boolean {
  return Math.abs(a.minX - b.minX) <= tolerance && Math.abs(a.maxX - b.maxX) <= tolerance && Math.abs(a.minZ - b.minZ) <= tolerance && Math.abs(a.maxZ - b.maxZ) <= tolerance;
}

/**
 * The instance box for a new model footprint at the same drawing scale, keeping the model's
 * origin where it is on the board. `x, y` are the element's local position change (before its
 * rotation is applied), `width, height` its new size.
 */
export function footprintFit(element: { width: number; height: number }, from: Footprint, to: Footprint): { dx: number; dy: number; width: number; height: number; scale: number } {
  const fromWidth = Math.max(1e-6, from.maxX - from.minX);
  const fromDepth = Math.max(1e-6, from.maxZ - from.minZ);
  const scale = Math.min(element.width / fromWidth, element.height / fromDepth) || 1;
  return { dx: (to.minX - from.minX) * scale, dy: (to.minZ - from.minZ) * scale, width: Math.max(1, (to.maxX - to.minX) * scale), height: Math.max(1, (to.maxZ - to.minZ) * scale), scale };
}

/** A package's parametric recipe (null when it has none or it is unreadable). */
export function recipeFromFiles(files: Record<string, Uint8Array>, mapping: { recipe?: string | undefined }): ParametricRecipe | null {
  if (!mapping.recipe) return null;
  const wanted = mapping.recipe.replaceAll('\\', '/').replace(/^\.?\/+/, '').toLowerCase();
  const entry = Object.entries(files).find(([path]) => path.replaceAll('\\', '/').replace(/^\.?\/+/, '').toLowerCase() === wanted);
  if (!entry) return null;
  try {
    return parseRecipe(JSON.parse(new TextDecoder().decode(entry[1])));
  } catch {
    return null;
  }
}

/**
 * The size a copy has at 100 %: the package size, or for a parametric copy the plan size of its
 * current model (so a rebuilt, wider model is not reported as scaled up).
 */
export function naturalSize(definition: AssetDefinition, element: Element): { width: number; height: number } {
  const recipe = recipeOf(definition);
  if (!recipe) return { width: definition.width, height: definition.height };
  const footprint = parametricInstanceOf(element).footprint ?? footprintOfBounds(recipe.bounds);
  const scale = definition.width / Math.max(1e-6, recipe.bounds.max[0] - recipe.bounds.min[0]);
  return { width: (footprint.maxX - footprint.minX) * scale, height: (footprint.maxZ - footprint.minZ) * scale };
}

/** A JSON-safe copy for storing in document meta. */
export function recipeJson(recipe: ParametricRecipe): JsonValue {
  return JSON.parse(JSON.stringify(recipe)) as JsonValue;
}
