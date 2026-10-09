/**
 * A small 2D incompressible flow solver ("stable fluids": semi-Lagrangian advection + pressure
 * projection) on a horizontal slice at one height. Buildings taller than the slice are solid
 * cells; the domain edges hold the free-stream wind. Velocities are in free-stream units (1 = the
 * wind speed), so `speedRatio` reads directly as the local speed-up / shelter factor. It is a
 * qualitative design aid, not CFD: no turbulence model, no vertical flow, coarse grid.
 */
export class WindSolver {
  readonly u: Float32Array;
  readonly v: Float32Array;
  private readonly u0: Float32Array;
  private readonly v0: Float32Array;
  private readonly p: Float32Array;
  private readonly div: Float32Array;

  constructor(
    readonly n: number,
    readonly solid: Uint8Array,
    private readonly flow: [number, number],
  ) {
    const size = n * n;
    this.u = new Float32Array(size).fill(flow[0]);
    this.v = new Float32Array(size).fill(flow[1]);
    this.u0 = new Float32Array(size);
    this.v0 = new Float32Array(size);
    this.p = new Float32Array(size);
    this.div = new Float32Array(size);
    for (let i = 0; i < size; i++) if (solid[i]) this.u[i] = this.v[i] = 0;
  }

  private at(field: Float32Array, x: number, y: number): number {
    const n = this.n;
    const cx = Math.min(n - 1.001, Math.max(0, x));
    const cy = Math.min(n - 1.001, Math.max(0, y));
    const i = Math.floor(cx);
    const j = Math.floor(cy);
    const fx = cx - i;
    const fy = cy - j;
    const k = j * n + i;
    return (field[k]! * (1 - fx) + field[k + 1]! * fx) * (1 - fy) + (field[k + n]! * (1 - fx) + field[k + n + 1]! * fx) * fy;
  }

  /** Velocity (grid cells per step unit) at a fractional grid position. */
  sample(x: number, y: number): [number, number] {
    return [this.at(this.u, x, y), this.at(this.v, x, y)];
  }

  isSolid(x: number, y: number): boolean {
    const i = Math.round(x);
    const j = Math.round(y);
    return i < 0 || j < 0 || i >= this.n || j >= this.n || this.solid[j * this.n + i] === 1;
  }

  step(dt = 0.6, iterations = 24): void {
    const { n, u, v, u0, v0, p, div, solid } = this;
    u0.set(u);
    v0.set(v);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (solid[k]) continue;
        const x = i - dt * u0[k]!;
        const y = j - dt * v0[k]!;
        u[k] = this.at(u0, x, y);
        v[k] = this.at(v0, x, y);
      }
    }
    this.boundaries();
    // Pressure projection: make the field divergence-free around the solid cells.
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        div[k] = solid[k] ? 0 : -0.5 * (u[k + 1]! - u[k - 1]! + v[k + n]! - v[k - n]!);
      }
    }
    p.fill(0);
    for (let it = 0; it < iterations; it++) {
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          if (solid[k]) continue;
          const pc = p[k]!;
          const l = solid[k - 1] ? pc : p[k - 1]!;
          const r = solid[k + 1] ? pc : p[k + 1]!;
          const d = solid[k - n] ? pc : p[k - n]!;
          const t = solid[k + n] ? pc : p[k + n]!;
          p[k] = (div[k]! + l + r + d + t) / 4;
        }
      }
    }
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        if (solid[k]) continue;
        const pc = p[k]!;
        const l = solid[k - 1] ? pc : p[k - 1]!;
        const r = solid[k + 1] ? pc : p[k + 1]!;
        const d = solid[k - n] ? pc : p[k - n]!;
        const t = solid[k + n] ? pc : p[k + n]!;
        u[k] = u[k]! - 0.5 * (r - l);
        v[k] = v[k]! - 0.5 * (t - d);
      }
    }
    this.boundaries();
  }

  private boundaries(): void {
    const { n, u, v, solid, flow } = this;
    for (let i = 0; i < n; i++) {
      for (const k of [i, (n - 1) * n + i, i * n, i * n + n - 1]) {
        u[k] = flow[0];
        v[k] = flow[1];
      }
    }
    for (let k = 0; k < n * n; k++) if (solid[k]) u[k] = v[k] = 0;
  }

  /** |velocity| / free-stream, per cell. */
  speedRatio(out: Float32Array): Float32Array {
    for (let k = 0; k < this.n * this.n; k++) out[k] = Math.hypot(this.u[k]!, this.v[k]!);
    return out;
  }
}
