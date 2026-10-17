/** Opt-in synthetic picking diagnostic; excludes GPU rendering and real project I/O. */
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { childrenOf, createEmptyDocument, sequentialIds, type ArchaiDocument, type Element } from '@/document';
import { hitTest } from '@/geometry/hit';
import { localMatrix } from '@/geometry/bounds';
import { applyToPoint, invert } from '@/geometry/matrix';
import { rect, rectContainsPoint } from '@/geometry/rect';
import type { Vec2 } from '@/geometry/vec';

// The previous traversal, specialised to this fixture's filled root rectangles.
function linearPick(doc: ArchaiDocument, point: Vec2): string | undefined {
  const siblings = childrenOf(doc.elements, null);
  for (let i = siblings.length - 1; i >= 0; i--) {
    const element = siblings[i]!;
    if (!element.visible || element.locked || element.kind !== 'rect') continue;
    childrenOf(doc.elements, element.id);
    const local = applyToPoint(invert(localMatrix(element)), point);
    if (rectContainsPoint(rect(0, 0, element.width, element.height), local, 8)) return element.id;
  }
}

it('records cold construction and warm picking latency', () => {
  const rows = [];
  for (const count of [1000, 5000, 10000]) {
    const doc = createEmptyDocument({ ids: sequentialIds(), now: () => 'now' });
    for (let i = 0; i < count; i++) {
      const element: Element = { id: `item-${i}`, kind: 'rect', parentId: null, index: 'a0',
        x: i % 100 * 200, y: Math.floor(i / 100) * 200, width: 100, height: 100,
        radius: 0, rotation: 0, locked: false, visible: true,
        style: { fill: '#fff', stroke: '#000', strokeWidth: 10, opacity: 1 } };
      doc.elements[element.id] = element;
    }
    const points = Array.from({ length: 500 }, (_, i) => i % 2
      ? { x: -100, y: -100 }
      : { x: (i * 37 % 100) * 200 + 50, y: (i * 17 % (count / 100)) * 200 + 50 });
    const start = performance.now();
    hitTest(doc, points[0]!, { tolerance: 8 });
    const coldMs = performance.now() - start;
    for (const point of points) expect(hitTest(doc, point, { tolerance: 8 })?.id).toBe(linearPick(doc, point));
    const measure = (pick: (point: Vec2) => unknown) => {
      const samples = [];
      for (let batch = 0; batch < 5; batch++) {
        const begin = performance.now();
        for (const point of points) pick(point);
        samples.push((performance.now() - begin) / points.length);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    rows.push({ count, coldMs, linearMsPerPick: measure((p) => linearPick(doc, p)), indexedMsPerPick: measure((p) => hitTest(doc, p, { tolerance: 8 })) });
  }
  writeFileSync(new URL('../docs/picking-performance-results.json', import.meta.url), JSON.stringify({ date: '2026-10-17', fixture: 'Filled root rectangles on a grid; half hits, half empty-space misses; median of five 500-query batches.', rows }, null, 2) + '\n');
  console.table(rows);
});
