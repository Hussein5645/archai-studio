import { describe, expect, it } from 'vitest';
import { daySamples, sunDirection, sunPosition } from './sun';

describe('sunPosition', () => {
  it('matches a reference position (Kyiv area, 2013-03-05 00:00 UTC, sun below horizon)', () => {
    // Reference: azimuth -2.50032 rad from south => 0.64127 rad from north; altitude -0.70004 rad.
    const p = sunPosition(Date.UTC(2013, 2, 5), 50.5, 30.5);
    expect(p.azimuth).toBeCloseTo(-2.5003175907168385 + Math.PI, 3);
    expect(p.altitude).toBeCloseTo(-0.7000406838781611, 3);
  });

  it('puts the noon sun due south and high in a northern summer', () => {
    // London, solar noon ~12:00 UTC on the June solstice.
    const p = sunPosition(Date.UTC(2024, 5, 21, 12, 2), 51.5, 0);
    expect((p.azimuth * 180) / Math.PI).toBeCloseTo(180, 0);
    expect((p.altitude * 180) / Math.PI).toBeCloseTo(62, 0);
    const [x, y, z] = sunDirection(p, 0);
    // South is board-down (+z); the sun is up and to the south.
    expect(y).toBeGreaterThan(0.8);
    expect(z).toBeGreaterThan(0);
    expect(Math.abs(x)).toBeLessThan(0.05);
  });

  it('samples only daylight hours', () => {
    const summer = daySamples('2024-06-21', 1, 51.5, 0, 0);
    const winter = daySamples('2024-12-21', 0, 51.5, 0, 0);
    expect(summer.length).toBeGreaterThan(winter.length);
    expect(winter.length).toBeGreaterThanOrEqual(7);
  });
});
