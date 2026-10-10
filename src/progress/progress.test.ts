import { afterEach, describe, expect, it, vi } from 'vitest';
import { progressTasks, setHostProgressReporter, startProgress, withProgress } from './index';

describe('progress tasks', () => {
  afterEach(() => {
    setHostProgressReporter(null);
    vi.useRealTimers();
  });

  it('reports steps, only moves forward, and finishes', () => {
    vi.useFakeTimers();
    const task = startProgress('Exporting PDF', 'Starting', 0);
    const current = () => progressTasks().find((item) => item.title === 'Exporting PDF')!;
    task.step(1, 4, 'Sheet 2 of 4');
    expect(current()).toMatchObject({ detail: 'Sheet 2 of 4', fraction: 0.25, state: 'running' });
    task.update(undefined, 0.1); // backwards: ignored
    expect(current().fraction).toBe(0.25);
    task.update('Unknown length', null);
    expect(current().fraction).toBeNull();
    task.update(undefined, 2); // clamped
    expect(current().fraction).toBe(1);
    task.done();
    expect(current()).toMatchObject({ state: 'done', fraction: 1 });
    expect(current().endedAt).toBeTypeOf('number');
    vi.advanceTimersByTime(2000);
    expect(progressTasks().some((item) => item.title === 'Exporting PDF')).toBe(false);
  });

  it('withProgress marks failures and re-throws', async () => {
    await expect(
      withProgress('Importing model', async () => {
        throw new Error('bad file');
      }),
    ).rejects.toThrow('bad file');
    expect(progressTasks().find((item) => item.title === 'Importing model')?.state ?? 'removed').not.toBe('running');
  });

  it('tells the host the overall progress', async () => {
    const reports: [number | null, boolean][] = [];
    setHostProgressReporter((fraction, active) => reports.push([fraction, active]));
    const a = startProgress('A', '', 0.5);
    const b = startProgress('B', '', null);
    expect(reports.at(-1)).toEqual([null, true]); // one task without a known size
    b.update(undefined, 0.25);
    expect(reports.at(-1)).toEqual([0.375, true]);
    a.failed();
    b.failed();
    expect(reports.at(-1)).toEqual([null, false]);
  });
});
