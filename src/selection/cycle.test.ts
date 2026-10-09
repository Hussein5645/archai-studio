import { describe, expect, it } from 'vitest';
import { cycleCandidates, lineChain } from './cycle';
import { createTestApp, run } from '@/test/harness';

describe('Tab selection cycling', () => {
  it('lists everything under the point, front-most first', () => {
    const app = createTestApp();
    const back = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000, name: 'Back' });
    const front = run<string>(app, 'create-rect', { x: 200, y: 200, width: 1000, height: 1000, name: 'Front' });
    const candidates = cycleCandidates(app.store.getState().doc, { x: 500, y: 500 }, 5);
    expect(candidates.map((c) => c.ids)).toEqual([[front], [back]]);
    expect(candidates[0]!.label).toBe('Front');
  });

  it('offers the group and then the element inside it', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 500, height: 500 });
    const b = run<string>(app, 'create-rect', { x: 1000, y: 0, width: 500, height: 500 });
    const group = run<string>(app, 'group-selection', { ids: [a, b] });
    const candidates = cycleCandidates(app.store.getState().doc, { x: 250, y: 250 }, 5);
    expect(candidates.map((c) => c.ids)).toEqual([[group], [a]]);
  });

  it('chains lines connected end to end', () => {
    const app = createTestApp();
    const one = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0]] });
    const two = run<string>(app, 'create-line', { points: [[1000, 0], [1000, 1000]] });
    const three = run<string>(app, 'create-line', { points: [[1000, 1000], [0, 1000]] });
    run<string>(app, 'create-line', { points: [[5000, 5000], [6000, 5000]] });
    const { elements } = app.store.getState().doc;
    expect(lineChain(elements, elements[one]!, 10)).toEqual([one, two, three]);
    const candidates = cycleCandidates(app.store.getState().doc, { x: 500, y: 0 }, 5);
    expect(candidates.at(-1)).toEqual({ ids: [one, two, three], label: 'Chain of 3 lines' });
  });
});
