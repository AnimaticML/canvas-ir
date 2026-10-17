import { parseColor } from "./color";
import { type Box, expandBox, isEmptyBox, rectToBox } from "./geometry/bounds";
import type { Scene, SceneChange } from "./geometry/scene";
import { applyToPoint, invert, multiply } from "./math";
import { type ReplayTarget, replayOp } from "./replay";
import type { FillOp, ImageOp, Matrix2D, Op, Rect, TextOp } from "./types";

/** An offscreen canvas the renderer draws a layer or a downscaled image into: its context, and what to pass to `drawImage`. */
export interface Surface {
  readonly context: ReplayTarget;
  readonly image: unknown;
}

export interface LevelOfDetail {
  /** Text whose font is smaller than this many device pixels is drawn as a gray bar per op ("greeking"). Default 3; 0 turns it off. */
  readonly textBelow?: number;
  /** Ops whose paint box is narrower and shorter than this many device pixels are skipped. Default 0.5; 0 turns it off. */
  readonly skipBelow?: number;
  /** Images drawn at under half their size are drawn from a copy halved as many times as fits. Default true. */
  readonly images?: boolean;
}

export interface RendererOptions {
  /** Resolves `ImageRef.src` to something `drawImage` takes, as for `replayDocument`. */
  readonly images?: (src: string) => unknown;
  /** A CSS color painted under everything. Default none: the canvas stays transparent where nothing is drawn. */
  readonly background?: string;
  /** Simplify what is too small to see. On by default; `false` draws everything exactly as a full replay does. */
  readonly lod?: LevelOfDetail | false;
  /** Makes an offscreen surface, for layers and downscaled images. Default an `OffscreenCanvas` where there is one. */
  readonly createSurface?: (width: number, height: number) => Surface | null;
  /** When the changed area is more than this share of the canvas, everything is redrawn instead. Default 0.5. */
  readonly fullRedrawShare?: number;
}

/** What one `render` did. */
export interface RenderStats {
  /** `full`: everything in view was drawn. `partial`: only `rects`. `layers`: the lifted ops between two cached layers. `idle`: nothing had changed. */
  readonly mode: "full" | "partial" | "layers" | "idle";
  /** Ops replayed. */
  readonly ops: number;
  /** The device-pixel rects redrawn, for a partial render. */
  readonly rects: readonly Rect[];
}

/** Composite operations that change pixels outside what the op paints: they clear what the source doesn't cover. */
const UNBOUNDED = new Set(["copy", "source-in", "source-out", "destination-in", "destination-atop"]);

/** Pixels an anti-aliased edge, smoothing or a text's overhang may reach past an op's box. */
const BLEED = 2;

const AA_FREE = (r: Box): Box => ({ minX: Math.floor(r.minX), minY: Math.floor(r.minY), maxX: Math.ceil(r.maxX), maxY: Math.ceil(r.maxY) });

const area = (b: Box): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);

const union = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

const meets = (a: Box, b: Box): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/** The device box of a world rect under the view. */
const toDevice = (view: Matrix2D, r: Rect): Box => {
  const corners = [
    applyToPoint(view, r.x, r.y),
    applyToPoint(view, r.x + r.width, r.y),
    applyToPoint(view, r.x, r.y + r.height),
    applyToPoint(view, r.x + r.width, r.y + r.height),
  ];
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
};

const toWorld = (inverse: Matrix2D, b: Box): Rect => {
  const corners = [
    applyToPoint(inverse, b.minX, b.minY),
    applyToPoint(inverse, b.maxX, b.minY),
    applyToPoint(inverse, b.minX, b.maxY),
    applyToPoint(inverse, b.maxX, b.maxY),
  ];
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  return { x: minX, y: minY, width: Math.max(...corners.map((p) => p.x)) - minX, height: Math.max(...corners.map((p) => p.y)) - minY };
};

/** A length in a canvas `filter`, in pixels; null for units that depend on fonts or the viewport. */
const filterLength = (value: string): number | null => {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] || n === 0 ? n : null;
};

/**
 * How far past its box an op's shadow or filter paints, in device pixels: a
 * function that grows a box, or null when the reach can't be bounded (a
 * filter the renderer doesn't know). Shadow offsets and blur, and filter
 * lengths, ignore the transform, so they are device pixels already.
 */
