import { describe, expect, it } from 'vitest';
import { paperLines, smartGuides } from './guides';

const paper = { x: 0, y: 0, width: 1000, height: 600 };
const lines = paperLines(paper, 20);

describe('sheet smart guides', () => {
  it('snaps edges and centres to paper margins, centre lines and other items', () => {
    const toMargin = smartGuides({ x: 24, y: 300, width: 100, height: 50 }, { items: [], ...lines, paper }, 8);
    expect(toMargin.dx).toBe(-4);
    const centred = smartGuides({ x: 447, y: 97, width: 100, height: 50 }, { items: [], ...lines, paper }, 8);
    expect(centred.dx).toBe(3);
    const toItem = smartGuides({ x: 300, y: 103, width: 100, height: 50 }, { items: [{ x: 600, y: 100, width: 200, height: 80 }], xs: [], ys: [], paper }, 8);
    expect(toItem.dy).toBe(-3);
    expect(toItem.guides).toHaveLength(1);
  });

  it('centres between two neighbours and repeats existing gaps', () => {
    const items = [{ x: 100, y: 100, width: 100, height: 100 }, { x: 500, y: 100, width: 100, height: 100 }];
    const between = smartGuides({ x: 303, y: 110, width: 100, height: 80 }, { items, xs: [], ys: [], paper }, 8);
    expect(between.dx).toBe(-3);
    const row = [{ x: 100, y: 100, width: 100, height: 100 }, { x: 250, y: 100, width: 100, height: 100 }];
    const repeated = smartGuides({ x: 404, y: 110, width: 100, height: 60 }, { items: row, xs: [], ys: [], paper }, 8);
    expect(repeated.dx).toBe(-4);
  });
});
