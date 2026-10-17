import { describe, expect, it } from 'vitest';
import { createDraft, finishDraft } from 'immer';
import { createEmptyDocument, sequentialIds, type ArchaiDocument, type Element } from '@/document';
import { hitTest, hitTestAll, type HitOptions } from './hit';
import { indexedHitCandidates } from './hitIndex';

function box(id: string, x = 0, y = 0, extra: Partial<Element> = {}): Element {
  return { id, kind: 'rect', parentId: null, index: 'a0', x, y, rotation: 0,
    width: 100, height: 100, radius: 0, visible: true, locked: false,
    style: { fill: '#fff', stroke: '#000', strokeWidth: 10, opacity: 1 }, ...extra } as Element;
}

function document(elements: Element[], large = false): ArchaiDocument {
  const doc = createEmptyDocument({ ids: sequentialIds(), now: () => 'now' });
  for (const element of elements) doc.elements[element.id] = element;
  if (large) for (let i = 0; i < 300; i++) {
    const element = box(`padding-${i}`, 100_000 + i * 200, 100_000);
    doc.elements[element.id] = element;
  }
  return doc;
}

describe('indexed board picking', () => {
  it('matches traversal order, strokes, transforms, scopes and visibility options', () => {
    const elements: Element[] = [
      box('back', -100, -100), box('front', -100, -100),
      box('outline', 120, 120, { rotation: 45, style: { fill: null, stroke: '#000', strokeWidth: 80, opacity: 1 } }),
      { ...box('line', -100, 200), kind: 'line', points: [[0, 0], [200, 0], [100, 150]], closed: true } as Element,
      { ...box('curve', -200, 200), kind: 'line', points: [[0, 0], [100, 100]], closed: false,
        path: { start: [0, 0], segments: [{ kind: 'arc', center: [0, 100], radius: 100, startAngle: -Math.PI / 2, endAngle: 0, clockwise: false }] } } as Element,
      { ...box('group', 200, -100, { rotation: 30, visible: false }), kind: 'group' } as Element,
      box('child', 50, 0, { parentId: 'group' }),
      box('locked-parent', -200, -200, { locked: true, rotation: 80 }),
      box('nested', 0, 20, { parentId: 'locked-parent' }),
    ];
    const small = document(elements);
    const large = document(elements, true);
    for (const scopeId of [undefined, 'group', 'locked-parent', 'missing']) {
      for (const includeHidden of [false, true]) for (const includeLocked of [false, true]) {
        for (const tolerance of [0, 12, 80]) {
          const options: HitOptions = { scopeId, includeHidden, includeLocked, tolerance };
          for (let x = -250; x <= 400; x += 47) for (let y = -250; y <= 400; y += 53) {
            const point = { x, y };
            expect(hitTestAll(large, point, options).map((e) => e.id)).toEqual(hitTestAll(small, point, options).map((e) => e.id));
            expect(hitTest(large, point, options)?.id).toBe(hitTest(small, point, options)?.id);
          }
        }
      }
    }
    expect(hitTestAll(large, { x: -50, y: -50 }, { tolerance: 0, accept: (e) => e.id !== 'front' }).map((e) => e.id)).toEqual(['back']);
  });

  it('refreshes after edits and undo, and never caches a mutable draft', () => {
    const original = document([box('target')], true);
    expect(hitTest(original, { x: 50, y: 50 }, { tolerance: 0 })?.id).toBe('target');
    const draft = createDraft(original);
    expect(indexedHitCandidates(draft.elements, { x: 50, y: 50 }, 0)).toBeNull();
    draft.elements['target']!.x = 500;
    expect(hitTest(draft, { x: 50, y: 50 }, { tolerance: 0 })).toBeNull();
    const moved = finishDraft(draft);
    expect(hitTest(moved, { x: 550, y: 50 }, { tolerance: 0 })?.id).toBe('target');
    expect(hitTest(moved, { x: 50, y: 50 }, { tolerance: 0 })).toBeNull();
    expect(hitTest(original, { x: 50, y: 50 }, { tolerance: 0 })?.id).toBe('target');
  });

  it('narrows a 10,000-object model to nearby candidates', () => {
    const doc = document(Array.from({ length: 10_000 }, (_, i) => box(`item-${i}`, (i % 100) * 200, Math.floor(i / 100) * 200)));
    expect(indexedHitCandidates(doc.elements, { x: 50, y: 50 }, 8)?.map((entry) => entry.element.id)).toEqual(['item-0']);
    expect(indexedHitCandidates(doc.elements, { x: -100, y: -100 }, 8)).toEqual([]);
  });

  it('can edit a detached scope that is absent from the root paint order', () => {
    const doc = document([box('scope', 100, 0, { parentId: 'missing-parent' }), box('child', 0, 0, { parentId: 'scope' })], true);
    expect(hitTest(doc, { x: 150, y: 50 }, { tolerance: 0, scopeId: 'scope' })?.id).toBe('child');
  });
});