const effectReach = (op: Op): ((b: Box) => Box) | null => {
  if (op.kind === "clear") return (b) => b;
  const { shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, filter } = op.compositing;
  const steps: ((b: Box) => Box)[] = [];
  const shadow = (dx: number, dy: number, blur: number) => (b: Box) => union(b, expandBox({ minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy }, blur * 2));
  if ((parseColor(shadowColor)?.a ?? 1) > 0 && (shadowBlur > 0 || shadowOffsetX !== 0 || shadowOffsetY !== 0)) steps.push(shadow(shadowOffsetX, shadowOffsetY, shadowBlur));
  if (filter && filter !== "none") {
    const functions = filter.match(/[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/gi) ?? [];
    if (functions.join(" ").replace(/\s+/g, "") !== filter.replace(/\s+/g, "")) return null;
    for (const f of functions) {
      const name = f.slice(0, f.indexOf("(")).toLowerCase();
      const args = f.slice(f.indexOf("(") + 1, -1).trim();
      if (name === "blur") {
        const r = filterLength(args || "0");
        if (r === null) return null;
        steps.push((b) => expandBox(b, r * 3));
      } else if (name === "drop-shadow") {
        const lengths = args.replace(/(rgba?|hsla?)\([^)]*\)/gi, "").split(/\s+/).map(filterLength).filter((n): n is number => n !== null);
        if (lengths.length < 2) return null;
        steps.push(shadow(lengths[0]!, lengths[1]!, lengths[2] ?? 0));
      } else if (!["brightness", "contrast", "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia"].includes(name)) {
        return null;
      }
    }
  }
  return steps.length === 0 ? (b) => b : (b) => steps.reduce((box, step) => step(box), b);
};

const fontPixels = (font: string): number | null => {
  const m = /(\d*\.?\d+)px/.exec(font);
  return m ? Number(m[1]) : null;
};

const scaleOf = (m: Matrix2D): number => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

/** A text op as a bar across its ink box, the middle half of its height, at half its alpha. */
const greeked = (op: TextOp): FillOp => {
  const m = op.metrics;
  const left = op.x - m.actualBoundingBoxLeft;
  const right = op.x + m.actualBoundingBoxRight;
  const top = op.y - m.actualBoundingBoxAscent;
  const bottom = op.y + m.actualBoundingBoxDescent;
  const y0 = top + (bottom - top) / 4;
  const y1 = bottom - (bottom - top) / 4;
  return {
    kind: "fill",
    id: op.id,
    transform: op.transform,
    compositing: { ...op.compositing, globalAlpha: op.compositing.globalAlpha / 2 },
    ...(op.clip ? { clip: op.clip } : {}),
    fillRule: "nonzero",
    paint: typeof op.paint === "string" ? op.paint : "#888888",
    path: {
      matrices: [op.transform],
      subpaths: [
        {
          m: 0,
          start: { x: left, y: y0 },
          segments: [
            { kind: "line", m: 0, to: { x: right, y: y0 } },
            { kind: "line", m: 0, to: { x: right, y: y1 } },
            { kind: "line", m: 0, to: { x: left, y: y1 } },
          ],
          closed: true,
        },
      ],
    },
  };
};

/**
 * An `OffscreenCanvas` made like the target's canvas: with its context
 * attributes, since a canvas read from often is rasterized on the CPU and
 * another may be on the GPU, which anti-aliases differently.
 */
const surfaceLike =
  (target: ReplayTarget) =>
  (width: number, height: number): Surface | null => {
    if (typeof OffscreenCanvas === "undefined") return null;
    const attributes = (target as { getContextAttributes?: () => CanvasRenderingContext2DSettings }).getContextAttributes?.() ?? {};
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const context = canvas.getContext("2d", attributes) as unknown as ReplayTarget | null;
    // A stand-in OffscreenCanvas, such as one that only measures text, can't be drawn on.
    return typeof context?.drawImage === "function" && typeof context.save === "function" ? { context, image: canvas } : null;
  };

interface Lifted {
  readonly ids: Set<string>;
  /** The lowest and highest lifted ops: ops below the first go in the lower layer, ops above the last in the upper one. */
  readonly first: string;
  readonly last: string;
  readonly lower: Surface;
  readonly upper: Surface;
  lowerDamage: Box[];
  upperDamage: Box[];
}

