import { describe, expect, it } from 'vitest';
import { projectLoading, withProjectLoading } from './projectLoading';

describe('project loading lifecycle', () => {
  it('announces loading immediately, rejects overlapping opens, and clears after completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = withProjectLoading('Tower', async (task) => {
      task.update('Preparing drawing', 0.6);
      task.update('Reading project', 0.1);
      await gate;
      return true;
    });
    expect(projectLoading.getSnapshot()?.name).toBe('Tower');
    await expect(withProjectLoading('Other', async () => true)).rejects.toThrow('already opening');
    expect(projectLoading.getSnapshot()?.fraction).toBe(0.6);
    release();
    expect(await job).toBe(true);
    expect(projectLoading.getSnapshot()).toBeNull();
  });

  it('clears the overlay after failures and allows a retry', async () => {
    await expect(withProjectLoading('Broken', async () => { throw new Error('Invalid project'); })).rejects.toThrow('Invalid project');
    expect(projectLoading.getSnapshot()).toBeNull();
    expect(await withProjectLoading('Retry', async () => false)).toBe(false);
    expect(projectLoading.getSnapshot()).toBeNull();
  });
});
