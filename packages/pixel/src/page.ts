// Bundled and loaded into the browser page by run.ts.
import { Canvg } from "canvg";
import {
  IDENTITY,
  type IRDocument,
  type Matrix2D,
  type Op,
  RecordingContext,
  type RecordingContextOptions,
  RecordingPath2D,
  type ReplayOptions,
  Scene,
  deserializeDocument,
  multiply,
  replayDocument,
  replayOp,
  serializeDocument,
  toSVG,
} from "canvas-ir";
import { type FixtureEnv, HEIGHT, WIDTH, fixtures } from "./fixtures";
import "./outline-page";
import "./text-page";
import "./vectorize-page";

/** The fixtures' image: an opaque 16 by 12 checkerboard with a gradient, so smoothing and mirroring show. */
const makeImage = (): OffscreenCanvas => {
  const canvas = new OffscreenCanvas(16, 12);
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < 12; y += 4) {
    for (let x = 0; x < 16; x += 4) {
      ctx.fillStyle = `rgb(${x * 16}, ${y * 20}, ${(x + y) % 8 === 0 ? 220 : 60})`;
      ctx.fillRect(x, y, 4, 4);
    }
  }
  return canvas;
};

const image = makeImage();
const directEnv: FixtureEnv = { Path2D, image };
const recorderEnv: FixtureEnv = { Path2D: RecordingPath2D as unknown as FixtureEnv["Path2D"], image };

/** Images seen while recording, by the id the IR refers to them by, so replay can find the same object. */
const imageIds = new Map<unknown, string>();
const imagesById = new Map<string, unknown>();
const recorderOptions: RecordingContextOptions = {
  width: WIDTH,
  height: HEIGHT,
  describeImage: (img) => {
    const source = img as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const width = source.naturalWidth ?? source.width ?? 0;
    const height = source.naturalHeight ?? source.height ?? 0;
    if (!(width > 0 && height > 0)) return null;
    let src = imageIds.get(img);
    if (src === undefined) {
      src = `image-${imageIds.size}`;
      imageIds.set(img, src);
      imagesById.set(src, img);
    }
    return { src, width, height };
  },
};
const replayOptions: ReplayOptions = { images: (src) => imagesById.get(src) };

const record = (draw: (typeof fixtures)[number]["draw"]) => {
  const recorder = new RecordingContext(recorderOptions);
  draw(recorder as unknown as CanvasRenderingContext2D, recorderEnv);
  return recorder.getDocument();
};

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
    // Chromium re-maps the current path on every transform change, even to the same matrix, so skip those as replay does.
    if (m.a === current.a && m.b === current.b && m.c === current.c && m.d === current.d && m.e === current.e && m.f === current.f) {
      return;
    }
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
  const proxy: CanvasRenderingContext2D = new Proxy(target, {
    get: (t, key) => {
      if (typeof key === "string" && key in overrides) return overrides[key];
      const value = Reflect.get(t, key, t);
      return typeof value === "function" ? unwrapThis(value, proxy, t) : value;
    },
    set: (t, key, value) => Reflect.set(t, key, value, t),
  });
  return proxy;
};

const wrappers = new WeakMap<object, Map<Function, Function>>();

/**
 * A method that runs on `target` when called on `proxy` and on its own `this`
 * otherwise. Not a bound function: canvg saves a context's `beginPath` and later
 * writes it back onto the prototype, so what we hand out must work for every
 * context, not just this one.
 */
const unwrapThis = (fn: Function, proxy: object, target: object): Function => {
  let cache = wrappers.get(proxy);
  if (!cache) wrappers.set(proxy, (cache = new Map()));
  let wrapper = cache.get(fn);
  if (!wrapper) {
    wrapper = function (this: unknown, ...args: unknown[]) {
      return fn.apply(this === proxy ? target : this, args);
    };
    cache.set(fn, wrapper);
  }
  return wrapper;
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
      const document = deserializeDocument(serializeDocument(record(draw)));
      const replayed = context();
      replayDocument(replayed, document, replayOptions);

      const direct = context();
      draw(direct, directEnv);
      const composed = context();
      draw(withComposedTransforms(composed), directEnv);

      const result = { name, exact: compare(composed, replayed), direct: compare(direct, replayed) };
      return engineDeviation ? { ...result, engineDeviation } : result;
    } catch (error) {
      return { name, error: String(error) };
    }
  });

