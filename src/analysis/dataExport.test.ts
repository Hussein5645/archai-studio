import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { analysisOf } from './model';
import { climateCsv, collectSamples, datasetCsv, quantityOf, summarize, sunTable, toCsv, type Sampler } from './dataExport';

/** A fake analysis: value = x / 1000 on the ground, a roof at 3 m, and a floor at each level. */
function fakeSampler(levels: number[]): Sampler {
  return {
    sample: (spacing, clipTop) => {
      const out: { x: number; y: number; z: number; value: number }[] = [];
      for (let x = 0; x <= 10_000; x += spacing) {
        for (let y = 0; y <= 4_000; y += spacing) {
          const floor = clipTop === null ? (x > 8_000 ? 3000 : 0) : Math.max(0, ...levels.filter((e) => e < clipTop));
          out.push({ x, y, z: floor, value: x / 1000 });
        }
      }
      return out;
    },
  };
}

describe('analysis data', () => {
  it('collects ground, roof and level-floor samples, labelled', () => {
    const app = createTestApp();
    run(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 4_000, name: 'Ground floor' });
    run(app, 'create-level', { x: 0, y: 0, width: 10_000, height: 4_000, name: 'First floor', elevation: 3000 });
    const origin = run<string>(app, 'create-analysis-origin', { kind: 'sun', x: 0, y: 0 });
    run(app, 'update-analysis', { id: origin, patch: { display: 'sun-hours' } });
    const doc = app.store.getState().doc;
    const meta = analysisOf(doc.elements[origin])!;
    const dataset = collectSamples(doc, meta, fakeSampler([0, 3000]), 1000);
    expect(dataset).toMatchObject({ quantity: 'Direct sun hours', unit: 'h', spacing: 1000 });
    const surfaces = new Set(dataset.rows.map((row) => row.surface));
    expect([...surfaces].sort()).toEqual(['First floor', 'Ground', 'Ground floor', 'Roof']);
    const csv = datasetCsv(dataset);
    expect(csv.split('\n')[0]).toBe('x_mm,y_mm,z_mm,surface,Direct sun hours (h)');
    expect(csv).toContain('0,0,0,Ground,0');
  });

  it('summarises per surface and per zone with a threshold share', () => {
    const app = createTestApp();
    const origin = run<string>(app, 'create-analysis-origin', { kind: 'noise', x: 0, y: 0 });
    run(app, 'create-diagram', { kind: 'zone', x: -500, y: -500, width: 3000, height: 5000, patch: { text: 'Quiet garden' } });
    const doc = app.store.getState().doc;
    const meta = analysisOf(doc.elements[origin])!;
    const dataset = collectSamples(doc, meta, fakeSampler([]), 1000);
    const rows = summarize(doc, dataset, 5);
    const ground = rows.find((row) => row.name === 'Ground')!;
    expect(ground).toMatchObject({ kind: 'surface', min: 0, max: 8 });
    // Ground samples at x = 5..8 of 0..8 are at or above 5.
    expect(ground.share).toBeCloseTo(4 / 9, 2);
    const zone = rows.find((row) => row.name === 'Quiet garden')!;
    expect(zone).toMatchObject({ kind: 'zone', min: 0, max: 2, share: 0 });
    expect(quantityOf(meta)).toMatchObject({ unit: 'dB(A)', threshold: 55 });
  });

  it('writes CSV safely and tabulates the sun for a site', () => {
    expect(toCsv(['a', 'b'], [['x, y', 'say "hi"']])).toBe('a,b\n"x, y","say ""hi"""\n');
    const app = createTestApp();
    const origin = run<string>(app, 'create-analysis-origin', { kind: 'sun', x: 0, y: 0 });
    run(app, 'update-analysis', { id: origin, patch: { lat: 51.5, lon: -0.12, utcOffset: 1, date: '2026-06-21' } });
    const doc = app.store.getState().doc;
    const meta = analysisOf(doc.elements[origin])!;
    const table = sunTable(doc, meta, '2026-06-21');
    // London midsummer: about 16 daylight hours, highest near 13:00 BST at ~62°.
    expect(table.length).toBeGreaterThanOrEqual(15);
    const noon = table.reduce((best, row) => (row.altitude > best.altitude ? row : best));
    expect(noon.altitude).toBeGreaterThan(58);
    expect(noon.altitude).toBeLessThan(64);
    expect(['12:00', '13:00']).toContain(noon.time);
    const csv = climateCsv(doc, meta);
    expect(csv).toContain('site,latitude,51.5');
    expect(csv).toContain('sun 2026-12-21');
  });
});

describe('analysis data commands', () => {
  it('needs a running study for grid data, but exports climate data any time', async () => {
    const app = createTestApp();
    const origin = run<string>(app, 'create-analysis-origin', { kind: 'wind', x: 0, y: 0 });
    const grid = await app.executor.dispatch('export-analysis-data', { id: origin, content: 'grid' });
    expect(grid.ok).toBe(false);
    const climate = await app.executor.dispatch('export-analysis-data', { id: origin, content: 'climate' });
    expect(climate.ok).toBe(true);
    expect(app.platform.savedBinaries.at(-1)?.name).toMatch(/climate\.csv$/);
  });

  it('places live charts on a paper and rejects mismatched ones', () => {
    const app = createTestApp();
    const sun = run<string>(app, 'create-analysis-origin', { kind: 'sun', x: 0, y: 0 });
    const paper = run<string>(app, 'create-paper', { x: 20_000, y: 0, scale: 50 });
    const chart = run<string>(app, 'add-analysis-chart', { paperId: paper, originId: sun, chart: 'sun-path' });
    const element = app.store.getState().doc.elements[chart]!;
    expect(element.parentId).toBe(paper);
    expect(element.meta?.['chart']).toMatchObject({ kind: 'sun-path', originId: sun });
    // 90 mm wide at 1:50.
    expect(element.kind === 'rect' && element.width).toBe(4500);
    expect(app.executor.dispatchSync('add-analysis-chart', { paperId: paper, originId: sun, chart: 'wind-rose' }).ok).toBe(false);
    const legend = run<string>(app, 'add-analysis-chart', { paperId: paper, originId: sun, chart: 'legend' });
    // Stacked below the sun path.
    const legendElement = app.store.getState().doc.elements[legend]!;
    expect(legendElement.y).toBeGreaterThan(element.y + (element.kind === 'rect' ? element.height : 0));
  });
});
