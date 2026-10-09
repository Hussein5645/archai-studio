/**
 * Parametric design UI for the modeling workspace: the Parameters panel (named values, derived
 * formulas, which ones are exposed on the board) and `ParamNumber`, a number field that can be
 * driven by a formula instead of a typed value (the "fx" button).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, SlidersHorizontal, Trash2, TriangleAlert } from 'lucide-react';
import { Field, FieldRow, IconButton, NumberField, SelectField, TextButton, TextField, ToggleRow } from '@/ui/primitives';
import primitiveStyles from '@/ui/primitives.module.css';
import styles from './Modeling.module.css';
import { Panel } from './Panel';
import { formulaNames, parseFormula, type Binding, type Parameter, type ParameterType } from './parameters';
import { modelingStore, useModeling } from './store';

const TYPE_OPTIONS: { value: ParameterType; label: string }[] = [
  { value: 'length', label: 'Length' },
  { value: 'angle', label: 'Angle' },
  { value: 'count', label: 'Count' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'On / off' },
];

function formatValue(parameter: Parameter, value: number | undefined): string {
  if (value === undefined) return '—';
  if (parameter.type === 'boolean') return value ? 'On' : 'Off';
  const rounded = Math.abs(value - Math.round(value)) < 1e-6 ? String(Math.round(value)) : value.toFixed(2);
  return parameter.type === 'length' ? `${rounded} mm` : parameter.type === 'angle' ? `${rounded}°` : rounded;
}

/** How many formulas read a parameter. */
function usesOf(name: string, parameters: readonly Parameter[], bindings: Record<string, Binding>): number {
  const reads = (source: string) => {
    try {
      return formulaNames(parseFormula(source)).has(name);
    } catch {
      return false;
    }
  };
  return Object.values(bindings).filter((binding) => reads(binding.expression)).length + parameters.filter((parameter) => parameter.expression && reads(parameter.expression)).length;
}

function ParameterCard({ parameter }: { parameter: Parameter }) {
  const parameters = useModeling((s) => s.parameters);
  const bindings = useModeling((s) => s.bindings);
  const value = useModeling((s) => s.parameterValues[parameter.name]);
  const error = useModeling((s) => s.parameterErrors[parameter.id]);
  const [nameError, setNameError] = useState<string | null>(null);
  const update = (patch: Partial<Parameter>) => modelingStore.getState().updateParameter(parameter.id, patch);
  const unit = parameter.type === 'length' ? 'mm' : undefined;
  const suffix = parameter.type === 'angle' ? '°' : undefined;
  const precision = parameter.type === 'count' ? 0 : parameter.type === 'length' ? 0 : 2;
  const uses = usesOf(parameter.name, parameters, bindings);
  return (
    <div className={styles.paramCard} data-testid={`parameter-${parameter.name}`}>
      <FieldRow>
        <Field label="Name">
          <TextField
            value={parameter.name}
            ariaLabel="Parameter name"
            onCommit={(name) => {
              try {
                update({ name: name.trim() });
                setNameError(null);
              } catch (caught) {
                setNameError(caught instanceof Error ? caught.message : String(caught));
              }
            }}
          />
        </Field>
        <Field label="Type">
          <SelectField value={parameter.type} options={TYPE_OPTIONS} onChange={(type) => update({ type, ...(type === 'boolean' ? { value: parameter.value ? 1 : 0 } : {}) })} ariaLabel="Parameter type" />
        </Field>
      </FieldRow>
      {nameError && <p className={styles.errorNote} role="alert"><TriangleAlert size={13} /> {nameError}</p>}
      {parameter.expression !== undefined ? (
        <Field label={`Formula · ${formatValue(parameter, value)}`}>
          <FormulaInput value={parameter.expression} onCommit={(expression) => update({ expression })} ariaLabel="Parameter formula" />
        </Field>
      ) : parameter.type === 'boolean' ? (
        <ToggleRow label="Value" value={Boolean(parameter.value)} onChange={(on) => update({ value: on ? 1 : 0 })} />
      ) : (
        <Field label="Value">
          <NumberField value={parameter.value} unit={unit} suffix={suffix} precision={precision} min={parameter.min} max={parameter.max} onCommit={(next) => update({ value: parameter.type === 'count' ? Math.round(next) : next })} ariaLabel="Parameter value" />
        </Field>
      )}
      {error && <p className={styles.errorNote} role="alert"><TriangleAlert size={13} /> {error}</p>}
      {parameter.type !== 'boolean' && (
        <FieldRow>
          <Field label="Min">
            <OptionalNumber value={parameter.min} onCommit={(min) => update({ min })} ariaLabel="Parameter minimum" />
          </Field>
          <Field label="Max">
            <OptionalNumber value={parameter.max} onCommit={(max) => update({ max })} ariaLabel="Parameter maximum" />
          </Field>
        </FieldRow>
      )}
      <ToggleRow label="Computed by a formula" value={parameter.expression !== undefined} onChange={(on) => update({ expression: on ? String(parameter.value) : undefined, ...(on ? { exposed: false } : {}) })} />
      <ToggleRow label={parameter.expression !== undefined ? 'Show on the board (read only)' : 'Editable on the board'} value={parameter.exposed} onChange={(exposed) => update({ exposed })} />
      <div className={styles.paramFooter}>
        <span>{uses === 0 ? 'Not used yet · press fx beside a number to use it' : `Used by ${uses} formula${uses === 1 ? '' : 's'}`}</span>
        <IconButton label="Delete parameter" onClick={() => modelingStore.getState().removeParameter(parameter.id)}>
          <Trash2 size={13} />
        </IconButton>
      </div>
    </div>
  );
}