export interface GeometryResult {
  readonly name: string;
  readonly engineDeviation?: string;
  /** Sample points compared, over all ops of the fixture. */
  readonly compared: number;
  /** How many points the scene and Chromium disagree on, away from any edge. */
  readonly mismatchCount: number;
  /** The first few of them. */
  readonly mismatches: readonly string[];
}

/**
 * Builds the op's path and state on a real context without painting, so
 * Chromium's own isPointInPath / isPointInStroke can answer for it.
 */
const preparedContext = (op: Op): CanvasRenderingContext2D => {
  const ctx = context();
  const prepared = new Proxy(ctx, {
    get: (t, key) => {
      if (key === "fill" || key === "stroke" || key === "restore") return () => {};
      const value = Reflect.get(t, key, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
    set: (t, key, value) => Reflect.set(t, key, value, t),
  });
  replayOp(prepared, op, replayOptions);
  return ctx;
};

/** Chromium's answer to "is this point painted by the op", for a fill or a stroke: its path test and, since isPointInPath ignores the clip, a path test per clip region. */
const pathOracle = (op: Op & { kind: "fill" | "stroke" }): ((x: number, y: number) => boolean) => {
  const ctx = preparedContext(op);
  const clips = (op.clip ?? []).map((region) => {
    const { clip: _, ...rest } = op;
    const asFill = { ...rest, kind: "fill", transform: region.transform, path: region.path, fillRule: region.fillRule, paint: "#000" };
    const clipCtx = preparedContext(asFill as unknown as Op);
    return (x: number, y: number) => clipCtx.isPointInPath(x, y, region.fillRule);
  });
  const inPath = (x: number, y: number): boolean =>
    op.kind === "fill" ? ctx.isPointInPath(x, y, op.fillRule) : ctx.isPointInStroke(x, y);
  return (x, y) => inPath(x, y) && clips.every((inClip) => inClip(x, y));
};

/**
 * For images and text, which Chromium can't hit-test: the op painted alone,
 * read back per pixel. Returns true for fully covered pixels, false for
 * untouched ones and null for partly covered ones.
 */
const coverageOracle = (op: Op): ((x: number, y: number) => boolean | null) => {
  const ctx = context();
  // Paint text opaque so coverage shows in alpha.
  replayOp(ctx, op.kind === "text" ? { ...op, compositing: { ...op.compositing, globalAlpha: 1 } } : op, replayOptions);
  const data = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  return (x, y) => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) return false;
    const alpha = data[(py * WIDTH + px) * 4 + 3]!;
    return alpha === 255 ? true : alpha === 0 ? false : null;
  };
};

const STEP = 0.73;
const EDGE = 0.35;
const NEIGHBOURS = [
  [EDGE, 0],
  [-EDGE, 0],
  [0, EDGE],
  [0, -EDGE],
] as const;

const runGeometry = (): GeometryResult[] =>
  fixtures.map(({ name, draw, engineDeviation }) => checkGeometry(name, record(draw), engineDeviation));

