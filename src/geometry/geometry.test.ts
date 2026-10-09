import { describe, expect, it } from 'vitest';
import { createEmptyDocument, sequentialIds, type ArchaiDocument, type Element } from '@/document';
import { applyToPoint, fromTRS, invert, multiply } from './matrix';
import { elementsInArea, hitTest } from './hit';
import { worldBounds } from './bounds';
import { layoutText, monospaceMeasurer } from './text';
import { parseLength } from './units';
import { fitBounds, screenToWorld, worldToScreen, zoomAt } from './viewport';
import { rotate } from './vec';

const near = (value: number, expected: number, eps = 1e-6) => expect(Math.abs(value - expected)).toBeLessThan(eps);

function docWith(elements: Element[]): ArchaiDocument {
  const doc = createEmptyDocument({ ids: sequentialIds(), now: () => 'now' });
  for (const element of elements) doc.elements[element.id] = element;
  return doc;
}

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Element> = {}): Element =>
  ({
    id,
    kind: 'rect',
    parentId: null,
    index: id,
    x,
    y,
    rotation: 0,
    width: w,
    height: h,
    radius: 0,
    visible: true,
    locked: false,
    style: { fill: '#ffffff', stroke: '#000000', strokeWidth: 10, opacity: 1 },
    ...extra,
  }) as Element;

describe('matrix', () => {
  it('inverts TRS transforms', () => {
    const m = fromTRS(100, 50, 30, 2, 0.5);
    const p = { x: 12, y: -7 };
    const back = applyToPoint(invert(m), applyToPoint(m, p));
    near(back.x, p.x);
    near(back.y, p.y);
  });

  it('composes child-then-parent', () => {
    const parent = fromTRS(100, 0, 90);
    const child = fromTRS(10, 0, 0);
    const p = applyToPoint(multiply(parent, child), { x: 0, y: 0 });
    near(p.x, 100);
    near(p.y, 10);
  });

  it('rotates clockwise in a y-down space', () => {
    const r = rotate({ x: 1, y: 0 }, 90);
    near(r.x, 0);
    near(r.y, 1);
  });
});

describe('bounds and hit-testing', () => {
  it('computes world bounds of a rotated rectangle', () => {
    const doc = docWith([rect('a', 0, 0, 200, 100, { rotation: 90 })]);
    const bounds = worldBounds(doc.elements, doc.elements['a']!);
    near(bounds.x, -100);
    near(bounds.y, 0);
    near(bounds.width, 100);
    near(bounds.height, 200);
  });

  it('hits filled rectangles inside and outlined rectangles on their edges only', () => {
    const doc = docWith([
      rect('filled', 0, 0, 100, 100),
      rect('outline', 200, 0, 100, 100, { style: { fill: null, stroke: '#000', strokeWidth: 4, opacity: 1 } } as Partial<Element>),
    ]);
    expect(hitTest(doc, { x: 50, y: 50 }, { tolerance: 2 })?.id).toBe('filled');
    expect(hitTest(doc, { x: 250, y: 50 }, { tolerance: 2 })).toBeNull();
    expect(hitTest(doc, { x: 201, y: 50 }, { tolerance: 2 })?.id).toBe('outline');
    expect(hitTest(doc, { x: 150, y: 150 }, { tolerance: 2 })).toBeNull();
  });

  it('prefers the front-most element and skips hidden or locked ones', () => {
    const back = rect('back', 0, 0, 100, 100, { index: 'a0' });
    const front = rect('front', 0, 0, 100, 100, { index: 'a1' });
    expect(hitTest(docWith([back, front]), { x: 10, y: 10 }, { tolerance: 0 })?.id).toBe('front');
    expect(hitTest(docWith([back, { ...front, locked: true }]), { x: 10, y: 10 }, { tolerance: 0 })?.id).toBe('back');
    expect(hitTest(docWith([back, { ...front, locked: true }]), { x: 10, y: 10 }, { tolerance: 0, includeLocked: true })?.id).toBe('front');
    expect(hitTest(docWith([back, { ...front, visible: false }]), { x: 10, y: 10 }, { tolerance: 0 })?.id).toBe('back');
  });

  it('hit-tests lines with stroke-aware tolerance and rotated content', () => {
    const line: Element = {
      id: 'l',
      kind: 'line',
      parentId: null,
      index: 'a0',
      x: 0,
      y: 0,
      rotation: 90,
      points: [
        [0, 0],
        [100, 0],
      ],
      closed: false,
      visible: true,
      locked: false,
      style: { fill: null, stroke: '#000', strokeWidth: 20, opacity: 1 },
    };
    const doc = docWith([line]);
    expect(hitTest(doc, { x: 0, y: 50 }, { tolerance: 1 })?.id).toBe('l');
    expect(hitTest(doc, { x: 9, y: 50 }, { tolerance: 1 })?.id).toBe('l');
    expect(hitTest(doc, { x: 50, y: 0 }, { tolerance: 1 })).toBeNull();
  });

  it('finds root elements intersecting or contained by an area', () => {
    const doc = docWith([rect('a', 0, 0, 100, 100), rect('b', 500, 500, 100, 100)]);
    const area = { x: 50, y: 50, width: 500, height: 500 };
    expect(elementsInArea(doc, area, 'intersect').map((e) => e.id)).toEqual(['a', 'b']);
    expect(elementsInArea(doc, area, 'contain').map((e) => e.id)).toEqual([]);
    expect(elementsInArea(doc, { x: -10, y: -10, width: 200, height: 200 }, 'contain').map((e) => e.id)).toEqual(['a']);
  });
});

describe('viewport', () => {
  it('round-trips screen and world coordinates', () => {
    const v = { x: 120, y: -40, zoom: 0.05 };
    const world = { x: 1234, y: 5678 };
    const back = screenToWorld(v, worldToScreen(v, world));
    near(back.x, world.x);
    near(back.y, world.y);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const v = { x: 0, y: 0, zoom: 0.1 };
    const cursor = { x: 300, y: 200 };
    const worldUnderCursor = screenToWorld(v, cursor);
    const zoomed = zoomAt(v, cursor, 2);
    const after = screenToWorld(zoomed, cursor);
    near(after.x, worldUnderCursor.x);
    near(after.y, worldUnderCursor.y);
    near(zoomed.zoom, 0.2);
  });

  it('fits bounds inside the canvas with padding', () => {
    const v = fitBounds({ x: 0, y: 0, width: 10000, height: 5000 }, { width: 1000, height: 1000 }, 50);
    near(v.zoom, 0.09);
    const center = worldToScreen(v, { x: 5000, y: 2500 });
    near(center.x, 500);
    near(center.y, 500);
  });
});

describe('text and units', () => {
  it('wraps words and breaks over-long words', () => {
    const layout = layoutText('hello wonderful world', 10, 80, monospaceMeasurer);
    expect(layout.lines).toEqual(['hello', 'wonderful', 'world']);
    expect(layoutText('abcdefghijklmnop', 10, 60, monospaceMeasurer).lines).toEqual(['abcdefghij', 'klmnop']);
    expect(layoutText('a\n\nb', 10, 1000, monospaceMeasurer).lines).toEqual(['a', '', 'b']);
  });

  it('parses lengths with optional units', () => {
    expect(parseLength('1.5', 'm')).toBe(1500);
    expect(parseLength('250mm', 'm')).toBe(250);
    expect(parseLength('2 ft', 'mm')).toBeCloseTo(609.6);
    expect(parseLength("3'", 'mm')).toBeCloseTo(914.4);
    expect(parseLength('abc', 'm')).toBeNull();
  });
});
