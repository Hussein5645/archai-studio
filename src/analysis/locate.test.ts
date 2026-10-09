import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { DEFAULT_LOCATION, locationOf } from './model';

describe('locate-project', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves a new map to the device position, but not one the user already moved", async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 30.5, longitude: 47.8 } } as GeolocationPosition) } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const app = createTestApp();
    const map = run<string>(app, 'create-location', { x: 0, y: 0 });
    expect(locationOf(app.store.getState().doc.elements[map])).toMatchObject({ lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon });

    const result = await app.executor.dispatch('locate-project', { id: map, onlyIfDefault: true });
    expect(result.ok).toBe(true);
    expect(locationOf(app.store.getState().doc.elements[map])).toMatchObject({ lat: 30.5, lon: 47.8, mapCenter: { lat: 30.5, lon: 47.8 } });

    run(app, 'update-analysis', { id: map, patch: { lat: 10, lon: 20 } });
    await app.executor.dispatch('locate-project', { id: map, onlyIfDefault: true });
    expect(locationOf(app.store.getState().doc.elements[map])).toMatchObject({ lat: 10, lon: 20 });
  });
});
