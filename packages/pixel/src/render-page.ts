// The renderer, checked in the browser. Every fixture is recorded into one
// board, each in its own group; random edits then move, rotate, recolor,
// remove and add ops, and after each one a partial render must match a full
// replay of the board pixel for pixel. Lifted layers must match within
// rounding. A drag on a 10,000-op board is timed frame by frame.
import { RecordingContext, RecordingPath2D, Renderer, Scene, multiply, replayDocument, type Matrix2D, type Op, type RecordingContextOptions } from "canvas-ir";
import { HEIGHT, WIDTH, fixtures, type FixtureEnv } from "./fixtures";

export interface RenderCheck {
  readonly name: string;
  readonly frames: number;
  /** How many renders were partial, used layers, or redrew everything. */
  readonly modes: Readonly<Record<string, number>>;
  /** Frames with interior pixels that differ from a full replay. */
  readonly mismatched: number;
  /** Edge pixels that differed, over all frames, and the largest difference in any channel. */
  readonly edgePixels: number;
  readonly maxDelta: number;
  /**
   * The same after pans, which move pixels where a full replay rasterizes
   * again: Chromium anti-aliases an edge a little differently at another
   * offset, even a whole pixel away, and a hairline may land a pixel over.
   */
  readonly panned?: { readonly frames: number; readonly edgePixels: number; readonly maxDelta: number };
  readonly error?: string;
}

export interface DragBench {
  readonly mode: string;
  readonly frames: number;
  readonly median: number;
  readonly p99: number;
  readonly opsPerFrame: number;
}

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
const imagesById = new Map<string, unknown>([["image-0", image]]);
const recorderOptions: RecordingContextOptions = {
  describeImage: (img) => {
    const source = img as { width?: number; height?: number };
    return source.width && source.height ? { src: "image-0", width: source.width, height: source.height } : null;
  },
};

let seed = 1;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

const COLUMNS = 8;
const CANVAS = { width: 1280, height: 600 };
const VIEW: Matrix2D = { a: 0.78, b: 0, c: 0, d: 0.78, e: 12, f: 20 };

/** The fixtures tiled into one board, each in a group named after it. */
const fixtureBoard = async (): Promise<RecordingContext> => {
  const ctx = new RecordingContext(recorderOptions);
  const fixtureEnv: FixtureEnv = { Path2D: RecordingPath2D as unknown as FixtureEnv["Path2D"], image };
  fixtures.forEach((fixture, i) => {
    ctx.save();
    ctx.translate((i % COLUMNS) * (WIDTH + 10), Math.floor(i / COLUMNS) * (HEIGHT + 10));
    ctx.beginGroup({ id: `tile-${i}`, meta: { name: fixture.name } });
    fixture.draw(ctx as unknown as CanvasRenderingContext2D, fixtureEnv);
    ctx.endGroup();
    ctx.restore();
  });
  return ctx;
};

const canvasPair = () => {
  const make = () => {
    const canvas = new OffscreenCanvas(CANVAS.width, CANVAS.height);
    return canvas.getContext("2d", { willReadFrequently: true })!;
  };
  return { ours: make(), full: make() };
};

const fullReplay = (ctx: OffscreenCanvasRenderingContext2D, scene: Scene, background: string, view = VIEW): void => {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  replayDocument(ctx, scene.document, { view, images: (src) => imagesById.get(src) });
};

let lastDiff = "";
/**
 * Compares two canvases. Returns how many differing pixels are interior: their
 * 3 x 3 neighbourhood in the reference is one flat color, so no edge is near.
 * Chromium anti-aliases an edge slightly differently depending on what else it
 * rasterized in the same pass, so edge pixels may differ a little.
 */
