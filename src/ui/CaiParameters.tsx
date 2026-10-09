/**
 * Inspector section for a placed parametric .CAI copy: its exposed parameters (editable per
 * copy), the derived values it reports, and whether its model is rebuilt yet.
 */
import { useSyncExternalStore } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element } from '@/document';
import { derivedParameters, editableParameters, instanceOverrides, instanceValues, parametricInstanceOf, recipeOf } from '@/catalog/parametric';
import type { Parameter } from '@/modeling/parameters';
import { onParametricRebuilt, parametricGeneration, rebuiltModel } from '@/view3d/parametricModels';
import { Field, IconButton, NumberField, TextButton, ToggleRow } from './primitives';
import styles from './Inspector.module.css';

function display(parameter: Parameter, value: number): string {
  if (parameter.type === 'boolean') return value ? 'On' : 'Off';
  const rounded = Math.abs(value - Math.round(value)) < 1e-6 ? String(Math.round(value)) : value.toFixed(2);
  return parameter.type === 'length' ? `${rounded} mm` : parameter.type === 'angle' ? `${rounded}°` : rounded;
}

export function CaiParameters({ element, controlled }: { element: Element & { kind: 'instance' }; controlled: ReadonlySet<string> }) {
  const definition = useAppState((s) => s.doc.definitions[element.definitionId]);
  const dispatch = useDispatch();
  useSyncExternalStore(onParametricRebuilt, parametricGeneration, parametricGeneration);
  const recipe = recipeOf(definition);
  if (!recipe || !definition) return null;
  const instance = parametricInstanceOf(element);
  const values = instanceValues(recipe, instance);
  const overrides = instanceOverrides(recipe, instance);
  const editable = editableParameters(recipe);
  const derived = derivedParameters(recipe);
  const custom = Object.keys(overrides).length > 0;
  const entry = custom ? rebuiltModel(definition.id, overrides) : undefined;
  const set = (name: string, value: number | null) => void dispatch('set-cai-parameters', { ids: [element.id], values: { [name]: value } });
  if (editable.length === 0 && derived.length === 0) return null;
  return (
    <div className={styles.section} data-testid="cai-parameters">
      <h3 className="u-section-title">Parameters</h3>
      {editable.map((parameter) => {
        const value = values[parameter.name] ?? parameter.value;
        const byGraph = controlled.has(`cai:${parameter.name}`);
        const changed = parameter.name in overrides;
        const label = `${parameter.name}${byGraph ? ' · Graph' : ''}`;
        const reset = changed && !byGraph && (
          <IconButton label={`Reset ${parameter.name} to ${display(parameter, parameter.value)}`} onClick={() => set(parameter.name, null)}>
            <RotateCcw size={12} />
          </IconButton>
        );
        if (parameter.type === 'boolean') {
          return (
            <div key={parameter.id} className={styles.paramRow}>
              <ToggleRow label={label} value={Boolean(value)} onChange={(on) => !byGraph && set(parameter.name, on ? 1 : 0)} />
              {reset}
            </div>
          );
        }
        return (
          <Field key={parameter.id} label={label}>
            <div className={styles.paramRow}>
              <NumberField
                value={value}
                unit={parameter.type === 'length' ? 'mm' : undefined}
                suffix={parameter.type === 'angle' ? '°' : undefined}
                precision={parameter.type === 'count' ? 0 : parameter.type === 'length' ? 0 : 2}
                min={parameter.min}
                max={parameter.max}
                disabled={byGraph || element.locked}
                onCommit={(next) => set(parameter.name, next)}
                ariaLabel={parameter.name}
              />
              {reset}
            </div>
          </Field>
        );
      })}
      {derived.length > 0 && (
        <dl className={styles.paramFacts}>
          {derived.map((parameter) => (
            <div key={parameter.id} className={styles.paramFact}>
              <dt>{parameter.name}</dt>
              <dd>{values[parameter.name] === undefined ? '—' : display(parameter, values[parameter.name]!)}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry?.status === 'error' ? (
        <p className={styles.paramHint} role="alert"><TriangleAlert size={12} /> These values cannot be built: {entry.message}</p>
      ) : custom && !entry ? (
        <p className={styles.paramHint}>Rebuilding the model…</p>
      ) : (
        <p className={styles.paramHint}>{custom ? 'This copy uses its own values.' : 'Using the package defaults.'} Parameters can also be driven from a parametric graph.</p>
      )}
      {custom && (
        <div className={styles.actions}>
          <TextButton onClick={() => void dispatch('set-cai-parameters', { ids: [element.id], values: {}, reset: true })}>Reset all to defaults</TextButton>
        </div>
      )}
    </div>
  );
}