const checkGeometry = (name: string, document: IRDocument, engineDeviation?: string): GeometryResult => {
  let compared = 0;
  let mismatchCount = 0;
  const mismatches: string[] = [];
  for (const op of document.ops) {
    if (op.kind === "clear") continue;
    const scene = new Scene({ version: 1, ops: [op] }, { tolerance: 0.01 });
    const pixels = op.kind === "fill" || op.kind === "stroke" ? null : coverageOracle(op);
    // Pixel coverage is only known on whole pixels, so sample their centres and step a pixel to find edges.
    const oracle = pixels ?? pathOracle(op as Op & { kind: "fill" | "stroke" });
    const step = pixels ? 1 : STEP;
    const neighbours = pixels ? NEIGHBOURS.map(([dx, dy]) => [dx / EDGE, dy / EDGE] as const) : NEIGHBOURS;
    for (let y = 0.5; y < HEIGHT; y += step) {
      for (let x = 0.5; x < WIDTH; x += step) {
        const expected = oracle(x, y);
        if (op.kind === "text") {
          // Text is hit-tested by its ink box, which holds the glyphs but also the gaps between them,
          // so check only that every pixel the text touches is within a pixel of the box.
          if (expected === false) continue;
        } else {
          if (expected === null) continue;
          if (neighbours.some(([dx, dy]) => oracle(x + dx, y + dy) !== expected)) continue;
        }
        compared++;
        const tolerance = op.kind === "text" ? 1 : 0;
        const actual = scene.hitTest({ x, y }, { includeInvisible: true, tolerance }).length > 0;
        if (actual === (expected ?? true)) continue;
        mismatchCount++;
        if (mismatches.length < 5) {
          mismatches.push(`${op.id} at (${x.toFixed(2)}, ${y.toFixed(2)}): scene ${actual}, Chromium ${expected}`);
        }
      }
    }
  }
  const result = { name, compared, mismatchCount, mismatches };
  return engineDeviation ? { ...result, engineDeviation } : result;
};

export interface CorpusResult {
  readonly fixture: FixtureResult;
  readonly geometry?: GeometryResult;
  /** Ops by kind in the recorded document. */
  readonly ops?: Record<string, number>;
}

/** Renders an SVG with canvg, the way an app using it would. */
const renderSvg = async (ctx: CanvasRenderingContext2D, svg: string): Promise<void> => {
  // canvg's clipPath swaps beginPath and closePath on the context's prototype; put the originals back afterwards.
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const { beginPath, closePath } = proto;
  try {
    await draw(ctx, svg);
  } finally {
    Object.assign(proto, { beginPath, closePath });
  }
};

const draw = async (ctx: CanvasRenderingContext2D, svg: string): Promise<void> => {
  const canvg = Canvg.fromString(ctx, svg, {
    ignoreDimensions: true,
    ignoreClear: true,
    ignoreMouse: true,
    ignoreAnimation: true,
  });
  await canvg.render();
};

/** The corpus: each SVG drawn by canvg directly, and recorded, serialized and replayed; then hit-tested. */
const runCorpus = async (
  files: readonly { name: string; svg: string; engineDeviation?: string }[],
): Promise<CorpusResult[]> => {
  const results: CorpusResult[] = [];
  for (const { name, svg, engineDeviation } of files) {
    try {
      const recorder = new RecordingContext(recorderOptions);
      await renderSvg(recorder as unknown as CanvasRenderingContext2D, svg);
      const recorded = recorder.getDocument();
      const document = deserializeDocument(serializeDocument(recorded));
      const replayed = context();
      replayDocument(replayed, document, replayOptions);
      const direct = context();
      await renderSvg(direct, svg);
      const composed = context();
      await renderSvg(withComposedTransforms(composed), svg);
      const ops: Record<string, number> = {};
      for (const op of recorded.ops) ops[op.kind] = (ops[op.kind] ?? 0) + 1;
      const fixture = { name, exact: compare(composed, replayed), direct: compare(direct, replayed) };
      results.push({
        fixture: engineDeviation ? { ...fixture, engineDeviation } : fixture,
        geometry: checkGeometry(name, recorded, engineDeviation),
        ops,
      });
    } catch (error) {
      results.push({ fixture: { name, error: String(error) } });
    }
  }
  return results;
};

export interface SvgResult {
  readonly name: string;
  readonly comparison?: Comparison;
  /** Differing pixels by more than a sixteenth of the channel range, outside a one-pixel band around edges. */
  readonly far?: number;
  readonly engineDeviation?: string;
  readonly error?: string;
}

const dataUrls = new Map<string, string>();
const imageDataUrl = async (src: string): Promise<string> => {
  let url = dataUrls.get(src);
  if (url === undefined) {
    const source = imagesById.get(src) as CanvasImageSource & { width: number; height: number; naturalWidth?: number; naturalHeight?: number };
    const canvas = new OffscreenCanvas(source.naturalWidth ?? source.width, source.naturalHeight ?? source.height);
    canvas.getContext("2d")!.drawImage(source, 0, 0);
    const blob = await canvas.convertToBlob();
    url = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
    dataUrls.set(src, url);
  }
  return url;
};

