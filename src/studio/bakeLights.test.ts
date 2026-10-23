import { expect, it } from 'vitest';
import { RenderLightSchema } from '@shared/renderLights';
import { traceBake } from './bakeTrace';

it('bakes local light color and shadows, and excludes disabled lights', () => {
  const input = {
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 1, 0]),
    triangles: new Float32Array(),
    albedos: new Float32Array(3),
    emission: new Float32Array(3),
    sun: [0, 1, 0] as [number, number, number],
    sunIntensity: 0,
    skyIntensity: 0,
    environment: null,
    samples: 1,
    bounces: 0,
  };
  const light = RenderLightSchema.parse({
    id: 'local',
    name: 'Red',
    kind: 'point',
    position: [0, 2, 0],
    color: '#ff0000',
  });
  const lit = traceBake({ ...input, lights: [light] });
  expect(lit[0]).toBeGreaterThan(0);
  expect(lit[1]).toBe(0);
  expect(traceBake({ ...input, lights: [{ ...light, enabled: false }] })[0]).toBe(0);
  const blocked = traceBake({
    ...input,
    lights: [light],
    triangles: new Float32Array([-10, 1, -10, 10, 1, -10, 0, 1, 10]),
  });
  expect(blocked[0]).toBe(0);
});