/**
 * Draws a scene onto a canvas and keeps it current, redrawing only what
 * changed. It listens to the scene: each change marks where the op was and
 * where it is, shadows and filters included, as damaged. `render` then clips
 * to the damaged rects, clears them and replays, in drawing order, only the ops
 * that meet them, found through the scene's index. Ops outside the view are
 * never replayed. Composite operations that reach past what an op paints
 * (`copy`, `destination-in` and the like) and filters it can't bound make the
 * next render a full one.
 *
 * `lift(ids)` caches everything below and above the given ops in two layers,
 * so each frame of a drag draws one bitmap, the lifted ops, and another.
 */
export class Renderer {
  private view: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private inverse: Matrix2D = this.view;
  private width = 0;
  private height = 0;
  private full = true;
  private damage: Box[] = [];
  /** Ops whose shadow or filter paints past their box, with how far; and ops that need a full redraw whenever they change. */
  private readonly effects = new Map<string, (b: Box) => Box>();
  private readonly unbounded = new Set<string>();
  private readonly mips = new Map<string, Surface[]>();
  private lifted: Lifted | null = null;
  private scratchSurface: Surface | null = null;
  private scratchSize = "";
  private readonly makeSurface: (width: number, height: number) => Surface | null;
  private readonly lod: LevelOfDetail | null;
  private readonly unlisten: () => void;

  constructor(
    private readonly scene: Scene,
    private readonly target: ReplayTarget,
    private readonly options: RendererOptions = {},
  ) {
    this.makeSurface = options.createSurface ?? surfaceLike(target);
    this.lod = options.lod === false ? null : (options.lod ?? {});
    for (const op of scene.document.ops) this.classify(op);
    this.unlisten = scene.onChange((change) => this.changed(change));
  }

  /**
   * Sets the device matrix (world to canvas pixels) and the canvas size in
   * pixels. A pan by whole pixels moves what is on the canvas and redraws only
   * the strips it uncovers; any other change makes the next render a full one.
   */
  setView(view: Matrix2D, width: number, height: number): void {
    const before = this.view;
    this.view = view;
    this.inverse = invert(view) ?? view;
    const dx = view.e - before.e;
    const dy = view.f - before.f;
    const pan =
      width === this.width &&
      height === this.height &&
      view.a === before.a &&
      view.b === before.b &&
      view.c === before.c &&
      view.d === before.d &&
      Math.abs(dx - Math.round(dx)) < 1e-9 &&
      Math.abs(dy - Math.round(dy)) < 1e-9;
    this.width = width;
    this.height = height;
    if (pan && !this.full && !this.lifted && this.unbounded.size === 0 && this.scroll(Math.round(dx), Math.round(dy))) return;
    this.full = true;
    if (this.lifted) this.lift([...this.lifted.ids]);
  }

  /** Moves the canvas's pixels by whole pixels, through the scratch canvas, and marks the uncovered strips as damaged. */
  private scroll(dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return true;
    const { width: w, height: h } = this;
    if (Math.abs(dx) >= w || Math.abs(dy) >= h) return false;
    const source = (this.target as { canvas?: unknown }).canvas;
    const scratch = source ? this.scratch() : null;
    if (!source || !scratch) return false;
    const s = scratch.context;
    s.save();
    s.setTransform(1, 0, 0, 1, 0, 0);
    resetState(s);
    s.clearRect(0, 0, w, h);
    s.drawImage(source as never, 0, 0, w, h, 0, 0, w, h);
    s.restore();
    const t = this.target;
    t.save();
    t.setTransform(1, 0, 0, 1, 0, 0);
    resetState(t);
    t.clearRect(0, 0, w, h);
    t.drawImage(scratch.image as never, 0, 0, w, h, dx, dy, w, h);
    t.restore();
    this.damage = this.damage.map((b) => ({ minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy }));
    if (dx > 0) this.merge({ minX: 0, minY: 0, maxX: dx, maxY: h });
    if (dx < 0) this.merge({ minX: w + dx, minY: 0, maxX: w, maxY: h });
    if (dy > 0) this.merge({ minX: 0, minY: 0, maxX: w, maxY: dy });
    if (dy < 0) this.merge({ minX: 0, minY: h + dy, maxX: w, maxY: h });
    return true;
  }

