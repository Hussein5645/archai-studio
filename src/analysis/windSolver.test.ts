import { describe, expect, it } from 'vitest';
import { WindSolver } from './windSolver';

describe('WindSolver', () => {
  it('speeds up past the flanks of a block and shelters its wake', () => {
    const n = 48;
    const solid = new Uint8Array(n * n);
    for (let j = 20; j < 28; j++) for (let i = 20; i < 28; i++) solid[j * n + i] = 1;
    const solver = new WindSolver(n, solid, [1, 0]);
    for (let s = 0; s < 120; s++) solver.step();
    const speed = solver.speedRatio(new Float32Array(n * n));
    const flank = speed[16 * n + 22]!;
    const wake = speed[24 * n + 30]!;
    expect(flank).toBeGreaterThan(1.05);
    expect(wake).toBeLessThan(0.6);
  });
});