/** A number that may be left empty (no limit). */
function OptionalNumber({ value, onCommit, ariaLabel }: { value: number | undefined; onCommit: (value: number | undefined) => void; ariaLabel: string }) {
  return (
    <TextField
      value={value === undefined ? '' : String(value)}
      ariaLabel={ariaLabel}
      onCommit={(text) => {
        const trimmed = text.trim();
        if (!trimmed) onCommit(undefined);
        else if (Number.isFinite(Number(trimmed))) onCommit(Number(trimmed));
      }}
    />
  );
}

/** A formula text box that suggests parameter names and shows parse errors while typing. */
function FormulaInput({ value, onCommit, ariaLabel, autoFocus }: { value: string; onCommit: (value: string) => void; ariaLabel: string; autoFocus?: boolean }) {
  const parameters = useModeling((s) => s.parameters);
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  const [editing, setEditing] = useState(false);
  // Escape blurs the input too; the blur must not commit what was being abandoned.
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const listId = useId();
  if (value !== synced) {
    setSynced(value);
    if (!editing) setText(value);
  }
  useEffect(() => {
    if (autoFocus) ref.current?.select();
  }, [autoFocus]);
  let problem: string | null = null;
  try {
    if (text.trim()) parseFormula(text);
  } catch (caught) {
    problem = caught instanceof Error ? caught.message : String(caught);
  }
  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setText(value);
      return;
    }
    if (text !== value) onCommit(text);
  };
  return (
    <>
      <div className={primitiveStyles.inputWrap} data-invalid={problem ? true : undefined}>
        <span className={styles.fxMark} aria-hidden>=</span>
        <input
          ref={ref}
          className={`${primitiveStyles.input} ${styles.fxInput}`}
          value={text}
          list={listId}
          spellCheck={false}
          aria-label={ariaLabel}
          aria-invalid={problem ? true : undefined}
          title={problem ?? 'Numbers, parameter names, + − × ÷ ^, brackets, min max floor ceil round abs sqrt sin cos tan clamp if(…)'}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); }
            event.stopPropagation();
          }}
        />
        <datalist id={listId}>
          {parameters.map((parameter) => <option key={parameter.id} value={parameter.name} />)}
        </datalist>
      </div>
      {problem && <p className={styles.fxError}>{problem}</p>}
    </>
  );
}