  /** Marks a device-pixel rect, or the whole canvas, to be redrawn: after an image loads, or after the host drew over the canvas. */
  invalidate(rect?: Rect): void {
    if (!rect) this.full = true;
    else this.addDamage(rectToBox(rect));
  }

  /** Stops listening to the scene. */
  dispose(): void {
    this.unlisten();
    this.lifted = null;
  }

  /**
   * Caches what is drawn below and above these ops (or groups) in two layers,
   * until `drop`. Each render then draws the lower layer, the lifted ops and
   * whatever lies between them, then the upper layer. Changes to other ops
   * redraw their layer in place. Returns false, and keeps redrawing partially,
   * when the upper layer can't be cached: it holds a clear or an op that isn't
   * composited `source-over`, which a cached layer can't reproduce, or no
   * surface could be made.
   */
  lift(ids: readonly string[]): boolean {
    this.lifted = null;
    const set = new Set<string>();
    for (const id of ids) {
      if (this.scene.getGroup(id)) for (const opId of this.scene.groupOps(id)) set.add(opId);
      else if (this.scene.get(id)) set.add(id);
    }
    if (set.size === 0) return false;
    const order = [...set].sort((a, b) => this.scene.indexOf(a) - this.scene.indexOf(b));
    const top = this.scene.indexOf(order.at(-1)!);
    const ops = this.scene.document.ops;
    for (let i = top + 1; i < ops.length; i++) if (!this.layerable(ops[i]!)) return false;
    const make = this.makeSurface;
    const lower = make(this.width, this.height);
    const upper = make(this.width, this.height);
    if (!lower || !upper) return false;
    this.lifted = { ids: set, first: order[0]!, last: order.at(-1)!, lower, upper, lowerDamage: [], upperDamage: [] };
    const bounds = this.layerBounds();
    this.draw(lower.context, [{ minX: 0, minY: 0, maxX: this.width, maxY: this.height }], (z) => z < bounds.first, true);
    this.draw(upper.context, [{ minX: 0, minY: 0, maxX: this.width, maxY: this.height }], (z) => z > bounds.last, false);
    this.full = true;
    return true;
  }

  /** Ends `lift`. The next render redraws everything, so no difference a layer made lingers. */
  drop(): void {
    if (!this.lifted) return;
    this.lifted = null;
    this.full = true;
  }

  get isLifted(): boolean {
    return this.lifted !== null;
  }

