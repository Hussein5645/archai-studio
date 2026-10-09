import DxfParser from 'dxf-parser';
import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { dxfLineweight, svgToCad, writeDxf, type CadPrimitive, type VNode } from './dxf';
import { apply, flattenPath, parseTransform } from './svgGeometry';

/** A fixture node: attributes double as inlined styles, like compose.ts output. */
function n(tag: string, attrs: Record<string, string | number> = {}, children: VNode[] = [], text = ''): VNode {
  return {
    tag,
    attr: (name) => (name in attrs ? String(attrs[name]) : null),
    style: (name) => (name in attrs ? String(attrs[name]) : ''),
    children,
    text: text || children.map((child) => child.text).join(''),
  };
}

describe('svg geometry', () => {
  it('parses transform lists in SVG order', () => {
    const m = parseTransform('translate(100 50) rotate(90) scale(2)');
    const [x, y] = apply(m, 10, 0);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(70);
    expect(apply(parseTransform('matrix(1 0 0 1 5 6)'), 1, 1)).toEqual([6, 7]);
  });

  it('flattens paths with relative commands, curves, arcs and closes', () => {
    const [square] = flattenPath('M0 0 h10 v10 H0 z');
    expect(square).toEqual({ points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true });
    const [curve] = flattenPath('M0 0 C0 10 10 10 10 0');
    expect(curve!.points.at(-1)).toEqual([10, 0]);
    expect(curve!.points.length).toBeGreaterThan(8);
    const [arc] = flattenPath('M0 0 A5 5 0 0 1 10 0');
    // A half circle above or below the chord, ending exactly at the end point.
    expect(arc!.points.at(-1)).toEqual([10, 0]);
    expect(Math.max(...arc!.points.map(([, y]) => Math.abs(y)))).toBeCloseTo(5, 0);
    expect(flattenPath('M0 0 L5 5 M10 10 l1 1')).toHaveLength(2);
  });
});

describe('svg to CAD', () => {
  function docWithWall() {
    const app = createTestApp();
    const [wall] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]], type: 'wall', parentId: null });
    const paper = run<string>(app, 'create-paper', { x: 10_000, y: 0, size: 'A4', scale: 100 });
    return { doc: app.store.getState().doc, wall: wall!, paper };
  }

  it('maps a sheet to paper millimetres, y up, with layers and printed lineweights', () => {
    const { doc, wall, paper } = docWithWall();
    const root = n('svg', {}, [
      n('g', { 'data-element-id': wall, transform: 'matrix(1 0 0 1 11000 1000)' }, [n('rect', { x: 0, y: 0, width: 4000, height: 200, stroke: 'rgb(20, 20, 20)', 'stroke-width': 50, fill: 'rgb(120, 120, 120)' })]),
      n('text', { x: 12000, y: 5000, 'font-size': 250, 'text-anchor': 'middle', fill: '#000000' }, [], 'Plan'),
    ]);
    const region = { x: 10_000, y: 0, width: 29_700, height: 21_000 };
    const prims = svgToCad([root], { doc, scope: 'sheet', region, scale: 100, paperId: paper });
    const rect = prims.find((p): p is Extract<CadPrimitive, { kind: 'poly' }> => p.kind === 'poly')!;
    expect(rect.layer).toBe('A-WALL');
    // Board (11 000, 1 000) → paper (10 mm, 210 − 10 mm).
    expect(rect.points[0]![0]).toBeCloseTo(10);
    expect(rect.points[0]![1]).toBeCloseTo(200);
    expect(rect.points[2]![0]).toBeCloseTo(50);
    expect(rect.lineweight).toBeCloseTo(0.5);
    expect(rect.fill).toBe('#787878');
    const label = prims.find((p) => p.kind === 'text')!;
    expect(label).toMatchObject({ kind: 'text', layer: 'A-ANNO-TEXT', value: 'Plan', align: 'center' });
    expect(label.kind === 'text' && label.height).toBeCloseTo(2.5 * 0.72);
  });

  it('keeps only view frame drawings, at true size, in model scope', () => {
    const app = createTestApp();
    const level = run<string>(app, 'create-level', { x: 0, y: 0, width: 8000, height: 6000 });
    const [wall] = run<string[]>(app, 'create-wall-segments', { points: [[1000, 1000], [5000, 1000]], type: 'wall', parentId: null });
    run(app, 'set-element-level-link', { id: wall, levelId: level, offset: 0 });
    const paper = run<string>(app, 'create-paper', { x: 50_000, y: 0, size: 'A3', scale: 100 });
    const frame = run<string>(app, 'add-sheet-view', { paperId: paper, sourceId: level, scale: 50 });
    const doc = app.store.getState().doc;
    const root = n('svg', {}, [
      n('g', { 'data-element-id': frame, transform: 'matrix(1 0 0 1 60000 5000)' }, [
        n('g', {}, [
          n('svg', { x: 0, y: 0, width: 16000, height: 12000, viewBox: '0 0 8000 6000' }, [
            n('g', { 'data-vf': frame }, [n('g', { 'data-vo': wall! }, [n('g', { 'data-element-id': wall!, transform: 'matrix(1 0 0 1 1000 1000)' }, [n('line', { x1: 0, y1: 0, x2: 4000, y2: 0, stroke: '#000000', 'stroke-width': 25 })])])]),
          ]),
          n('text', { x: 0, y: 12500 }, [], 'GROUND PLAN'),
        ]),
      ]),
    ]);
    const region = { x: 50_000, y: 0, width: 42_000, height: 29_700 };
    const model = svgToCad([root], { doc, scope: 'model', region, scale: 100, paperId: paper });
    expect(model).toHaveLength(1);
    const line = model[0] as Extract<CadPrimitive, { kind: 'poly' }>;
    // Real coordinates (y flipped), not the frame's position on the sheet.
    expect(line.points).toEqual([[1000, -1000], [5000, -1000]]);
    // 25 mm drawn at 1:50 prints 0.5 mm.
    expect(line.lineweight).toBeCloseTo(0.5);
    const sheet = svgToCad([root], { doc, scope: 'sheet', region, scale: 100, paperId: paper });
    expect(sheet.some((p) => p.kind === 'text' && p.value === 'GROUND PLAN')).toBe(true);
  });

  it('does not apply the page root viewBox (the export region) a second time', () => {
    const { doc, paper } = docWithWall();
    const region = { x: 10_000, y: 0, width: 29_700, height: 21_000 };
    const root = n('svg', { viewBox: '10000 0 29700 21000' }, [n('line', { x1: 11_000, y1: 1_000, x2: 12_000, y2: 1_000, stroke: '#000000', 'stroke-width': 25 })]);
    const [line] = svgToCad([root], { doc, scope: 'sheet', region, scale: 100, paperId: paper });
    expect(line!.kind === 'poly' && line!.points).toEqual([[10, 200], [20, 200]]);
  });

  it('snaps lineweights to the DXF standard set', () => {
    expect(dxfLineweight(0.5)).toBe(50);
    expect(dxfLineweight(0.33)).toBe(35);
    expect(dxfLineweight(0)).toBe(0);
  });
});