const compare = (
  a: OffscreenCanvasRenderingContext2D,
  b: OffscreenCanvasRenderingContext2D,
): { interior: number; interiorMax: number; edge: number; max: number } => {
  const { width, height } = CANVAS;
  const x = a.getImageData(0, 0, width, height).data;
  const y = b.getImageData(0, 0, width, height).data;
  let max = 0;
  let interior = 0;
  const samples: string[] = [];
  let interiorMax = 0;
  let edge = 0;
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  const flat = (px: number, py: number): boolean => {
    const at = (py * width + px) * 4;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const q = (qy * width + qx) * 4;
        if (y[q] !== y[at] || y[q + 1] !== y[at + 1] || y[q + 2] !== y[at + 2] || y[q + 3] !== y[at + 3]) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!), Math.abs(x[i + 3]! - y[i + 3]!));
    if (d === 0) continue;
    const px = (i >> 2) % width;
    const py = Math.floor((i >> 2) / width);
    if (flat(px, py)) {
      if (d > 2 && samples.length < 6) samples.push(`${px},${py} ours ${x.slice(i, i + 4).join(",")} full ${y.slice(i, i + 4).join(",")}`);
      interior++;
      interiorMax = Math.max(interiorMax, d);
      box = [Math.min(box[0]!, px), Math.min(box[1]!, py), Math.max(box[2]!, px), Math.max(box[3]!, py)];
    } else edge++;
    if (d > max) max = d;
  }
  lastDiff = `${interior} interior and ${edge} edge pixels differ, by up to ${max}, interior in ${box.join(",")}: ${samples.join("; ")}`;
  return { interior, interiorMax, edge, max };
};

