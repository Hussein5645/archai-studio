import { describe, expect, it } from 'vitest';
import { applyParameters, evaluate, liveBindings, readField, resolveParameters, type Parameter, type Recipe } from './parameters';

const param = (name: string, value: number, extra: Partial<Parameter> = {}): Parameter => ({ id: `p-${name}`, name, type: 'length', value, exposed: true, ...extra });

describe('formulas', () => {
  it('follows the usual precedence and functions', () => {
    expect(evaluate('= 2 + 3 * 4 ^ 2', {})).toBe(50);
    expect(evaluate('(panel - bays * w) / (bays + 1)', { panel: 3000, bays: 2, w: 900 })).toBe(400);
    expect(evaluate('floor(L / s) + max(1, -3) - round(2.6)', { L: 1000, s: 300 })).toBe(1);
    expect(evaluate('if(w > 1000 and not flag, 1, 2)', { w: 1200, flag: 0 })).toBe(1);
    expect(evaluate('clamp(x, 0, 10) + cos(60) * 2', { x: 50 })).toBeCloseTo(11);
    expect(evaluate('-w % 7', { w: 15 })).toBe(-1);
  });

  it('explains mistakes', () => {
    expect(() => evaluate('2 +', {})).toThrow('ends too early');
    expect(() => evaluate('width * 2', {})).toThrow('Unknown parameter “width”');
    expect(() => evaluate('4 / (2 - 2)', {})).toThrow('Division by zero');
    expect(() => evaluate('foo(1)', {})).toThrow('Unknown function');
    expect(() => evaluate('2 $ 3', {})).toThrow('Unexpected');
  });
});

describe('parameters', () => {
  it('computes derived parameters in dependency order and honours overrides', () => {
    const parameters = [param('gap', 0, { expression: '(panel - bays * opening) / (bays + 1)' }), param('panel', 3000), param('bays', 2, { type: 'count' }), param('opening', 900)];
    expect(resolveParameters(parameters).values['gap']).toBe(400);
    expect(resolveParameters(parameters, { opening: 600 }).values['gap']).toBe(600);
  });

  it('clamps, rounds counts and reports cycles', () => {
    const resolved = resolveParameters([param('a', 0, { expression: 'b + 1' }), param('b', 0, { expression: 'a + 1' }), param('n', 2.6, { type: 'count', min: 1, max: 10 })], { n: 40 });
    expect(resolved.values['n']).toBe(10);
    expect(resolved.errors['p-a']).toMatch(/depends on itself/);
  });
});

describe('bindings', () => {
  const recipe = (): Recipe => ({
    bodies: [
      { id: 'b1', name: 'Panel', visible: true, lowLod: false, material: 'm', placement: { position: [0, 0, 0], rotation: [0, 0, 0] }, features: [{ kind: 'primitive', id: 'f1', shape: 'box', size: [3000, 2000, 200], placement: { position: [0, 0, 0], rotation: [0, 0, 0] } }, { kind: 'pattern', id: 'f2', mode: 'linear', count: 3, step: [1000, 0, 0] }] },
      { id: 'b2', name: 'Other', visible: true, lowLod: false, material: 'm', placement: { position: [0, 0, 0], rotation: [0, 0, 0] }, features: [] },
    ],
    sketches: [{ id: 's1', name: 'S', visible: true, plane: { kind: 'plane', id: 'front', offset: 0 }, shapes: [{ id: 'r1', kind: 'rect', x: 0, y: 0, width: 900, height: 1200 }, { id: 'c1', kind: 'circle', cx: 0, cy: 0, radius: 100 }] }],
  });

  it('writes formula results into the bound fields and keeps untouched objects', () => {
    const before = recipe();
    const driven = applyParameters(before, [param('opening', 600), param('bays', 4, { type: 'count' })], {
      'feature/b1/f1/size/0': { expression: 'bays * (opening + 300) + 300' },
      'feature/b1/f2/count': { expression: 'bays + 0.4' },
      'feature/b1/f2/step/0': { expression: 'opening + 300' },
      'shape/s1/r1/width': { expression: 'opening' },
      'shape/s1/c1/radius': { expression: 'opening', scale: 0.5 },
    });
    expect(Object.keys(driven.errors)).toEqual([]);
    expect(readField(driven, 'feature/b1/f1/size/0')).toBe(3900);
    expect(readField(driven, 'feature/b1/f2/count')).toBe(4);
    expect(readField(driven, 'feature/b1/f2/step/0')).toBe(900);
    expect(readField(driven, 'shape/s1/r1/width')).toBe(600);
    expect(readField(driven, 'shape/s1/c1/radius')).toBe(300);
    expect(driven.bodies[1]).toBe(before.bodies[1]);
    expect(readField(before, 'feature/b1/f1/size/0')).toBe(3000);
  });

  it('keeps the old value and reports a failing formula, and drops bindings to deleted targets', () => {
    const driven = applyParameters(recipe(), [], { 'shape/s1/r1/width': { expression: 'missing * 2' }, 'shape/s1/gone/width': { expression: '1' } });
    expect(readField(driven, 'shape/s1/r1/width')).toBe(900);
    expect(driven.errors['shape/s1/r1/width']).toMatch(/Unknown parameter/);
    expect(Object.keys(liveBindings(recipe(), { 'shape/s1/r1/width': { expression: '1' }, 'shape/s1/gone/width': { expression: '1' } }))).toEqual(['shape/s1/r1/width']);
  });
});
