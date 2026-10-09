import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { locationOf, MAP_STYLES, mapTileUrls, type MapStyle } from './model';

describe('map view types and tile generation', () => {
  it('defines 7 distinct map styles with labels and descriptions', () => {
    const expectedStyles: MapStyle[] = ['street', 'satellite', 'hybrid', 'topo', 'light', 'dark', 'voyager'];
    expect(MAP_STYLES.map((s) => s.value)).toEqual(expectedStyles);
    for (const style of MAP_STYLES) {
      expect(style.label).toBeTruthy();
      expect(style.description).toBeTruthy();
    }
  });

  it('generates correct tile URLs for each map style', () => {
    const zoom = 15;
    const x = 16372;
    const y = 10896;

    // Street (OpenStreetMap)
    const street = mapTileUrls('street', zoom, x, y);
    expect(street.base).toBe(`https://tile.openstreetmap.org/15/16372/10896.png`);
    expect(street.overlay).toBeUndefined();

    // Satellite (Esri World Imagery: z/y/x)
    const sat = mapTileUrls('satellite', zoom, x, y);
    expect(sat.base).toBe(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/10896/16372`);
    expect(sat.overlay).toBeUndefined();

    // Hybrid (Esri World Imagery + World Boundaries & Places overlay)
    const hybrid = mapTileUrls('hybrid', zoom, x, y);
    expect(hybrid.base).toBe(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/10896/16372`);
    expect(hybrid.overlay).toBe(`https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/15/10896/16372`);

    // Topographic (Esri World Topo Map: z/y/x)
    const topo = mapTileUrls('topo', zoom, x, y);
    expect(topo.base).toBe(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/15/10896/16372`);
    expect(topo.overlay).toBeUndefined();

    // Light (CartoDB Positron: z/x/y)
    const light = mapTileUrls('light', zoom, x, y);
    expect(light.base).toBe(`https://basemaps.cartocdn.com/rastertiles/light_all/15/16372/10896.png`);
    expect(light.overlay).toBeUndefined();

    // Dark (CartoDB Dark Matter: z/x/y)
    const dark = mapTileUrls('dark', zoom, x, y);
    expect(dark.base).toBe(`https://basemaps.cartocdn.com/rastertiles/dark_all/15/16372/10896.png`);
    expect(dark.overlay).toBeUndefined();

    // Voyager (CartoDB Voyager: z/x/y)
    const voyager = mapTileUrls('voyager', zoom, x, y);
    expect(voyager.base).toBe(`https://basemaps.cartocdn.com/rastertiles/voyager/15/16372/10896.png`);
    expect(voyager.overlay).toBeUndefined();

    // Undefined fallback defaults to street
    const fallback = mapTileUrls(undefined, zoom, x, y);
    expect(fallback.base).toBe(`https://tile.openstreetmap.org/15/16372/10896.png`);
  });

  it('updates project location map style and supports undo/redo', async () => {
    const app = createTestApp();
    const locId = run<string>(app, 'create-location');
    let doc = app.store.getState().doc;
    const initialLocation = locationOf(doc.elements[locId]!);
    expect(initialLocation).toBeDefined();

    // Default style (or not yet set) defaults to street in LocationMap
    run(app, 'update-analysis', { id: locId, patch: { mapStyle: 'satellite' } });
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('satellite');

    run(app, 'update-analysis', { id: locId, patch: { mapStyle: 'hybrid' } });
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('hybrid');

    run(app, 'update-analysis', { id: locId, patch: { mapStyle: 'topo' } });
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('topo');

    run(app, 'update-analysis', { id: locId, patch: { mapStyle: 'dark' } });
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('dark');

    // Test undo reverts to topo
    await app.executor.dispatch('undo');
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('topo');

    // Test redo restores dark
    await app.executor.dispatch('redo');
    doc = app.store.getState().doc;
    expect(locationOf(doc.elements[locId]!)?.mapStyle).toBe('dark');
  });
});
