import { afterEach, expect, it, vi } from 'vitest';
import { MeshPlanStore } from './meshPlan';

afterEach(() => vi.unstubAllGlobals());

it('computes one plan in a worker at a time, deduplicates pending requests and publishes results', () => {
  const jobs: string[] = [];
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(data: string) {
      jobs.push(data);
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  const store = new MeshPlanStore();
  const listener = vi.fn();
  store.subscribe(listener);
  expect(store.get('a', 'heavy-a')).toBeNull();
  store.get('a', 'heavy-a');
  store.get('b', 'heavy-b');
  expect(jobs).toEqual(['heavy-a']);
  const plan = { cut: [], edges: [0, 0, 1, 1] };
  workers[0]!.onmessage!({ data: plan } as MessageEvent);
  expect(store.get('a', 'heavy-a')).toEqual(plan);
  expect(jobs).toEqual(['heavy-a', 'heavy-b']);
  workers[0]!.onmessage!({ data: plan } as MessageEvent);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(store.get('b', 'heavy-b')).toEqual(plan);
});