export interface ParamNumberProps {
  /** Field path (see parameters.ts `fieldPath`); null gives a plain number field. */
  path: string | null;
  value: number;
  onCommit: (value: number) => void;
  /** Stored value = formula result × scale (a diameter field drives a radius with 0.5). */
  scale?: number;
  unit?: 'mm';
  suffix?: string;
  precision?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * A number field that can be driven by a formula: "fx" turns it into a formula of the asset's
 * parameters (the field then follows them), and clearing the formula frees it again.
 */
export function ParamNumber({ path, value, onCommit, scale, ...field }: ParamNumberProps) {
  const binding = useModeling((s) => (path ? s.bindings[path] : undefined));
  const error = useModeling((s) => (path ? s.parameterErrors[path] : undefined));
  const [justBound, setJustBound] = useState(false);
  if (!path) return <NumberField value={value} onCommit={onCommit} {...field} />;
  const setBinding = (next: Binding | null) => modelingStore.getState().setBinding(path, next);
  if (binding) {
    return (
      <div className={styles.fxField} data-bound>
        <div className={styles.fxRow}>
          <FormulaInput value={binding.expression} autoFocus={justBound} ariaLabel={`${field.ariaLabel ?? 'Value'} formula`} onCommit={(expression) => setBinding(expression.trim() ? { expression, ...(scale !== undefined ? { scale } : {}) } : null)} />
          <button type="button" className={styles.fxButton} data-active title="Free this number from its formula (keeps the current value)" aria-label="Remove formula" onClick={() => setBinding(null)}>
            fx
          </button>
        </div>
        {error ? <p className={styles.fxError}>{error}</p> : <p className={styles.fxValue}>{`= ${Math.round(value * 100) / 100}${field.unit ? ' mm' : (field.suffix ?? '')}`}</p>}
      </div>
    );
  }
  return (
    <div className={styles.fxRow}>
      <NumberField value={value} onCommit={onCommit} {...field} />
      {!field.disabled && (
        <button
          type="button"
          className={styles.fxButton}
          title="Drive this number by a formula of the parameters"
          aria-label={`Drive ${field.ariaLabel ?? 'this number'} by a formula`}
          onClick={() => {
            setJustBound(true);
            // An optional field that is not stored yet (e.g. a transform's move) must exist to be driven.
            onCommit(value);
            const shown = Math.round((value / (scale ?? 1)) * 1000) / 1000;
            setBinding({ expression: String(shown), ...(scale !== undefined ? { scale } : {}) });
          }}
        >
          fx
        </button>
      )}
    </div>
  );
}

export function ParametersPanel() {
  const parameters = useModeling((s) => s.parameters);
  const bindingCount = useModeling((s) => Object.keys(s.bindings).length);
  return (
    <Panel
      title="Parameters"
      defaultOpen={false}
      action={
        <TextButton onClick={() => modelingStore.getState().addParameter()} title="Add a named value to drive sizes, counts and positions">
          <Plus size={12} /> Add
        </TextButton>
      }
    >
      {parameters.length === 0 ? (
        <div className={styles.paramIntro}>
          <SlidersHorizontal size={16} />
          <p className={styles.empty}>
            Name the values that shape this asset (an opening width, a number of bays), then press <strong>fx</strong> beside any size, count or position to drive it by a formula such as <code>panel / bays - 100</code>. Parameters marked editable can be changed on each placed copy on the board.
          </p>
        </div>
      ) : (
        <>
          {parameters.map((parameter) => <ParameterCard key={parameter.id} parameter={parameter} />)}
          <p className={styles.empty}>{bindingCount === 0 ? 'No numbers are driven yet.' : `${bindingCount} number${bindingCount === 1 ? ' is' : 's are'} driven by formulas.`}</p>
        </>
      )}
    </Panel>
  );
}