describe('DXF output', () => {
  it('writes a document CAD parsers read back: layers, polylines, hatches, text, lineweights', async () => {
    const prims: CadPrimitive[] = [
      { kind: 'poly', layer: 'A-WALL', color: '#111111', lineweight: 0.5, points: [[0, 0], [100, 0], [100, 20], [0, 20]], closed: true, stroke: true, fill: '#3b82f6', pattern: false },
      { kind: 'poly', layer: 'A-DOOR', color: '#16a34a', lineweight: 0.25, points: [[0, 50], [40, 50]], closed: false, stroke: true, fill: null, pattern: false },
      { kind: 'text', layer: 'A-ANNO-TEXT', color: null, x: 10, y: 80, height: 2.5, rotation: 0, value: 'Ground floor — المخطط', align: 'center', middle: false },
    ];
    const text = await writeDxf(prims, 'Test');
    expect(text).toContain('AC1021');
    const parsed = new DxfParser().parseSync(text) as unknown as {
      header: Record<string, unknown>;
      tables: { layer: { layers: Record<string, unknown> } };
      entities: { type: string; layer: string; lineweight?: number; text?: string; shape?: boolean; vertices?: unknown[]; color?: number }[];
    };
    expect(parsed.header['$INSUNITS']).toBe(4);
    expect(Object.keys(parsed.tables.layer.layers)).toEqual(expect.arrayContaining(['A-WALL', 'A-WALL-PATT', 'A-DOOR', 'A-ANNO-TEXT']));
    const types = parsed.entities.map((entity) => entity.type);
    expect(types).toEqual(expect.arrayContaining(['LWPOLYLINE', 'TEXT']));
    // dxf-parser skips HATCH entities: check the solid fill in the raw file.
    const hatch = text.slice(text.search(/\n\s*0\r?\nHATCH\r?\n/));
    expect(hatch.length).toBeLessThan(text.length);
    expect(hatch).toMatch(/A-WALL-PATT[\s\S]*?SOLID/);
    const wall = parsed.entities.find((entity) => entity.type === 'LWPOLYLINE' && entity.layer === 'A-WALL')!;
    expect(wall.shape).toBe(true);
    expect(wall.vertices).toHaveLength(4);
    expect(wall.lineweight).toBe(50);
    const door = parsed.entities.find((entity) => entity.layer === 'A-DOOR')!;
    expect(door.lineweight).toBe(25);
    expect(parsed.entities.find((entity) => entity.type === 'TEXT')?.text).toBe('Ground floor — المخطط');
  });
});
