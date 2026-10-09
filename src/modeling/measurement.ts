/** Global, tool-independent parsing for the modeling Measurements field. */
export type MeasurementValue =
  | { kind: 'length'; value: number }
  | { kind: 'pair'; width: number; height: number }
  | { kind: 'angle'; value: number }
  | { kind: 'radius'; value: number }
  | { kind: 'diameter'; value: number }
  | { kind: 'array'; count: number }
  | { kind: 'division'; count: number };

const LENGTH_UNITS: Record<string, number> = { '': 1, mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

function length(text: string): number | null {
  const match = text.trim().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|m|in|ft)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const scale = LENGTH_UNITS[(match[2] ?? '').toLowerCase()];
  return Number.isFinite(value) && scale !== undefined ? value * scale : null;
}

/** Parses lengths, pairs, angles, radius/diameter, and copy-array expressions. */
export function parseMeasurement(text: string): MeasurementValue | null {
  const input = text.trim().toLowerCase().replace(/×/g, 'x').replace(/ø|⌀/g, 'd');
  if (!input) return null;
  const array = input.match(/^x\s*(\d+)$/);
  if (array) return Number(array[1]) > 0 ? { kind: 'array', count: Number(array[1]) } : null;
  const division = input.match(/^\/\s*(\d+)$/);
  if (division) return Number(division[1]) > 0 ? { kind: 'division', count: Number(division[1]) } : null;
  const angle = input.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:°|deg)$/);
  if (angle) return { kind: 'angle', value: Number(angle[1]) };
  const radial = input.match(/^([rd])\s*(.+)$/);
  if (radial) {
    const value = length(radial[2]!);
    if (value === null) return null;
    return radial[1] === 'r' ? { kind: 'radius', value } : { kind: 'diameter', value };
  }
  const pair = input.split(/\s*(?:,|;|x)\s*/);
  if (pair.length === 2) {
    const width = length(pair[0]!);
    const height = length(pair[1]!);
    return width !== null && height !== null ? { kind: 'pair', width, height } : null;
  }
  const value = length(input);
  return value === null ? null : { kind: 'length', value };
}

/** Compatibility helper for sketch tools that expect one or two millimetre values. */
export function parseDimensions(text: string): number[] | null {
  const parsed = parseMeasurement(text);
  if (!parsed) return null;
  if (parsed.kind === 'pair') return [parsed.width, parsed.height];
  if (parsed.kind === 'length' || parsed.kind === 'radius' || parsed.kind === 'diameter') return [parsed.value];
  return null;
}

export function measurementPlaceholder(tool: string): string {
  if (tool === 'rect') return 'width,height';
  if (tool === 'circle' || tool === 'polygon') return 'radius';
  if (tool === 'revolve') return 'angle';
  if (tool === 'pattern') return 'distance, xN, /N';
  return 'distance';
}