const translate = (dx: number, dy: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
const rotateAbout = (angle: number, x: number, y: number): Matrix2D =>
  multiply(translate(x, y), multiply({ a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 0, f: 0 }, translate(-x, -y)));

/** One random edit: move or rotate a tile or an op, recolor or remove an op, or add a box (sometimes with a shadow or blur). */
const edit = (scene: Scene, step: number): string => {
  const ops = scene.document.ops;
  const pick = ops[Math.floor(random() * ops.length)]!;
  const tile = `tile-${Math.floor(random() * fixtures.length)}`;
  const r = random();
  const where = (id: string) => `${id} in ${scene.groupChain(id).map((g) => scene.getGroup(g)?.meta?.["name"] ?? g).join("/")}`;
  if (r < 0.3) {
    scene.transform(tile, translate((random() - 0.5) * 120, (random() - 0.5) * 80));
    return `move ${scene.getGroup(tile)?.meta?.["name"]}`;
  } else if (r < 0.4) {
    const b = scene.bounds(tile);
    if (b) scene.transform(tile, rotateAbout((random() - 0.5) * 0.6, b.x + b.width / 2, b.y + b.height / 2));
    return `rotate ${scene.getGroup(tile)?.meta?.["name"]}`;
  } else if (r < 0.6) {
    scene.transform(pick.id, translate((random() - 0.5) * 60, (random() - 0.5) * 60));
    return `move op ${where(pick.id)} (${pick.kind})`;
  } else if (r < 0.7 && pick.kind === "fill" && typeof pick.paint === "string") {
    scene.replace({ ...pick, paint: `rgb(${Math.floor(random() * 255)}, 90, ${Math.floor(random() * 255)})` });
    return `recolor ${where(pick.id)}`;
  } else if (r < 0.8) {
    const w = where(pick.id);
    scene.remove(pick.id);
    return `remove ${w} (${pick.kind})`;
  } else {
    const ctx = new RecordingContext(recorderOptions);
    if (random() < 0.3) {
      ctx.shadowColor = "rgba(0, 0, 80, 0.6)";
      ctx.shadowBlur = random() * 8;
      ctx.shadowOffsetX = (random() - 0.5) * 30;
      ctx.shadowOffsetY = (random() - 0.5) * 30;
    } else if (random() < 0.3) {
      ctx.filter = `blur(${(random() * 4).toFixed(1)}px)`;
    }
    ctx.fillStyle = `hsl(${Math.floor(random() * 360)} 70% 50% / 0.8)`;
    ctx.fillRect(random() * 1600, random() * 650, 10 + random() * 60, 10 + random() * 40);
    const op = ctx.getDocument().ops[0]! as Op;
    scene.insert({ ...op, id: `added-${step}` }, Math.floor(random() * (ops.length + 1)));
    return "add";
  }
};

const BACKGROUND = "#fbfaf7";

const checkPartial = async (): Promise<RenderCheck> => {
  seed = 11;
  const scene = new Scene((await fixtureBoard()).getDocument());
  const { ours, full } = canvasPair();
  const renderer = new Renderer(scene, ours, { images: (src) => imagesById.get(src), background: BACKGROUND, lod: false });
  renderer.setView(VIEW, CANVAS.width, CANVAS.height);
  const modes: Record<string, number> = {};
  let mismatched = 0;
  let edgePixels = 0;
  let maxDelta = 0;
  const frames = 200;
  const failures: string[] = [];
  let view = VIEW;
  const panned = { frames: 0, edgePixels: 0, maxDelta: 0 };
  for (let step = 0; step < frames; step++) {
    let what = step > 0 ? edit(scene, step) : "start";
    if (step % 7 === 3) {
      // A pan by whole pixels, which moves what is on the canvas.
      view = { ...view, e: view.e + Math.round((random() - 0.5) * 80), f: view.f + Math.round((random() - 0.5) * 60) };
      renderer.setView(view, CANVAS.width, CANVAS.height);
      what += " and pan";
    }
    const stats = renderer.render();
    modes[stats.mode] = (modes[stats.mode] ?? 0) + 1;
    fullReplay(full, scene, BACKGROUND, view);
    const d = compare(ours, full);
    if (what.endsWith("pan")) {
      panned.frames++;
      panned.edgePixels += d.edge;
      panned.maxDelta = Math.max(panned.maxDelta, d.max);
    } else {
      edgePixels += d.edge;
      maxDelta = Math.max(maxDelta, d.max);
    }
    if (d.interior > 0) {
      mismatched++;
      if (failures.length < 5) failures.push(`step ${step} (${what}, ${stats.mode} ${JSON.stringify(stats.rects)}): ${lastDiff}`);
    }
    if (d.interior > 0 || d.edge > 0) {
      // Start over from a full render, so each difference is counted once.
      renderer.invalidate();
      renderer.render();
    }
  }
  return { name: "partial redraws after random edits and pans", frames, modes, mismatched, edgePixels, maxDelta, panned, ...(failures.length ? { error: failures.join("; ") } : {}) };
};

let lastEdit = "";
const checkLayers = async (): Promise<RenderCheck> => {
  seed = 23;
  const scene = new Scene((await fixtureBoard()).getDocument());
  const { ours, full } = canvasPair();
  const renderer = new Renderer(scene, ours, { images: (src) => imagesById.get(src), background: BACKGROUND, lod: false });
  renderer.setView(VIEW, CANVAS.width, CANVAS.height);
  renderer.render();
  const modes: Record<string, number> = {};
  let mismatched = 0;
  let edgePixels = 0;
  let maxDelta = 0;
  let frames = 0;
  const failures: string[] = [];
  for (let drag = 0; drag < 16; drag++) {
    const tile = `tile-${Math.floor(random() * fixtures.length)}`;
    const lifted = renderer.lift([tile]);
    modes[lifted ? "lifted" : "refused"] = (modes[lifted ? "lifted" : "refused"] ?? 0) + 1;
    for (let step = 0; step < 8; step++) {
      scene.transform(tile, translate((random() - 0.5) * 40, (random() - 0.5) * 30));
      // Now and then something else changes mid-drag, as text that wraps around the dragged shape does.
      const what = step % 3 === 2 ? (lastEdit = edit(scene, drag * 100 + step)) : `drag after ${lastEdit}`;
      const stats = renderer.render();
      const mode = `${stats.mode} ${JSON.stringify(stats.rects)}`;
      modes[stats.mode] = (modes[stats.mode] ?? 0) + 1;
      fullReplay(full, scene, BACKGROUND);
      const d = compare(ours, full);
      edgePixels += d.edge;
      maxDelta = Math.max(maxDelta, d.max);
      // Compositing a cached layer rounds translucent pixels once more: off by 2 at most.
      if (d.interiorMax > 2) {
        mismatched++;
        if (failures.length < 5) failures.push(`drag ${drag} of ${tile}, step ${step} (${what}, ${mode}): ${lastDiff}`);
      }
      frames++;
    }
    renderer.drop();
    renderer.render();
  }
  return { name: "lifted layers while dragging tiles", frames, modes, mismatched, edgePixels, maxDelta, ...(failures.length ? { error: failures.join("; ") } : {}) };
};

const run = async (check: () => Promise<RenderCheck>, name: string): Promise<RenderCheck> => {
  try {
    return await check();
  } catch (error) {
    return { name, frames: 0, modes: {}, mismatched: 0, edgePixels: 0, maxDelta: 0, error: String((error as Error)?.stack ?? error) };
  }
};

(globalThis as unknown as { runRender: () => Promise<RenderCheck[]> }).runRender = async () => [
  await run(checkPartial, "partial redraws after random edits and pans"),
  await run(checkLayers, "lifted layers while dragging tiles"),
];

/** A 10,000-op board, as in the geometry benchmark, seen whole on a 1200 x 800 canvas. */
const bigBoard = (): Scene => {
  seed = 42;
  const ctx = new RecordingContext(recorderOptions);
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  for (let i = 0; i < 10_000; i++) {
    ctx.save();
    ctx.translate(between(0, 4000), between(0, 2600));
    ctx.rotate(between(0, Math.PI * 2));
    ctx.fillStyle = `hsl(${i % 360} 60% 55%)`;
    ctx.strokeStyle = `hsl(${(i * 7) % 360} 50% 35%)`;
    ctx.beginPath();
    switch (i % 4) {
      case 0:
        ctx.rect(-40, -30, 80, 60);
        ctx.fill();
        break;
      case 1:
        ctx.arc(0, 0, between(10, 50), 0, Math.PI * 2);
        ctx.fill();
        break;
      case 2:
        ctx.lineWidth = between(1, 8);
        ctx.moveTo(-50, 0);
        ctx.bezierCurveTo(-20, -60, 20, 60, 50, 0);
        ctx.stroke();
        break;
      case 3:
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.ellipse(0, 0, 50, 25, 0.3, 0, Math.PI * 1.5);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }
  return new Scene(ctx.getDocument());
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

(globalThis as unknown as { runDragBench: () => DragBench[] }).runDragBench = () => {
  const view: Matrix2D = { a: 0.3, b: 0, c: 0, d: 0.3, e: 0, f: 0 };
  const size = { width: 1200, height: 800 };
  const results: DragBench[] = [];
  for (const what of ["a shape", "a panel a third of the view"]) {
    for (const mode of ["full replay", "partial", "layers"]) {
      const scene = bigBoard();
      let dragged = scene.document.ops[5000]!.id;
      if (what !== "a shape") {
        // A translucent panel in the middle of the stack, over half the shapes.
        const ctx = new RecordingContext(recorderOptions);
        ctx.fillStyle = "rgba(40, 80, 160, 0.5)";
        ctx.fillRect(800, 600, 2200, 1400);
        dragged = "panel";
        scene.insert({ ...ctx.getDocument().ops[0]!, id: dragged }, 5000);
      }
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext("2d")!;
      const renderer = new Renderer(scene, ctx, { background: BACKGROUND, lod: false });
      renderer.setView(view, size.width, size.height);
      renderer.render();
      if (mode === "layers") {
        renderer.lift([dragged]);
        renderer.render();
      }
      const times: number[] = [];
      let ops = 0;
      const frames = mode === "full replay" ? 20 : 200;
      for (let frame = 0; frame < frames; frame++) {
        const start = performance.now();
        scene.transform(dragged, translate(frame % 40 < 20 ? 6 : -6, 4 * Math.sin(frame / 5)));
        if (mode === "full replay") {
          fullReplay(ctx, scene, BACKGROUND, view);
          ops += scene.document.ops.length;
        } else {
          ops += renderer.render().ops;
        }
        // Reading a pixel waits for the drawing to finish.
        ctx.getImageData(0, 0, 1, 1);
        times.push(performance.now() - start);
      }
      renderer.dispose();
      results.push({ mode: `${what}, ${mode}`, frames, median: percentile(times, 0.5), p99: percentile(times, 0.99), opsPerFrame: ops / frames });
    }
  }
  return results;
};