  /** Brings the canvas up to date. */
  render(): RenderStats {
    const screen: Box = { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
    if (this.lifted) return this.renderLayers(screen);
    if (!this.full && this.damage.length === 0) return { mode: "idle", ops: 0, rects: [] };
    const rects = this.full ? [] : disjoint(this.damage.map((b) => clamp(AA_FREE(b), screen)).filter((b) => !isEmptyBox(b) && area(b) > 0));
    const share = rects.reduce((sum, r) => sum + area(r), 0) / Math.max(1, area(screen));
    this.damage = [];
    if (this.full || share > (this.options.fullRedrawShare ?? 0.5)) {
      this.full = false;
      return { mode: "full", ops: this.draw(this.target, [screen], () => true, true), rects: [] };
    }
    if (rects.length === 0) return { mode: "idle", ops: 0, rects: [] };
    return { mode: "partial", ops: this.draw(this.target, rects, () => true, true), rects: rects.map(boxRect) };
  }

  private renderLayers(screen: Box): RenderStats {
    const lifted = this.lifted!;
    const bounds = this.layerBounds();
    let count = 0;
    const settle = (damage: Box[]): Box[] => disjoint(damage.map((b) => clamp(AA_FREE(b), screen)).filter((b) => area(b) > 0));
    const lowerRects = settle(lifted.lowerDamage);
    const upperRects = settle(lifted.upperDamage);
    lifted.lowerDamage = [];
    lifted.upperDamage = [];
    if (lowerRects.length > 0) count += this.draw(lifted.lower.context, lowerRects, (z) => z < bounds.first, true);
    if (upperRects.length > 0) count += this.draw(lifted.upper.context, upperRects, (z) => z > bounds.last, false);
    let rects = this.full ? [screen] : settle(this.damage);
    this.full = false;
    this.damage = [];
    if (rects.length === 0) return { mode: "idle", ops: count, rects: [] };
    const share = rects.reduce((sum, r) => sum + area(r), 0) / Math.max(1, area(screen));
    if (share > (this.options.fullRedrawShare ?? 0.5)) rects = [screen];
    // The lower layer, the lifted ops and whatever lies between them, and the upper layer, in the damaged rects.
    count += this.draw(this.target, rects, (z) => z >= bounds.first && z <= bounds.last, false, true, lifted);
    return { mode: "layers", ops: count, rects: rects.map(boxRect) };
  }

  private layerBounds(): { first: number; last: number } {
    const l = this.lifted!;
    return { first: this.scene.indexOf(l.first), last: this.scene.indexOf(l.last) };
  }

  /** Whether an op above the lifted ones can live in the cached upper layer. */
  private layerable(op: Op): boolean {
    return op.kind !== "clear" && op.compositing.globalCompositeOperation === "source-over";
  }

  /**
   * Replays, into `target`, the ops in drawing order that `keep` accepts (by
   * index) and that meet the rects. With `clear`, the rects are cleared first
   * and the background painted. Only the rects change.
   *
   * Chromium rasterizes a path differently under a clip, and on a canvas of
   * another size, so ops aren't replayed under a clip to the rects: they are
   * replayed whole onto a scratch canvas the size of the target, and the rects
   * copied over. Then every pixel is what a full replay would paint.
   */
  private draw(
    target: ReplayTarget,
    rects: readonly Box[],
    keep: (z: number) => boolean,
    background: boolean,
    clear = true,
    layers?: { readonly lower: Surface; readonly upper: Surface },
  ): number {
    const ids = new Set<string>(this.unbounded);
    for (const id of this.effects.keys()) ids.add(id);
    for (const r of rects) for (const id of this.scene.opsIn(toWorld(this.inverse, expandBox(r, BLEED)))) ids.add(id);
    const ops = [...ids]
      .map((id) => ({ id, z: this.scene.indexOf(id) }))
      .filter(({ z }) => z >= 0 && keep(z))
      .sort((a, b) => a.z - b.z)
      .map(({ id }) => this.scene.get(id)!);
    const whole = rects.length === 1 && rects[0]!.minX <= 0 && rects[0]!.minY <= 0 && rects[0]!.maxX >= this.width && rects[0]!.maxY >= this.height;
    const scratch = whole || !clear ? null : this.scratch();
    const into = scratch ? scratch.context : target;
    into.save();
    into.setTransform(1, 0, 0, 1, 0, 0);
    resetState(into);
    if (!whole && !scratch) {
      // No scratch canvas: clip instead, exact up to how the clip changes rasterization.
      rectsPath(into, rects);
      into.clip();
    }
    const blit = (surface: Surface): void => {
      for (const r of rects) {
        const w = r.maxX - r.minX;
        const h = r.maxY - r.minY;
        into.drawImage(surface.image as never, r.minX, r.minY, w, h, r.minX, r.minY, w, h);
      }
    };
    if (clear) {
      for (const r of rects) into.clearRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
      if (layers) blit(layers.lower);
      else if (background && this.options.background) {
        into.fillStyle = this.options.background;
        rectsPath(into, rects);
        into.fill();
      }
    }
    let count = 0;
    for (const op of ops) {
      if (!this.unbounded.has(op.id)) {
        const box = this.deviceBox(op);
        if (!box || !rects.some((r) => meets(box, r))) continue;
        if (this.tooSmall(op, box)) continue;
      }
      this.replay(into, op);
      count++;
    }
    if (layers) {
      into.setTransform(1, 0, 0, 1, 0, 0);
      resetState(into);
      blit(layers.upper);
    }
    into.restore();
    if (scratch) {
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      resetState(target);
      for (const r of rects) {
        const w = r.maxX - r.minX;
        const h = r.maxY - r.minY;
        target.clearRect(r.minX, r.minY, w, h);
        target.drawImage(scratch.image as never, r.minX, r.minY, w, h, r.minX, r.minY, w, h);
      }
      target.restore();
    }
    return count;
  }

  /** The scratch canvas partial redraws are drawn on, the size of the target. */
  private scratch(): Surface | null {
    if (this.scratchSurface && this.scratchSize === `${this.width}x${this.height}`) return this.scratchSurface;
    this.scratchSurface = this.makeSurface(this.width, this.height);
    this.scratchSize = `${this.width}x${this.height}`;
    return this.scratchSurface;
  }

  private replay(target: ReplayTarget, op: Op): void {
    const lod = this.lod;
    const images = this.options.images;
    const opts = { view: this.view, ...(images ? { images } : {}) };
    if (lod && op.kind === "text" && (lod.textBelow ?? 3) > 0) {
      const px = fontPixels(op.style.font);
      if (px !== null && px * scaleOf(multiply(this.view, op.transform)) < (lod.textBelow ?? 3)) {
        replayOp(target, greeked(op), opts);
        return;
      }
    }
    if (lod && op.kind === "image" && lod.images !== false) {
      const smaller = this.downscaled(op);
      if (smaller) {
        replayOp(target, smaller.op, { view: this.view, images: () => smaller.image });
        return;
      }
    }
    replayOp(target, op, opts);
  }

  /** An image op drawn from a halved copy when it appears at under half its size. */
  private downscaled(op: ImageOp): { op: ImageOp; image: unknown } | null {
    const shown = scaleOf(multiply(this.view, op.transform)) * Math.sqrt((op.dest.width * op.dest.height) / Math.max(1e-9, op.source.width * op.source.height));
    const level = Math.min(8, Math.floor(Math.log2(1 / shown)));
    if (!(level >= 1)) return null;
    const source = this.options.images?.(op.image.src);
    if (source === undefined || source === null) return null;
    const make = this.makeSurface;
    let chain = this.mips.get(op.image.src);
    if (!chain) this.mips.set(op.image.src, (chain = []));
    const { width, height } = op.image;
    while (chain.length < level) {
      const k = chain.length + 1;
      const w = Math.max(1, Math.ceil(width / 2 ** k));
      const h = Math.max(1, Math.ceil(height / 2 ** k));
      const surface = make(w, h);
      if (!surface) return null;
      const from = k === 1 ? source : chain[k - 2]!.image;
      const fw = k === 1 ? width : Math.max(1, Math.ceil(width / 2 ** (k - 1)));
      const fh = k === 1 ? height : Math.max(1, Math.ceil(height / 2 ** (k - 1)));
      surface.context.imageSmoothingEnabled = true;
      surface.context.imageSmoothingQuality = "high";
      surface.context.drawImage(from as never, 0, 0, fw, fh, 0, 0, w, h);
      chain.push(surface);
    }
    const s = 2 ** level;
    const w = Math.max(1, Math.ceil(width / s));
    const h = Math.max(1, Math.ceil(height / s));
    const sx = w / width;
    const sy = h / height;
    const src = op.source;
    return {
      op: { ...op, source: { x: src.x * sx, y: src.y * sy, width: src.width * sx, height: src.height * sy } },
      image: chain[level - 1]!.image,
    };
  }

  private tooSmall(op: Op, box: Box): boolean {
    if (!this.lod || op.kind === "clear") return false;
    const below = this.lod.skipBelow ?? 0.5;
    if (below <= 0) return false;
    // The box has the bleed added on each side.
    return box.maxX - box.minX - 2 * BLEED < below && box.maxY - box.minY - 2 * BLEED < below;
  }

  /** Where an op paints on the canvas: its index box under the view, grown by its shadow or filter and the bleed. */
  private deviceBox(op: Op): Box | null {
    const rect = this.scene.bounds(op.id, "index");
    if (!rect) return null;
    return this.grow(op, toDevice(this.view, rect));
  }

  private grow(op: Op, box: Box): Box {
    const reach = this.effects.get(op.id);
    return expandBox(reach ? reach(box) : box, BLEED);
  }

  private classify(op: Op): void {
    this.effects.delete(op.id);
    this.unbounded.delete(op.id);
    if (op.kind !== "clear" && UNBOUNDED.has(op.compositing.globalCompositeOperation)) {
      this.unbounded.add(op.id);
      return;
    }
    const reach = effectReach(op);
    if (reach === null) this.unbounded.add(op.id);
    else if (op.kind !== "clear" && (op.compositing.filter !== "none" || (op.compositing.shadowColor && (parseColor(op.compositing.shadowColor)?.a ?? 1) > 0))) {
      // Only ops whose effect actually reaches past their box need the slow path.
      const probe = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const grown = reach(probe);
      if (grown.minX < 0 || grown.minY < 0 || grown.maxX > 1 || grown.maxY > 1) this.effects.set(op.id, reach);
    }
  }

  private changed(change: SceneChange): void {
    const { before, after, id } = change;
    let everything = false;
    if (before) {
      if (this.unbounded.has(id)) everything = true;
      // The old box grows by the old effects: classify hasn't seen the new op yet.
      if (before.box) this.addDamage(this.grow(before.op, toDevice(this.view, before.box)), before.op, change);
    }
    if (after) {
      this.classify(after.op);
      if (this.unbounded.has(id)) everything = true;
      if (after.box) this.addDamage(this.grow(after.op, toDevice(this.view, after.box)), after.op, change);
    } else {
      this.effects.delete(id);
      this.unbounded.delete(id);
    }
    if (everything) {
      this.full = true;
      this.lifted = null;
    }
  }

  private addDamage(box: Box, op?: Op, change?: SceneChange): void {
    const lifted = this.lifted;
    if (lifted && op && change) {
      if (change.before && !change.after && lifted.ids.has(change.id)) {
        // A lifted op went away (its component redrew): the layers no longer split the scene where they did.
        this.lifted = null;
        this.full = true;
        return;
      }
      const z = this.scene.indexOf(change.id);
      const { first, last } = this.layerBounds();
      if (z >= 0 && z > last && !this.layerable(op)) {
        this.lifted = null;
        this.full = true;
        return;
      }
      // Removed ops were in whichever layer their box was drawn into: redraw both there.
      if (z < first) lifted.lowerDamage.push(box);
      if (z > last || z < 0) lifted.upperDamage.push(box);
    } else if (lifted) {
      lifted.lowerDamage.push(box);
      lifted.upperDamage.push(box);
    }
    this.merge(box);
  }

  /** Adds a damaged box, merged with one it overlaps when that adds little area. */
  private merge(box: Box): void {
    for (let i = 0; i < this.damage.length; i++) {
      const d = this.damage[i]!;
      const u = union(d, box);
      if (area(u) <= (area(d) + area(box)) * 1.25) {
        this.damage.splice(i, 1);
        this.merge(u);
        return;
      }
    }
    this.damage.push(box);
    if (this.damage.length > 16) this.damage = [this.damage.reduce(union)];
  }
}

/** The same area as rects that don't overlap, so blitting a translucent layer into each lands once per pixel. */
const disjoint = (rects: readonly Box[]): Box[] => {
  const out: Box[] = [];
  for (const rect of rects) {
    let pieces = [rect];
    for (const taken of out) {
      pieces = pieces.flatMap((p) => {
        if (!meets(p, taken)) return [p];
        const parts: Box[] = [];
        if (p.minY < taken.minY) parts.push({ ...p, maxY: taken.minY });
        if (p.maxY > taken.maxY) parts.push({ ...p, minY: taken.maxY });
        const minY = Math.max(p.minY, taken.minY);
        const maxY = Math.min(p.maxY, taken.maxY);
        if (p.minX < taken.minX) parts.push({ minX: p.minX, maxX: taken.minX, minY, maxY });
        if (p.maxX > taken.maxX) parts.push({ minX: taken.maxX, maxX: p.maxX, minY, maxY });
        return parts;
      });
    }
    out.push(...pieces);
  }
  return out.filter((b) => area(b) > 0);
};

const clamp = (b: Box, to: Box): Box => ({ minX: Math.max(b.minX, to.minX), minY: Math.max(b.minY, to.minY), maxX: Math.min(b.maxX, to.maxX), maxY: Math.min(b.maxY, to.maxY) });

const boxRect = (b: Box): Rect => ({ x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });

const rectsPath = (t: ReplayTarget, rects: readonly Box[]): void => {
  t.beginPath();
  for (const r of rects) {
    t.moveTo(r.minX, r.minY);
    t.lineTo(r.maxX, r.minY);
    t.lineTo(r.maxX, r.maxY);
    t.lineTo(r.minX, r.maxY);
    t.closePath();
  }
};

const resetState = (t: ReplayTarget): void => {
  t.globalAlpha = 1;
  t.globalCompositeOperation = "source-over";
  // Chromium composites differently once `filter` has been assigned, even "none", so it is only set when it isn't.
  if (t.filter !== "none") t.filter = "none";
  t.shadowColor = "rgba(0, 0, 0, 0)";
  t.shadowBlur = 0;
  t.shadowOffsetX = 0;
  t.shadowOffsetY = 0;
};
