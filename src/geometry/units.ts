import type { Unit } from '@/document';

export const MM_PER_UNIT: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export const toDisplayUnit = (mm: number, unit: Unit): number => mm / MM_PER_UNIT[unit];
export const fromDisplayUnit = (value: number, unit: Unit): number => value * MM_PER_UNIT[unit];

export function formatLength(mm: number, unit: Unit, precision: number, withUnit = true): string {
  const value = toDisplayUnit(mm, unit).toFixed(precision);
  return withUnit ? `${value} ${unit}` : value;
}

/** Parses a user-entered length such as "1.2", "1.2m", "350 mm", "2'" in the given default unit. */
export function parseLength(input: string, defaultUnit: Unit): number | null {
  const match = /^\s*(-?\d*\.?\d+)\s*(mm|cm|m|in|ft|"|')?\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toLowerCase();
  const unit: Unit = suffix === '"' ? 'in' : suffix === "'" ? 'ft' : ((suffix as Unit | undefined) ?? defaultUnit);
  return fromDisplayUnit(value, unit);
}
