/**
 * Parametric design for modeled assets: named parameters, formulas, and bindings that drive any
 * number in the recipe (a feature's distance, a primitive's size, a sketch rectangle's width, a
 * pattern's count and step, a body's position...).
 *
 * The recipe stays plain numbers: bindings are applied by writing their results into the bound
 * fields (see `applyParameters`), so the kernel, the viewport and packaging need no changes, and
 * a placed `.CAI` is re-driven the same way with other parameter values (see ./recipe.ts).
 *
 * Formulas are parsed here (no `eval`): numbers, parameter names, + − × ÷ ^ %, brackets,
 * comparisons (true = 1), `and` / `or` / `not`, and min, max, floor, ceil, round, abs, sqrt,
 * sin / cos / tan (degrees), clamp(x, lo, hi) and if(condition, then, else).
 */
import type { Body, Sketch } from './kernel/types';

export type ParameterType = 'length' | 'angle' | 'count' | 'number' | 'boolean';

export interface Parameter {
  id: string;
  /** Identifier used in formulas: letters, digits and _, not starting with a digit. */
  name: string;
  type: ParameterType;
  /** The value of an input parameter (booleans are 1 / 0). */
  value: number;
  /** A derived parameter is computed from others instead of typed. */
  expression?: string;
  min?: number;
  max?: number;
  /** Shown on placed instances: editable on the board and in parametric graphs. */
  exposed: boolean;
  /** Optional help text shown with the parameter. */
  description?: string;
}

/**
 * A formula driving one number of the recipe. `path` addresses the field (see `fieldPath`), the
 * result is multiplied by `scale` (a circle's diameter field drives its radius with 0.5).
 */
export interface Binding {
  expression: string;
  scale?: number;
}

export type Bindings = Record<string, Binding>;

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['pi', 'true', 'false', 'and', 'or', 'not', 'min', 'max', 'floor', 'ceil', 'round', 'abs', 'sqrt', 'sin', 'cos', 'tan', 'clamp', 'if']);

export function validParameterName(name: string): boolean {
  return NAME_PATTERN.test(name) && !RESERVED.has(name.toLowerCase());
}

// ---- formulas ------------------------------------------------------------------------------------

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string } | { kind: 'end' };

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'unary'; op: string; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

export class FormulaError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    const op = /^(<=|>=|==|!=|&&|\|\||[-+*/^%(),<>!×÷])/.exec(source.slice(i));
    if (!op) throw new FormulaError(`Unexpected “${c}”`);
    tokens.push({ kind: 'op', value: op[0] === '×' ? '*' : op[0] === '÷' ? '/' : op[0] });
    i += op[0].length;
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

/** Parses a formula; a leading "=" is allowed. Throws FormulaError with a readable message. */
export function parseFormula(source: string): Node {
  const tokens = tokenize(source.trim().replace(/^=/, ''));
  let position = 0;
  const peek = () => tokens[position]!;
  const isOp = (value: string) => peek().kind === 'op' && (peek() as { value: string }).value === value;
  const isWord = (value: string) => peek().kind === 'name' && (peek() as { value: string }).value.toLowerCase() === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new FormulaError(`Expected “${value}”`);
    position++;
  };
  const binaryLevel = (next: () => Node, ops: string[], words: Record<string, string> = {}) => (): Node => {
    let left = next();
    for (;;) {
      const token = peek();
      const word = token.kind === 'name' ? words[token.value.toLowerCase()] : undefined;
      const op = token.kind === 'op' && ops.includes(token.value) ? token.value : word;
      if (!op) return left;
      position++;
      left = { kind: 'binary', op, left, right: next() };
    }
  };
  const primary = (): Node => {
    const token = peek();
    if (token.kind === 'number') { position++; return { kind: 'number', value: token.value }; }
    if (token.kind === 'name') {
      position++;
      if (isOp('(')) {
        position++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) { position++; args.push(or()); }
        }
        expect(')');
        return { kind: 'call', name: token.value.toLowerCase(), args };
      }
      return { kind: 'name', name: token.value };
    }
    if (isOp('(')) {
      position++;
      const inner = or();
      expect(')');
      return inner;
    }
    throw new FormulaError(token.kind === 'end' ? 'The formula ends too early' : `Unexpected “${(token as { value: string | number }).value}”`);
  };
  const power = (): Node => {
    const base = primary();
    if (isOp('^')) { position++; return { kind: 'binary', op: '^', left: base, right: unary() }; }
    return base;
  };
  const unary = (): Node => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = (peek() as { value: string }).value;
      position++;
      return { kind: 'unary', op, arg: unary() };
    }
    if (isWord('not')) { position++; return { kind: 'unary', op: '!', arg: unary() }; }
    return power();
  };
  const product = binaryLevel(unary, ['*', '/', '%']);
  const sum = binaryLevel(product, ['+', '-']);
  const compare = binaryLevel(sum, ['<', '>', '<=', '>=', '==', '!=']);
  const and = binaryLevel(compare, ['&&'], { and: '&&' });
  const or: () => Node = binaryLevel(and, ['||'], { or: '||' });
  const tree = or();
  if (peek().kind !== 'end') throw new FormulaError(`Unexpected “${(peek() as { value: string | number }).value}”`);
  return tree;
}

