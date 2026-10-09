/**
 * Stable, prefixed, URL-safe ids. The generator is injectable so tests and replayed command
 * logs can be fully deterministic.
 */
export type IdPrefix = 'doc' | 'el' | 'def' | 'blob' | 'hist' | 'tmpl' | 'mat';

export interface IdSource {
  next(prefix: IdPrefix): string;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const randomIds: IdSource = {
  next: (prefix) => `${prefix}_${randomBase36(12)}`,
};

/** Sequential ids (`el_1`, `el_2`, …) for tests and deterministic replays. */
export function sequentialIds(): IdSource {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
}
