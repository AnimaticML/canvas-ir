// Ten million points: a year of readings, one every 3.15 seconds, on a chart
// on the board. Its plot is a VirtualGroup whose level of detail is how many
// readings fall in a screen pixel: above one, each pixel column is a bar from
// the lowest to the highest reading in it, read off a min/max pyramid; below
// one, the readings are a line; spread far enough apart, each is a dot you can
// hover. The wheel over the chart zooms its time axis and a drag pans it;
// zooming the board changes the detail too.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type Rect, type Scene, VirtualGroup } from "canvas-ir";
import { WheelGesture } from "./wheel";

export const POINTS_ID = "ten-million";
export const POINTS_AT = { x: -560, y: 3150 };
const N = 10_000_000;
const YEAR = Date.UTC(2025, 0, 1);
const STEP = (365 * 86_400_000) / N;
const W = 1500;
const TITLE = 46;
const PLOT = 400;
const AXIS = 34;
const LEFT = 56;
const PW = W - LEFT - 16;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** A year of temperatures: seasons, days, weather that wanders, and a few spikes. */
const readings = (): Float32Array => {
  const v = new Float32Array(N);
  let seed = 7;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  let weather = 0;
  let spike = 0;
  const perDay = N / 365;
  for (let i = 0; i < N; i++) {
    const day = i / perDay;
    weather = weather * 0.99995 + (random() - 0.5) * 0.08;
    if (random() < 0.000004) spike = (random() - 0.3) * 14;
    spike *= 0.9995;
    v[i] = 11 - 10 * Math.cos((2 * Math.PI * (day - 15)) / 365) - 4 * Math.cos(2 * Math.PI * (day - 0.15)) + weather + spike + (random() - 0.5) * 0.6;
  }
  return v;
};