/** The parameter names a formula reads. */
export function formulaNames(node: Node, into = new Set<string>()): Set<string> {
  if (node.kind === 'name') into.add(node.name);
  else if (node.kind === 'unary') formulaNames(node.arg, into);
  else if (node.kind === 'binary') { formulaNames(node.left, into); formulaNames(node.right, into); }
  else if (node.kind === 'call') for (const arg of node.args) formulaNames(arg, into);
  return into;
}

const RAD = Math.PI / 180;
const FUNCTIONS: Record<string, { arity: [number, number]; run: (...args: number[]) => number }> = {
  min: { arity: [1, 64], run: Math.min },
  max: { arity: [1, 64], run: Math.max },
  floor: { arity: [1, 1], run: Math.floor },
  ceil: { arity: [1, 1], run: Math.ceil },
  round: { arity: [1, 1], run: Math.round },
  abs: { arity: [1, 1], run: Math.abs },
  sqrt: { arity: [1, 1], run: Math.sqrt },
  sin: { arity: [1, 1], run: (a) => Math.sin(a * RAD) },
  cos: { arity: [1, 1], run: (a) => Math.cos(a * RAD) },
  tan: { arity: [1, 1], run: (a) => Math.tan(a * RAD) },
  clamp: { arity: [3, 3], run: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
};

export function evaluateFormula(node: Node, scope: (name: string) => number | undefined): number {
  const run = (n: Node): number => {
    switch (n.kind) {
      case 'number':
        return n.value;
      case 'name': {
        const lower = n.name.toLowerCase();
        if (lower === 'pi') return Math.PI;
        if (lower === 'true') return 1;
        if (lower === 'false') return 0;
        const value = scope(n.name);
        if (value === undefined) throw new FormulaError(`Unknown parameter “${n.name}”`);
        return value;
      }
      case 'unary': {
        const value = run(n.arg);
        return n.op === '-' ? -value : n.op === '!' ? (value ? 0 : 1) : value;
      }
      case 'binary': {
        if (n.op === '&&') return run(n.left) && run(n.right) ? 1 : 0;
        if (n.op === '||') return run(n.left) || run(n.right) ? 1 : 0;
        const a = run(n.left), b = run(n.right);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/':
            if (b === 0) throw new FormulaError('Division by zero');
            return a / b;
          case '%':
            if (b === 0) throw new FormulaError('Division by zero');
            return a % b;
          case '^': return a ** b;
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return Math.abs(a - b) < 1e-9 ? 1 : 0;
          case '!=': return Math.abs(a - b) >= 1e-9 ? 1 : 0;
        }
        throw new FormulaError(`Unknown operator ${n.op}`);
      }
      case 'call': {
        if (n.name === 'if') {
          if (n.args.length !== 3) throw new FormulaError('if(condition, then, else) takes 3 values');
          return run(n.args[0]!) ? run(n.args[1]!) : run(n.args[2]!);
        }
        const fn = FUNCTIONS[n.name];
        if (!fn) throw new FormulaError(`Unknown function “${n.name}”`);
        if (n.args.length < fn.arity[0] || n.args.length > fn.arity[1]) throw new FormulaError(`${n.name}() takes ${fn.arity[0] === fn.arity[1] ? fn.arity[0] : `${fn.arity[0]}+`} value${fn.arity[1] === 1 ? '' : 's'}`);
        return fn.run(...n.args.map(run));
      }
    }
  };
  const value = run(node);
  if (!Number.isFinite(value)) throw new FormulaError('The result is not a finite number');
  return value;
}

