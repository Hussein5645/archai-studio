import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from './create';
import { sequentialIds } from './ids';
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  elementsInRenderOrder,
  getElement,
  isAncestor,
  isEffectivelyLocked,
  isEffectivelyVisible,
  isGroup,
  lastIndexAmong,
  requireElement,
  topLevelAncestor,
  type ElementTable,
} from './query';
import type { ArchaiDocument, Element, GroupElement, RectElement } from './schema';

function rect(id: string, overrides: Partial<RectElement> = {}): RectElement {
  return {
    kind: 'rect',
    id,
    parentId: null,
    index: 'a0',
    x: 0,
    y: 0,
    rotation: 0,
    visible: true,
    locked: false,
    width: 100,
    height: 100,
    radius: 0,
    style: { fill: '#ffffff', stroke: '#000000', strokeWidth: 1, opacity: 1 },
    ...overrides,
  };
}

function group(id: string, overrides: Partial<GroupElement> = {}): GroupElement {
  return { kind: 'group', id, parentId: null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, ...overrides };
}

function table(...elements: Element[]): ElementTable {
  return Object.fromEntries(elements.map((e) => [e.id, e]));
}

describe('document query helpers', () => {
  it('childrenOf returns root or nested children sorted by index', () => {
    const p = group('p', { index: 'a' });
    const a = rect('a', { parentId: 'p', index: 'a' });
    const c = rect('c', { parentId: 'p', index: 'b' });
    const elements = table(p, a, c);
    expect(childrenOf(elements, null).map((e) => e.id)).toEqual(['p']);
    expect(childrenOf(elements, 'p').map((e) => e.id)).toEqual(['a', 'c']);
    expect(childrenOf(elements, 'missing')).toEqual([]);
  });

  it('ancestorsOf walks up to the root and stops instead of looping on a cycle', () => {
    const grandparent = group('gp', { index: 'a' });
    const parent = group('p', { parentId: 'gp', index: 'a' });
    const child = rect('c', { parentId: 'p', index: 'a' });
    const elements = table(grandparent, parent, child);
    expect(ancestorsOf(elements, 'c').map((e) => e.id)).toEqual(['p', 'gp']);
    expect(ancestorsOf(elements, 'gp')).toEqual([]);

    const a = group('a', { parentId: 'b', index: 'a' });
    const b = group('b', { parentId: 'a', index: 'a' });
    const cyclic = table(a, b);
    expect(() => ancestorsOf(cyclic, 'a')).not.toThrow();
    expect(ancestorsOf(cyclic, 'a').length).toBeLessThanOrEqual(2);
  });

  it('topLevelAncestor finds the root element containing a nested one, or itself at the root', () => {
    const root = group('root', { index: 'a' });
    const child = rect('c', { parentId: 'root', index: 'a' });
    const elements = table(root, child);
    expect(topLevelAncestor(elements, 'c')?.id).toBe('root');
    expect(topLevelAncestor(elements, 'root')?.id).toBe('root');
  });

  it('descendantsOf lists every nested element, depth-first back-to-front', () => {
    const root = group('root', { index: 'a' });
    const first = rect('first', { parentId: 'root', index: 'a' });
    const second = group('second', { parentId: 'root', index: 'b' });
    const grandchild = rect('grandchild', { parentId: 'second', index: 'a' });
    const elements = table(root, first, second, grandchild);
    expect(descendantsOf(elements, 'root').map((e) => e.id)).toEqual(['first', 'second', 'grandchild']);
  });

  it('isAncestor reports whether one element contains another', () => {
    const root = group('root', { index: 'a' });
    const child = rect('c', { parentId: 'root', index: 'a' });
    const elements = table(root, child);
    expect(isAncestor(elements, 'root', 'c')).toBe(true);
    expect(isAncestor(elements, 'c', 'root')).toBe(false);
  });

  it('isEffectivelyVisible and isEffectivelyLocked fold in ancestor state', () => {
    const hiddenParent = group('hp', { index: 'a', visible: false });
    const visibleChild = rect('vc', { parentId: 'hp', index: 'a' });
    const lockedParent = group('lp', { index: 'b', locked: true });
    const unlockedChild = rect('uc', { parentId: 'lp', index: 'a' });
    const plain = rect('plain', { index: 'c' });
    const elements = table(hiddenParent, visibleChild, lockedParent, unlockedChild, plain);

    expect(isEffectivelyVisible(elements, 'vc')).toBe(false);
    expect(isEffectivelyVisible(elements, 'plain')).toBe(true);
    expect(isEffectivelyVisible(elements, 'missing')).toBe(false);

    expect(isEffectivelyLocked(elements, 'uc')).toBe(true);
    expect(isEffectivelyLocked(elements, 'plain')).toBe(false);
    expect(isEffectivelyLocked(elements, 'missing')).toBe(false);
  });

  it('elementsInRenderOrder lists roots before their descendants, in sibling order', () => {
    const a = rect('a', { index: 'a' });
    const b = group('b', { index: 'b' });
    const bChild = rect('bChild', { parentId: 'b', index: 'a' });
    const elements = table(a, b, bChild);
    expect(elementsInRenderOrder(elements).map((e) => e.id)).toEqual(['a', 'b', 'bChild']);
  });

  it('getElement, requireElement and isGroup', () => {
    const doc: ArchaiDocument = {
      ...createEmptyDocument({ ids: sequentialIds(), now: () => '2026-01-01T00:00:00.000Z' }),
      elements: table(rect('r'), group('g')),
    };
    expect(getElement(doc, 'r')?.id).toBe('r');
    expect(getElement(doc, 'missing')).toBeUndefined();
    expect(requireElement(doc, 'r').id).toBe('r');
    expect(() => requireElement(doc, 'missing')).toThrow(/Unknown element/);
    expect(isGroup(requireElement(doc, 'g'))).toBe(true);
    expect(isGroup(requireElement(doc, 'r'))).toBe(false);
  });

  it('lastIndexAmong returns the back-most sibling index, or null when there are none', () => {
    const a = rect('a', { index: 'a' });
    const b = rect('b', { index: 'b' });
    const elements = table(a, b);
    expect(lastIndexAmong(elements, null)).toBe('b');
    expect(lastIndexAmong(elements, 'no-such-parent')).toBeNull();
  });
});
