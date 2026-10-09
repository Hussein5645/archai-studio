import { describe, expect, it } from 'vitest';
import { createEmptyDocument, sequentialIds, type ArchaiDocument, type Element } from '@/document';
import { refreshRooms } from './rooms';

const base = { parentId: null, rotation: 0, visible: true, locked: false } as const;
const style = { fill: null, stroke: '#000000', strokeWidth: 10, opacity: 1 };

const wall = (id: string, levelId: string, points: [number, number][]): Element =>
  ({ ...base, id, index: id, kind: 'line', x: 0, y: 0, points, closed: false, style, meta: { arch: { type: 'wall' }, levelConstraint: { levelId, offset: 0 } } }) as unknown as Element;

const room = (id: string, levelId: string, x: number, y: number): Element =>
  ({
    ...base,
    id,
    index: id,
    kind: 'line',
    x,
    y,
    points: [[0, 0], [100, 0], [100, 100], [0, 100]],
    closed: true,
    style,
    meta: { arch: { type: 'room' }, levelConstraint: { levelId, offset: 0 } },
  }) as unknown as Element;

function docWith(elements: Element[]): ArchaiDocument {
  const doc = createEmptyDocument({ ids: sequentialIds(), now: () => 'now' });
  for (const element of elements) doc.elements[element.id] = element;
  return doc;
}

const areaOf = (doc: ArchaiDocument, id: string) => (doc.elements[id]!.meta!['arch'] as { area: number }).area;

describe('refreshRooms', () => {
  it('encloses each room with the walls of its own level only', () => {
    const box: [number, number][] = [[0, 0], [10000, 0], [10000, 10000], [0, 10000], [0, 0]];
    const doc = docWith([
      wall('w_l1', 'lvl_1', box),
      wall('w_l2', 'lvl_2', box),
      // A partition on level 2 only must not split the level 1 room.
      wall('w_l2_split', 'lvl_2', [[5000, 0], [5000, 10000]]),
      room('r_l1', 'lvl_1', 2000, 4000),
      room('r_l2', 'lvl_2', 2000, 4000),
    ]);

    refreshRooms(doc);

    expect(areaOf(doc, 'r_l1')).toBeCloseTo(100_000_000);
    expect(areaOf(doc, 'r_l2')).toBeCloseTo(50_000_000);
  });
});