/** Evaluates a formula source against named values; throws FormulaError. */
export function evaluate(source: string, values: Readonly<Record<string, number>>): number {
  return evaluateFormula(parseFormula(source), (name) => values[name]);
}

// ---- parameters ------------------------------------------------------------------------------------

export interface ResolvedParameters {
  /** Every parameter's value by name (derived ones computed; failures left out). */
  values: Record<string, number>;
  /** Messages by parameter id. */
  errors: Record<string, string>;
}

function clampParameter(parameter: Parameter, value: number): number {
  let next = Math.min(parameter.max ?? Infinity, Math.max(parameter.min ?? -Infinity, value));
  if (parameter.type === 'count') next = Math.round(next);
  if (parameter.type === 'boolean') next = next ? 1 : 0;
  return next;
}

/**
 * Values of all parameters: inputs from their values (or `overrides` by name, as a placed
 * instance does), derived ones from their formulas in dependency order. Cycles are reported.
 */
export function resolveParameters(parameters: readonly Parameter[], overrides: Readonly<Record<string, number>> = {}): ResolvedParameters {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (parameter: Parameter): number | undefined => {
    if (state.get(parameter.name) === 'done') return values[parameter.name];
    if (state.get(parameter.name) === 'visiting') throw new FormulaError(`“${parameter.name}” depends on itself`);
    state.set(parameter.name, 'visiting');
    try {
      if (!parameter.expression) {
        const override = overrides[parameter.name];
        values[parameter.name] = clampParameter(parameter, typeof override === 'number' && Number.isFinite(override) ? override : parameter.value);
      } else {
        const tree = parseFormula(parameter.expression);
        values[parameter.name] = clampParameter(parameter, evaluateFormula(tree, (name) => {
          const other = byName.get(name);
          if (!other) return undefined;
          const value = visit(other);
          // A parameter this one reads failed: pass its reason on (a cycle names its start).
          if (value === undefined) throw new FormulaError(errors[other.id] ?? `“${name}” has an error`);
          return value;
        }));
      }
    } catch (error) {
      errors[parameter.id] ??= error instanceof Error ? error.message : String(error);
      state.set(parameter.name, 'done');
      return undefined;
    }
    state.set(parameter.name, 'done');
    return values[parameter.name];
  };
  for (const parameter of parameters) {
    try {
      visit(parameter);
    } catch (error) {
      errors[parameter.id] ??= error instanceof Error ? error.message : String(error);
    }
  }
  return { values, errors };
}

// ---- field paths ---------------------------------------------------------------------------------

/**
 * Where a bound number lives:
 * - `body/<bodyId>/<field…>` for a body (e.g. `placement/position/0`),
 * - `feature/<bodyId>/<featureId>/<field…>` for a feature (e.g. `distance`, `size/1`, `step/0`),
 * - `sketch/<sketchId>/<field…>` for a sketch (e.g. `cornerRadius`),
 * - `shape/<sketchId>/<shapeId>/<field…>` for a sketch shape (e.g. `width`, `points/2/0`).
 */
export function fieldPath(...parts: (string | number)[]): string {
  return parts.join('/');
}

type Json = unknown;

function getIn(target: Json, keys: readonly string[]): unknown {
  let current: unknown = target;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A copy of `target` with the number at `keys` replaced (untouched branches are shared). */
function setIn<T>(target: T, keys: readonly string[], value: number): T {
  if (keys.length === 0) return value as T;
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(target)) {
    const copy = [...target];
    copy[Number(key)] = setIn(copy[Number(key)], rest, value);
    return copy as T;
  }
  const record = (target ?? {}) as Record<string, unknown>;
  return { ...record, [key]: setIn(record[key], rest, value) } as T;
}

