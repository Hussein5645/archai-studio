/**
 * Sibling ordering uses fractional indexes: reordering one element changes one key, and there
 * is no parallel `children[]` array to keep in sync with the element table.
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export const indexBetween = (a: string | null, b: string | null): string => generateKeyBetween(a, b);
export const indexAfter = (a: string | null): string => generateKeyBetween(a, null);
export const indexBefore = (b: string | null): string => generateKeyBetween(null, b);
export const indexesBetween = (a: string | null, b: string | null, n: number): string[] =>
  generateNKeysBetween(a, b, n);

export function compareIndex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
