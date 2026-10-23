import { expect, it } from 'vitest';
import { cameraKey, parseCamera } from './camera';

it('restores valid render cameras and ignores corrupt or unbounded values', () => {
  const camera = { position: [1000, 2000, 3000], target: [0, 0, 0], fov: 55 };
  expect(parseCamera(JSON.stringify(camera))).toEqual(camera);
  expect(parseCamera('invalid')).toBeNull();
  expect(parseCamera(JSON.stringify({ ...camera, fov: 200 }))).toBeNull();
  expect(parseCamera(null)).toBeNull();
  expect(cameraKey('one')).not.toBe(cameraKey('two'));
});