/** Draws the document's SVG export as Chromium renders an `<img>` of it. */
const renderExport = async (document: IRDocument): Promise<CanvasRenderingContext2D> => {
  const urls = new Map<string, string>();
  for (const op of document.ops) {
    const ref = op.kind === "image" ? op.image : undefined;
    const paints = op.kind === "fill" || op.kind === "text" ? [op.paint] : op.kind === "stroke" ? [op.stroke.paint] : [];
    for (const p of paints) if (typeof p !== "string" && p.kind === "pattern") urls.set(p.image.src, await imageDataUrl(p.image.src));
    if (ref) urls.set(ref.src, await imageDataUrl(ref.src));
  }
  const svg = toSVG(document, { width: WIDTH, height: HEIGHT, images: (src) => urls.get(src) ?? src });
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const ctx = context();
  ctx.drawImage(img, 0, 0);
  lastExport = svg;
  return ctx;
};
let lastExport = "";

/** Pixels differing by more than 16 whose 5x5 neighbourhood in the reference is flat: wrong paint, not anti-aliasing. */
const farPixels = (reference: CanvasRenderingContext2D, actual: CanvasRenderingContext2D): number => {
  const a = reference.getImageData(0, 0, WIDTH, HEIGHT).data;
  const b = actual.getImageData(0, 0, WIDTH, HEIGHT).data;
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a[i + c]! - b[i + c]!));
      if (delta <= 16) continue;
      let flat = true;
      for (let dy = -2; dy <= 2 && flat; dy++) {
        for (let dx = -2; dx <= 2 && flat; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) continue;
          const j = (ny * WIDTH + nx) * 4;
          for (let c = 0; c < 4; c++) if (Math.abs(a[i + c]! - a[j + c]!) > 2) flat = false;
        }
      }
      if (flat) count++;
    }
  }
  return count;
};

/** Every fixture and corpus file exported to SVG, rendered by Chromium and compared with the canvas replay. */
const runSvg = async (files: readonly { name: string; svg: string; svgDeviation?: string }[]): Promise<SvgResult[]> => {
  const documents: { name: string; svgDeviation?: string; load: () => Promise<IRDocument> }[] = [
    ...fixtures.map((f) => ({ name: f.name, ...(f.svgDeviation ? { svgDeviation: f.svgDeviation } : {}), load: async () => record(f.draw) })),
    ...files.map((f) => ({
      name: f.name,
      ...(f.svgDeviation ? { svgDeviation: f.svgDeviation } : {}),
      load: async () => {
        const recorder = new RecordingContext(recorderOptions);
        await renderSvg(recorder as unknown as CanvasRenderingContext2D, f.svg);
        return recorder.getDocument();
      },
    })),
  ];
  const results: SvgResult[] = [];
  for (const { name, svgDeviation, load } of documents) {
    try {
      const document = await load();
      const replayed = context();
      replayDocument(replayed, document, replayOptions);
      const exported = await renderExport(document);
      const result = { name, comparison: compare(replayed, exported), far: farPixels(replayed, exported) };
      if (name === (globalThis as { svgDebug?: string }).svgDebug) {
        (globalThis as { svgDebugOut?: unknown }).svgDebugOut = {
          svg: lastExport,
          replay: await (await (replayed.canvas as unknown as OffscreenCanvas).convertToBlob()).arrayBuffer().then((b) => [...new Uint8Array(b)]),
          exported: await (await (exported.canvas as unknown as OffscreenCanvas).convertToBlob()).arrayBuffer().then((b) => [...new Uint8Array(b)]),
        };
      }
      results.push(svgDeviation ? { ...result, engineDeviation: svgDeviation } : result);
    } catch (error) {
      results.push({ name, error: String(error) });
    }
  }
  return results;
};

(globalThis as { runSvg?: typeof runSvg }).runSvg = runSvg;
(globalThis as { runFixtures?: () => FixtureResult[] }).runFixtures = run;
(globalThis as { runGeometry?: () => GeometryResult[] }).runGeometry = runGeometry;
(globalThis as { runCorpus?: typeof runCorpus }).runCorpus = runCorpus;
