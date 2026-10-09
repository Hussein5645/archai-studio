import { describe, expect, it } from 'vitest';
import { DEFAULT_INFERENCE_SETTINGS, InferenceEngine, projectToDirection, type InferenceCandidate } from './inference';

const candidate = (type: InferenceCandidate['type'], screenDistance: number, extra: Partial<InferenceCandidate> = {}): InferenceCandidate => ({ position: [0, 0, 0], type, screenDistance, label: type, marker: 'square', ...extra });

describe('InferenceEngine', () => {
  it('combines semantic priority with screen distance', () => {
    const engine = new InferenceEngine({ ...DEFAULT_INFERENCE_SETTINGS, tolerance: 20, disabledTypes: {} });
    expect(engine.resolve([candidate('grid', 1), candidate('endpoint', 8)])?.type).toBe('endpoint');
  });

  it('filters hidden, occluded, disabled, and out-of-tolerance candidates', () => {
    const engine = new InferenceEngine({ ...DEFAULT_INFERENCE_SETTINGS, tolerance: 10, disabledTypes: { midpoint: true } });
    const result = engine.resolve([candidate('endpoint', 2, { occluded: true }), candidate('midpoint', 1), candidate('center', 20), candidate('grid', 4)]);
    expect(result?.type).toBe('grid');
  });

  it('cycles ambiguous targets and holds a lock until released', () => {
    const engine = new InferenceEngine({ ...DEFAULT_INFERENCE_SETTINGS, disabledTypes: {} });
    expect(engine.resolve([candidate('endpoint', 2), candidate('midpoint', 2)])?.type).toBe('endpoint');
    expect(engine.cycle()?.type).toBe('midpoint');
    engine.lock();
    expect(engine.resolve([candidate('center', 1)])?.type).toBe('midpoint');
    engine.clearLock();
    expect(engine.resolve([candidate('center', 1)])?.type).toBe('center');
  });

  it('projects movement onto a locked direction', () => {
    expect(projectToDirection([4, 3, 0], [0, 0, 0], [1, 0, 0])).toEqual([4, 0, 0]);
  });
});
