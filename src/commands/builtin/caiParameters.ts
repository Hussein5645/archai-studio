/**
 * Parameters of placed parametric .CAI assets (see src/catalog/parametric.ts): each copy keeps
 * its own values; the board rebuilds its model and then fits the copy's box to the new model
 * (`fit-parametric-footprint`, a derived update without its own undo step).
 */
import { z } from 'zod';
import { IdSchema, type InstanceElement, type JsonValue } from '@/document';
import { editableParameters, footprintFit, footprintOfBounds, parametricInstanceOf, recipeOf, sameFootprint, type Footprint } from '@/catalog/parametric';
import { CommandError, defineMutation, type MutationContext } from '../contract';

function parametricTarget(ctx: MutationContext, id: string): { element: InstanceElement; recipe: NonNullable<ReturnType<typeof recipeOf>> } {
  const element = ctx.doc.elements[id];
  if (!element || element.kind !== 'instance') throw new CommandError('rejected', 'Select a placed parametric asset');
  const recipe = recipeOf(ctx.doc.definitions[element.definitionId]);
  if (!recipe) throw new CommandError('rejected', 'This asset has no parameters');
  return { element: element as InstanceElement, recipe };
}

/** Sets parameter values of placed copies (by parameter name); `null` resets one to its default. */
export const setCaiParameters = defineMutation({
  id: 'set-cai-parameters',
  label: 'Set asset parameters',
  description: 'Changes the exposed parameters of placed parametric assets; the model is rebuilt with them.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), values: z.record(z.string(), z.number().finite().nullable()), reset: z.boolean().default(false) }),
  run: (ctx, input) => {
    let changed = 0;
    for (const id of input.ids) {
      const { element, recipe } = parametricTarget(ctx, id);
      if (element.locked) throw new CommandError('rejected', `${element.name ?? 'The asset'} is locked`);
      const editable = new Map(editableParameters(recipe).map((parameter) => [parameter.name, parameter]));
      const instance = parametricInstanceOf(element);
      const values: Record<string, number> = input.reset ? {} : { ...instance.values };
      for (const [name, raw] of Object.entries(input.values)) {
        const parameter = editable.get(name);
        if (!parameter) throw new CommandError('invalid-input', `“${name}” is not an editable parameter of this asset`);
        if (raw === null) {
          delete values[name];
          continue;
        }
        let value = Math.min(parameter.max ?? Infinity, Math.max(parameter.min ?? -Infinity, raw));
        if (parameter.type === 'count') value = Math.round(value);
        if (parameter.type === 'boolean') value = value ? 1 : 0;
        if (Math.abs(value - parameter.value) < 1e-9) delete values[name];
        else values[name] = value;
      }
      const meta: Record<string, JsonValue> = { ...(element.meta ?? {}) };
      const footprint = instance.footprint ?? footprintOfBounds(recipe.bounds);
      meta['parametric'] = { values, footprint: { ...footprint } };
      element.meta = meta;
      changed++;
    }
    return changed;
  },
});

/**
 * Fits a copy's box to its rebuilt model's plan bounds at the same drawing scale, keeping the
 * model's origin in place (the board runs this when a rebuild finishes).
 */
export const fitParametricFootprint = defineMutation({
  id: 'fit-parametric-footprint',
  label: 'Fit asset to its parameters',
  group: 'edit',
  palette: false,
  history: 'none',
  input: z.object({ id: IdSchema, footprint: z.object({ minX: z.number().finite(), maxX: z.number().finite(), minZ: z.number().finite(), maxZ: z.number().finite() }) }),
  run: (ctx, input) => {
    const { element, recipe } = parametricTarget(ctx, input.id);
    const instance = parametricInstanceOf(element);
    const from: Footprint = instance.footprint ?? footprintOfBounds(recipe.bounds);
    const to: Footprint = input.footprint;
    if (sameFootprint(from, to) || to.maxX - to.minX < 1e-3 || to.maxZ - to.minZ < 1e-3) return false;
    const fit = footprintFit(element, from, to);
    // The shift is in the element's own axes; x / y are in its parent's.
    const local = rotate({ x: fit.dx, y: fit.dy }, element.rotation);
    element.x += local.x;
    element.y += local.y;
    element.width = fit.width;
    element.height = fit.height;
    element.meta = { ...(element.meta ?? {}), parametric: { values: { ...instance.values }, footprint: { ...to } } };
    return true;
  },
});

/** A vector in an element's frame (rotated clockwise by `degrees`) in its parent's frame. */
function rotate(vector: { x: number; y: number }, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

export const caiParameterCommands = [setCaiParameters, fitParametricFootprint];
