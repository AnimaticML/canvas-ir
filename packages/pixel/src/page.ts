// Bundled and loaded into the browser page by run.ts.
import {
  IDENTITY,
  type Matrix2D,
  RecordingContext,
  deserializeDocument,
  multiply,
  replayDocument,
  serializeDocument,
} from "canvas-ir";
import { HEIGHT, WIDTH, fixtures } from "./fixtures";

export interface Comparison {
  /** Pixels with any channel different. */
  readonly differentPixels: number;
  readonly maxChannelDelta: number;
  /** Differing pixels whose 3x3 neighbourhood in the reference is a single flat color, i.e. not on an edge. */
  readonly interiorPixels: number;
}

export interface FixtureResult {
  readonly name: string;
  readonly engineDeviation?: string;
  /** Replay against direct drawing with each transform call applied as a `setTransform` of the same matrix. */
  readonly exact?: Comparison;
  /** Replay against plain direct drawing. */
  readonly direct?: Comparison;
  readonly error?: string;
}

const context = (): CanvasRenderingContext2D => {
  const ctx = new OffscreenCanvas(WIDTH, HEIGHT).getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  return ctx as unknown as CanvasRenderingContext2D;
};

/**
 * Wraps a real context so `translate`, `rotate`, `scale` and `transform` reach it
 * as one `setTransform` with the composed matrix. Chromium rasterizes edges very
 * slightly differently depending on how a transform was built (it composes
 * transform calls in single precision), so this is the reference that isolates
 * what the IR stores from how the matrix was arrived at.
 */
const withComposedTransforms = (target: CanvasRenderingContext2D): CanvasRenderingContext2D => {
  let current: Matrix2D = IDENTITY;
  const stack: Matrix2D[] = [];
  const set = (m: Matrix2D): void => {
    if (!Object.values(m).every(Number.isFinite)) return;
    current = m;
    target.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  };
  const concat = (n: Matrix2D): void => set(multiply(current, n));
  const overrides: Record<string, unknown> = {
    save: () => {
      stack.push(current);
      target.save();
    },
    restore: () => {
      const m = stack.pop();
      if (m) current = m;
      target.restore();
    },
    translate: (x: number, y: number) => concat({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }),
    scale: (x: number, y: number) => concat({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }),
    rotate: (angle: number) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      concat({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => concat({ a, b, c, d, e, f }),
    setTransform: (...args: number[]) => {
      if (args.length === 6) set({ a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! });
      else throw new Error("fixture uses an unwrapped setTransform form");
    },
    resetTransform: () => set(IDENTITY),
  };
  return new Proxy(target, {
    get: (t, key) => {
      if (typeof key === "string" && key in overrides) return overrides[key];
      const value = Reflect.get(t, key, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
    set: (t, key, value) => Reflect.set(t, key, value, t),
  });
};

const compare = (reference: CanvasRenderingContext2D, actual: CanvasRenderingContext2D): Comparison => {
  const a = reference.getImageData(0, 0, WIDTH, HEIGHT).data;
  const b = actual.getImageData(0, 0, WIDTH, HEIGHT).data;
  const flat = (x: number, y: number): boolean => {
    const i = (y * WIDTH + x) * 4;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) continue;
        const j = (ny * WIDTH + nx) * 4;
        for (let c = 0; c < 4; c++) if (a[i + c] !== a[j + c]) return false;
      }
    }
    return true;
  };
  let differentPixels = 0;
  let maxChannelDelta = 0;
  let interiorPixels = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a[i + c]! - b[i + c]!));
      if (delta === 0) continue;
      differentPixels++;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (flat(x, y)) interiorPixels++;
    }
  }
  return { differentPixels, maxChannelDelta, interiorPixels };
};

const run = (): FixtureResult[] =>
  fixtures.map(({ name, draw, engineDeviation }) => {
    try {
      const recorder = new RecordingContext({ width: WIDTH, height: HEIGHT });
      draw(recorder as unknown as CanvasRenderingContext2D);
      const document = deserializeDocument(serializeDocument(recorder.getDocument()));
      const replayed = context();
      replayDocument(replayed, document);

      const direct = context();
      draw(direct);
      const composed = context();
      draw(withComposedTransforms(composed));

      const result = { name, exact: compare(composed, replayed), direct: compare(direct, replayed) };
      return engineDeviation ? { ...result, engineDeviation } : result;
    } catch (error) {
      return { name, error: String(error) };
    }
  });

(globalThis as { runFixtures?: () => FixtureResult[] }).runFixtures = run;