/** Lowest and highest reading in each run of 2^level readings, from level 4 up: one bar per pixel at any zoom reads one entry. */
const pyramid = (v: Float32Array): { min: Float32Array; max: Float32Array }[] => {
  const levels: { min: Float32Array; max: Float32Array }[] = [];
  let size = 16;
  let min = new Float32Array(Math.ceil(N / size));
  let max = new Float32Array(min.length);
  for (let b = 0; b < min.length; b++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = b * size, end = Math.min(N, i + size); i < end; i++) {
      const x = v[i]!;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    min[b] = lo;
    max[b] = hi;
  }
  levels[4] = { min, max };
  for (let level = 5; size * 2 < N; level++) {
    size *= 2;
    const next = { min: new Float32Array(Math.ceil(min.length / 2)), max: new Float32Array(Math.ceil(min.length / 2)) };
    for (let b = 0; b < next.min.length; b++) {
      next.min[b] = Math.min(min[2 * b]!, min[2 * b + 1] ?? Infinity);
      next.max[b] = Math.max(max[2 * b]!, max[2 * b + 1] ?? -Infinity);
    }
    levels[level] = next;
    min = next.min;
    max = next.max;
  }
  return levels;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICKS = [5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY, 30 * DAY];
const label = (t: number, step: number): string => {
  const iso = new Date(t).toISOString();
  if (step >= DAY) return iso.slice(5, 10);
  if (step >= MINUTE) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return iso.slice(11, 19);
};

/** A span of time in the unit that reads best. */
const duration = (ms: number): string => {
  if (ms >= 2 * DAY) return `${(ms / DAY).toFixed(ms < 20 * DAY ? 1 : 0)} days`;
  if (ms >= 2 * HOUR) return `${(ms / HOUR).toFixed(1)} hours`;
  if (ms >= 2 * MINUTE) return `${(ms / MINUTE).toFixed(0)} minutes`;
  return `${(ms / SECOND).toFixed(0)} seconds`;
};

interface FrameState {
  readonly note: string;
}

export interface PointsHost {
  readonly components: () => Components;
  /** The board's zoom: screen pixels per world unit. */
  readonly zoom: () => number;
  readonly render: () => void;
  readonly log: (line: string) => void;
}

export class TenMillionPoints {
  private readonly values: Float32Array;
  private readonly levels: { min: Float32Array; max: Float32Array }[];
  private readonly vmin: number;
  private readonly vmax: number;
  /** The readings that show: from `start`, `span` of them. */
  private start = 0;
  private span = N;
  private x = POINTS_AT.x;
  private y = POINTS_AT.y;
  private readonly plot: VirtualGroup;
  private readonly frame: ComponentHandle<FrameState>;
  private unlisten: (() => void)[] = [];
  private readonly gesture = new WheelGesture();
  private drawnPoints = 0;
  private mode = "";

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly host: PointsHost,
  ) {
    const t0 = performance.now();
    this.values = readings();
    const t1 = performance.now();
    this.levels = pyramid(this.values);
    const top = this.levels.at(-1)!;
    this.vmin = Math.floor(Math.min(...top.min) - 1);
    this.vmax = Math.ceil(Math.max(...top.max) + 1);
    host.log(`ten million points: made in ${(t1 - t0).toFixed(0)} ms, min/max pyramid in ${(performance.now() - t1).toFixed(0)} ms`);
    scene.addGroup({ id: POINTS_ID, meta: { role: "figure", label: "Ten million points", source: "ten million points" } });
    this.frame = host.components().mount(this.frameSpec());
    this.plot = new VirtualGroup(scene, {
      id: `${POINTS_ID}:plot`,
      parent: POINTS_ID,
      meta: { role: "img", label: "A year of readings" },
      extent: { x: 0, y: this.vmin, width: N, height: this.vmax - this.vmin },
      draw: (ctx, window, detail) => this.draw(ctx, window, detail),
    });
    this.show();
    this.listen();
  }

  get alive(): boolean {
    return this.scene.getGroup(POINTS_ID) !== undefined;
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: W, height: TITLE + PLOT + AXIS };
  }

  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.plot.bind(scene);
    this.listen();
  }

  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.show();
  }

  /** The board zoomed: the level of detail may change. */
  zoomed(): void {
    if (this.alive) this.show();
  }

  private listen(): void {
    for (const off of this.unlisten) off();
    const plot = `${POINTS_ID}:plot`;
    /** The reading under a world x. */
    const at = (x: number): number => this.start + ((x - this.x - LEFT) / PW) * this.span;
    let from = 0;
    this.unlisten = [
      this.router.on(POINTS_ID, "wheel", (e) => {
        const input = e.input as { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
        if (input.ctrlKey || input.metaKey) return;
        e.stopPropagation();
        // A sideways gesture pans; up and down zooms, however a trackpad wobbles on the way.
        const { zoom: dy, pan } = this.gesture.read(input);
        if (pan !== 0) this.view(this.start + (pan / PW) * this.span, this.span);
        else {
          // Zoom about the reading under the pointer, from the whole year down to 40 readings.
          const pivot = at(e.point.x);
          const span = Math.max(40, Math.min(N, this.span * Math.exp(dy * 0.002)));
          this.view(pivot - ((pivot - this.start) * span) / this.span, span);
        }
      }),
      this.router.on(plot, "dragstart", (e) => {
        e.stopPropagation();
        from = this.start;
      }),
      this.router.on(plot, "drag", (e) => {
        e.stopPropagation();
        this.view(from - (e.total!.x / PW) * this.span, this.span);
      }),
    ];
  }

  /** Shows `span` readings from `start`, kept within the year. */
  private view(start: number, span: number): void {
    this.span = span;
    this.start = Math.max(0, Math.min(N - span, start));
    this.show();
  }

  private show(): void {
    const t0 = performance.now();
    const scale = PW / this.span;
    const vr = this.vmax - this.vmin;
    // Readings per screen pixel, as a power of two: what decides between bars, a line and dots.
    const perPixel = this.span / (PW * this.host.zoom());
    const detail = Math.floor(Math.log2(perPixel));
    const redrew = this.plot.show({
      transform: { a: scale, b: 0, c: 0, d: -PLOT / vr, e: this.x + LEFT - this.start * scale, f: this.y + TITLE + PLOT + (this.vmin * PLOT) / vr },
      // A pixel short of the frame's bottom, so the plot leaves its border showing.
      visible: { x: this.x + LEFT, y: this.y + TITLE, width: PW, height: PLOT + AXIS - 1 },
      clip: true,
      detail,
    });
    if (redrew) {
      const ms = performance.now() - t0;
      const shown = duration(this.span * STEP);
      this.frame.setState({
        note: `${Math.round(this.span).toLocaleString("en-US")} readings (${shown}) as ${this.mode}: ${this.drawnPoints.toLocaleString("en-US")} drawn in ${ms.toFixed(1)} ms`,
      });
    }
    this.host.render();
  }

  private draw(ctx: RecordingContext, window: Rect, detail: number): void {
    const first = Math.max(0, Math.floor(window.x));
    const last = Math.min(N - 1, Math.ceil(window.x + window.width));
    // Coordinates relative to the first reading drawn, so a deep zoom keeps its precision on the GPU.
    ctx.translate(first, 0);
    const vr = this.vmax - this.vmin;
    // A white plot behind the data, so a drag anywhere on it pans.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, this.vmin - (vr * AXIS) / PLOT, last - first + 1, vr * (1 + AXIS / PLOT));
    this.grid(ctx, first, last);
    if (detail >= 0) {
      // A bar per pixel column, from the lowest reading in it to the highest:
      // read off the pyramid from 16 readings a pixel up, scanned below that.
      const level = Math.min(detail, this.levels.length - 1);
      const size = 2 ** level;
      const b0 = Math.floor(first / size);
      const b1 = Math.floor(last / size);
      const bin = (b: number): [number, number] => {
        if (level >= 4) return [this.levels[level]!.min[b]!, this.levels[level]!.max[b]!];
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = b * size, end = Math.min(N, i + size); i < end; i++) {
          const v = this.values[i]!;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        return [lo, hi];
      };
      const lows: number[] = [];
      ctx.beginPath();
      for (let b = b0; b <= b1; b++) {
        const [lo, hi] = bin(b);
        lows.push(lo);
        ctx.lineTo(b * size - first, hi);
      }
      for (let b = b1; b >= b0; b--) ctx.lineTo(Math.min(N, b * size + size) - first, lows[b - b0]!);
      ctx.closePath();
      ctx.fillStyle = "#2563eb";
      ctx.fill();
      this.drawnPoints = b1 - b0 + 1;
      this.mode = "a bar per pixel";
      return;
    }
    // A line through every reading, and once they are 8 pixels apart, a dot for each.
    const t = ctx.getTransform();
    this.strokeLine(ctx, first, last, t);
    this.drawnPoints = last - first + 1;
    this.mode = detail <= -3 ? "dots" : "a line";
    if (detail > -3) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, t.e, 0);
    ctx.fillStyle = "#1d4ed8";
    for (let i = first; i <= last; i++) {
      const v = this.values[i]!;
      const when = new Date(YEAR + i * STEP).toISOString().replace("T", " ").slice(0, 19);
      // Each dot is a group with its reading, which the board's tooltip shows on hover.
      ctx.beginGroup({ id: `p${i}`, meta: { datum: `${when}\n${v.toFixed(2)} °C` } });
      ctx.beginPath();
      ctx.arc(t.a * (i - first), t.d * v + t.f, 3.5 / this.host.zoom(), 0, Math.PI * 2);
      ctx.fill();
      ctx.endGroup();
    }
    ctx.restore();
  }

  /** The line in world space, so its width doesn't stretch with the time axis. */
  private strokeLine(ctx: RecordingContext, first: number, last: number, t: { a: number; d: number; e: number; f: number }): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, t.e, 0);
    ctx.beginPath();
    for (let i = first; i <= last; i++) ctx.lineTo(t.a * (i - first), t.d * this.values[i]! + t.f);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5 / this.host.zoom();
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  /** Time ticks for the zoom, with labels under the plot, in world space so the text keeps its shape. */
  private grid(ctx: RecordingContext, first: number, last: number): void {
    const t = ctx.getTransform();
    const ms = (last - first) * STEP;
    const perTick = (ms * 110) / Math.max(1, Math.abs(t.a) * (last - first));
    const step = TICKS.find((s) => s >= perTick) ?? TICKS.at(-1)!;
    const startT = YEAR + first * STEP;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, t.e, 0);
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const top = this.y + TITLE;
    for (let tick = Math.ceil(startT / step) * step; tick <= YEAR + last * STEP; tick += step) {
      const x = t.a * ((tick - YEAR) / STEP - first);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(x, top, 1, PLOT);
      ctx.fillStyle = "#64748b";
      ctx.fillText(label(tick, step), x, top + PLOT + 9);
    }
    ctx.restore();
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const H = TITLE + PLOT + AXIS;
    return {
      id: `${POINTS_ID}:frame`,
      parent: POINTS_ID,
      state: { note: "" },
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y },
      draw: (c, s) => {
        c.shadowColor = "rgba(15, 23, 42, 0.16)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(0, 0, W, H, 10);
        c.fillStyle = "#ffffff";
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 1;
        c.stroke();
        c.textBaseline = "middle";
        c.font = `600 15px ${FONT}`;
        c.fillStyle = "#0f172a";
        c.fillText("Ten million points: a year of readings", 14, TITLE / 2);
        c.font = `12px ${FONT}`;
        c.fillStyle = "#64748b";
        c.textAlign = "right";
        c.fillText(`${s.note}. Wheel zooms time, drag pans.`, W - 14, TITLE / 2);
        // The temperature scale.
        const vr = this.vmax - this.vmin;
        for (let v = Math.ceil(this.vmin / 5) * 5; v <= this.vmax; v += 5) {
          const y = TITLE + PLOT - ((v - this.vmin) / vr) * PLOT;
          c.fillText(`${v}°`, LEFT - 8, y);
        }
        c.textAlign = "left";
      },
    };
  }
}
