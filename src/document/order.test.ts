import { describe, expect, it } from 'vitest';
import { compareIndex, indexAfter, indexBefore, indexBetween, indexesBetween } from './order';

describe('sibling ordering', () => {
  it('compareIndex orders fractional-index keys as plain strings', () => {
    expect(compareIndex('a', 'b')).toBeLessThan(0);
    expect(compareIndex('b', 'a')).toBeGreaterThan(0);
    expect(compareIndex('a', 'a')).toBe(0);
  });

  it('indexAfter/indexBefore/indexBetween keep new keys correctly ordered', () => {
    const first = indexAfter(null);
    const before = indexBefore(first);
    expect(compareIndex(before, first)).toBeLessThan(0);

    const after = indexAfter(first);
    expect(compareIndex(first, after)).toBeLessThan(0);

    const middle = indexBetween(first, after);
    expect(compareIndex(first, middle)).toBeLessThan(0);
    expect(compareIndex(middle, after)).toBeLessThan(0);
  });

  it('indexesBetween generates N keys strictly ordered between two bounds', () => {
    const a = indexAfter(null);
    const b = indexAfter(a);
    const keys = indexesBetween(a, b, 3);
    expect(keys).toHaveLength(3);
    const ordered = [a, ...keys, b];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareIndex(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
    }
  });
});
