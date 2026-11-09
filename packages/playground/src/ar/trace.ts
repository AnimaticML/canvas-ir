export interface TraceEvent { time: number; kind: string; data: unknown }
/** Keep setup decisions and calibration inputs even after the rolling FPS buffer
 * fills up. Store references in bounded buffers; do not copy camera images. */
export class TraceBuffer {
  readonly recent: TraceEvent[] = [];
  private important: TraceEvent[] = [];
  private pinned: TraceEvent[] = [];
  private pinUntil = -Infinity;
  constructor(private readonly limits = { recent: 400, important: 200, pinned: 1200 }) {}
  pinFor(ms: number, now = performance.now()): void { this.pinUntil = Math.max(this.pinUntil, now + ms); }
  append(kind: string, data: unknown, time = performance.now()): void {
    const event = { time, kind, data };
    this.push(this.recent, event, this.limits.recent);
    if (kind !== "frame" && kind !== "hand") this.push(this.important, event, this.limits.important);
    else if (time <= this.pinUntil) this.push(this.pinned, event, this.limits.pinned);
  }
  export(): TraceEvent[] { return [...new Set([...this.important, ...this.pinned, ...this.recent])].sort((a,b) => a.time-b.time); }
  private push(buffer: TraceEvent[], event: TraceEvent, limit: number): void { buffer.push(event); if (buffer.length > limit) buffer.shift(); }
}
