import { describe, expect, it } from 'vitest';
import { parseDimensions, parseMeasurement } from './measurement';

describe('MeasurementInputService parser', () => {
  it('parses lengths and unit suffixes in millimetres', () => {
    expect(parseMeasurement('1.2m')).toEqual({ kind: 'length', value: 1200 });
    expect(parseMeasurement('4in')).toEqual({ kind: 'length', value: 101.6 });
    expect(parseMeasurement('-25')).toEqual({ kind: 'length', value: -25 });
  });

  it('parses dimension pairs and radial values', () => {
    expect(parseMeasurement('1200,800')).toEqual({ kind: 'pair', width: 1200, height: 800 });
    expect(parseDimensions('120cm x 0.8m')).toEqual([1200, 800]);
    expect(parseMeasurement('R25')).toEqual({ kind: 'radius', value: 25 });
    expect(parseMeasurement('⌀50')).toEqual({ kind: 'diameter', value: 50 });
  });

  it('parses angles, arrays, and divided spacing', () => {
    expect(parseMeasurement('45deg')).toEqual({ kind: 'angle', value: 45 });
    expect(parseMeasurement('x5')).toEqual({ kind: 'array', count: 5 });
    expect(parseMeasurement('/5')).toEqual({ kind: 'division', count: 5 });
  });
});
