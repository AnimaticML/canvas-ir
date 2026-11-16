// The One Euro filter (Casiez, Roussel and Vogel, 2012): smooths hard while a point is still, where jitter shows most,
// and less as it speeds up, where lag shows most. Its two knobs are the trade between them: `minCutoff` (Hz) is how
// much a still point is smoothed, lower is steadier; `beta` is how fast smoothing lets go as the point moves, higher
// lags less. Per action, the right trade differs: a cursor wants steadiness, a sword swing wants no lag.

export interface FilterOptions {
  readonly minCutoff: number;
  readonly beta: number;
  /** The cutoff for the speed the filter measures, Hz. */
  readonly dCutoff: number;
}

export const FILTER_DEFAULTS: FilterOptions = { minCutoff: 1.2, beta: 3, dCutoff: 1 };

const alpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/** Filters one number over time. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private readonly options: FilterOptions = FILTER_DEFAULTS) {}

  /** The filtered value for `value` seen at `time` in milliseconds. */
  next(value: number, time: number): number {
    if (this.x === null || time <= this.t) {
      if (this.x === null) this.x = value;
      this.t = time;
      return this.x;
    }
    const dt = (time - this.t) / 1000;
    this.t = time;
    const d = (value - this.x) / dt;
    this.dx += alpha(this.options.dCutoff, dt) * (d - this.dx);
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

/** Filters a list of 3D points, each axis on its own, keyed by index; lists may change length. */
export class PointsFilter {
  private filters: OneEuro[] = [];
  constructor(private readonly options: FilterOptions = FILTER_DEFAULTS) {}

  next<P extends { x: number; y: number; z: number }>(points: readonly P[], time: number): P[] {
    while (this.filters.length < points.length * 3) this.filters.push(new OneEuro(this.options));
    return points.map((p, i) => ({
      ...p,
      x: this.filters[i * 3]!.next(p.x, time),
      y: this.filters[i * 3 + 1]!.next(p.y, time),
      z: this.filters[i * 3 + 2]!.next(p.z, time),
    }));
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }
}