export interface Recipe {
  bodies: Body[];
  sketches: Sketch[];
}

/** Reads the number a path points at (undefined when the target is gone). */
export function readField(recipe: Recipe, path: string): number | undefined {
  const [scope, ...rest] = path.split('/');
  let value: unknown;
  if (scope === 'body') value = getIn(recipe.bodies.find((body) => body.id === rest[0]), rest.slice(1));
  else if (scope === 'feature') value = getIn(recipe.bodies.find((body) => body.id === rest[0])?.features.find((feature) => feature.id === rest[1]), rest.slice(2));
  else if (scope === 'sketch') value = getIn(recipe.sketches.find((sketch) => sketch.id === rest[0]), rest.slice(1));
  else if (scope === 'shape') value = getIn(recipe.sketches.find((sketch) => sketch.id === rest[0])?.shapes.find((shape) => shape.id === rest[1]), rest.slice(2));
  return typeof value === 'number' ? value : undefined;
}

function writeField(recipe: Recipe, path: string, value: number): Recipe {
  const [scope, ...rest] = path.split('/');
  if (scope === 'body' || scope === 'feature') {
    return {
      ...recipe,
      bodies: recipe.bodies.map((body) => {
        if (body.id !== rest[0]) return body;
        if (scope === 'body') return setIn(body, rest.slice(1), value);
        return { ...body, features: body.features.map((feature) => (feature.id === rest[1] ? setIn(feature, rest.slice(2), value) : feature)) };
      }),
    };
  }
  return {
    ...recipe,
    sketches: recipe.sketches.map((sketch) => {
      if (sketch.id !== rest[0]) return sketch;
      if (scope === 'sketch') return setIn(sketch, rest.slice(1), value);
      return { ...sketch, shapes: sketch.shapes.map((shape) => (shape.id === rest[1] ? setIn(shape, rest.slice(2), value) : shape)) };
    }),
  };
}

/** Whole numbers where the recipe needs them. */
function integerField(path: string): boolean {
  return /\/(count|sides|segments)$/.test(path);
}

export interface Driven extends Recipe {
  /** Messages by parameter id or binding path. */
  errors: Record<string, string>;
  values: Record<string, number>;
}

/**
 * Applies parameters and bindings to a recipe: every bound field gets its formula's result.
 * Unchanged bodies and sketches keep their identity (so only what changed re-evaluates).
 * Bindings whose target no longer exists are ignored.
 */
export function applyParameters(recipe: Recipe, parameters: readonly Parameter[], bindings: Bindings, overrides: Readonly<Record<string, number>> = {}): Driven {
  const { values, errors } = resolveParameters(parameters, overrides);
  let next = recipe;
  for (const [path, binding] of Object.entries(bindings)) {
    const current = readField(next, path);
    if (current === undefined) continue;
    let value: number;
    try {
      value = evaluate(binding.expression, values) * (binding.scale ?? 1);
    } catch (error) {
      errors[path] = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (integerField(path)) value = Math.max(1, Math.round(value));
    if (Math.abs(value - current) > 1e-9) next = writeField(next, path, value);
  }
  return { ...next, errors, values };
}

/** Bindings that still point at something, after a body / feature / sketch / shape was deleted. */
export function liveBindings(recipe: Recipe, bindings: Bindings): Bindings {
  return Object.fromEntries(Object.entries(bindings).filter(([path]) => readField(recipe, path) !== undefined));
}

/** A formula with one parameter name replaced (whole names only). */
export function renameInFormula(source: string, from: string, to: string): string {
  return source.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word, offset: number, whole: string) => {
    // Digits right before a name belong to a number (e.g. 1e3), not to a name.
    const before = whole[offset - 1];
    return word === from && !(before && /[0-9.]/.test(before)) ? to : word;
  });
}

/** A fresh, unused parameter name like `width2`. */
export function uniqueParameterName(parameters: readonly Parameter[], base = 'param'): string {
  const taken = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`.toLowerCase())) return `${base}${n}`;
}
