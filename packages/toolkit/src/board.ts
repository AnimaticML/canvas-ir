// A board: drawings in a scene on a canvas you pan and zoom, picked, outlined, dragged with snapping and lassoed,
// drawn on with the tools, joined by connectors that follow what they hold, with a layer of cards over it and a
// mirror for screen readers, drawn once a frame. What is on it, and what a change means, is the host's: the board tells
// it what moved, what was drawn and what was deleted, and the host keeps it (saves it, records it for undo).
//
// The host owns the scene's content and may swap in a new scene (`setScene`), as the playground does each time it adds
// a sample. Everything that keeps the scene (router, renderer, mirror, components) is wired to it again.
import {
  AccessibilityLayer,
  type AccessibleNode,
  Components,
  EventRouter,
  IDENTITY,
  type Matrix2D,
  type Point,
  RecordingContext,
  type RecordingContextOptions,
  type Rect,
  Renderer,
  type RendererOptions,
  type RenderStats,
  type RouterEvent,
  Scene,
  type SnapKind,
  type JsonValue,
  type IRDocument,
  applyToPoint,
  multiply,
} from "canvas-ir";
import type { CardLayer } from "./cards";
import { type Connector, drawArrow, drawRing, fromMeta, route, toMeta } from "./connectors";
import { textSink } from "./controls";
import { Gestures } from "./gestures";
import { type ToolName, Tools } from "./tools";
import { Viewport, wheelPixels, wheelZoom } from "./viewport";
import { WheelGesture } from "./wheel";

/** How the board snaps a dragged thing or a tool's point, read each time it does. */
export interface SnapSettings {
  readonly on: boolean;
  /** In screen pixels. */
  readonly radius: number;
  readonly kinds: readonly SnapKind[];
  /** Whether text is something to snap to. */
  readonly text: boolean;
}

/**
 * The part of the page to draw, in CSS pixels, and canvas pixels per CSS pixel: for a host showing the board on a 3D
 * screen, which wants only that part, as sharp as its view of it needs. `ui` is canvas pixels per pixel of whoever is
 * looking, for outlines and marks. Null draws the whole board at the device's ratio.
 */
export interface DrawPart {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly ui?: number;
}

/** Something the host drags itself, as a simulated body follows the pointer: the board hands it the drag's points. */
export interface Grab {
  drag(world: Point): void;
  end(): void;
}

export interface BoardHooks {
  /** A new scene was wired: bind what else listens to it, such as content with its own handlers. */
  bound?(scene: Scene, router: EventRouter): void;
  /** Called before each frame: what must be in the scene for it, such as content that records lazily. */
  beforeDraw?(): void;
  /** Draws the board itself instead of the renderer, as a debugger stepping through ops does; true when it did. */
  paint?(ctx: CanvasRenderingContext2D, device: Matrix2D): boolean;
  /** What a frame drew, and how long it took. */
  drawn?(stats: RenderStats, ms: number): void;
  /** Draws more on the overlay, above the outlines and marks, in device pixels. */
  overlay?(ctx: CanvasRenderingContext2D, device: Matrix2D, ui: number): void;
  /** The view moved: anything keeping its own copy of it follows. */
  viewChanged?(view: Matrix2D): void;

  /** A press on something the host drags itself (a body in a simulation); null to let the board drag it. */
  grab?(e: RouterEvent): Grab | null;
  /** What moves with these, such as a window's frame and everything it holds. Default the ids themselves. */
  expand?(ids: readonly string[]): string[];
  /** What a snap must not land on while these are dragged, besides themselves: what moves along with them, such as text laid out around them. */
  following?(ids: readonly string[]): string[];
  /** One step of a drag moved this by (dx, dy): what depends on it follows, such as text laid out around it. */
  moved?(id: string, dx: number, dy: number): void;
  /** Something changed on the board that the host keeps: a drag ended, a drawing or arrow was added, things were deleted. */
  changed?(what: { readonly kind: "moved" | "drawn" | "connected" | "removed"; readonly ids: readonly string[] }): void;
  /** These were deleted; the board has taken them out of the scene. */
  removed?(ids: readonly string[]): void;
  /** The selection changed. */
  selected?(ids: readonly string[]): void;
  /** The pointer entered something on the board. */
  enter?(e: RouterEvent): void;
  /** Text to show beside the pointer over what is under it, as a chart's datum; null for none. */
  tooltip?(world: Point, path: readonly string[]): string | null;
  /** What an arrow's end would hold at a screen point; undefined to let the board say (`board:<outermost group>`). */
  keyAt?(screen: Point): string | null | undefined;
  /** The box of what an end's key holds; undefined to let the board say, for `board:` keys. */
  boxOf?(key: string): Rect | null | undefined;
  /** An op recorded on the board came from this source code, for a debugger. */
  recorded?(opId: string, source: string): void;
  /** The current tool changed. */
  tool?(name: ToolName): void;
  /** The accessibility mirror's tree changed. */
  mirror?(tree: readonly AccessibleNode[]): void;
  log?(line: string): void;
}

export interface BoardOptions {
  /** What the canvases fill, and where the mirror and the text tool's field go. */
  readonly stage: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Where outlines, marks and previews are drawn, over the board and its cards. */
  readonly overlay: HTMLCanvasElement;
  /** Cards over the board: they get the pointer where they are. */
  readonly cards?: CardLayer;
  readonly recorder?: RecordingContextOptions;
  /** The renderer's options, read each time it is made (`resetRenderer`). */
  readonly renderer?: () => RendererOptions;
  readonly snap?: () => SnapSettings;
  /** Keys that choose a tool. Default V, P, R, O, T and A. */
  readonly toolKeys?: Readonly<Record<string, ToolName>>;
  readonly hooks?: BoardHooks;
}

const TOOL_KEYS: Readonly<Record<string, ToolName>> = { v: "select", p: "pen", r: "rect", o: "ellipse", t: "text", a: "arrow" };
const SNAP_DEFAULT: SnapSettings = { on: true, radius: 8, kinds: ["vertex", "intersection", "center", "midpoint", "extreme", "baseline", "bounds", "path"], text: false };
const move = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

type Modifiers = { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

export class Board {
  scene: Scene;
  router: EventRouter;
  readonly components: Components;
  readonly viewport = new Viewport();
  readonly tools: Tools;
  readonly cards: CardLayer | undefined;
  /** The part of the page to draw, for a host showing it on a 3D screen; null for all of it. Set it, then `render`. */
  part: DrawPart | null = null;
  /** The part the last frame drew: what a host showing it reads, since the canvases change size a frame after it asks. */
  drawnPart: DrawPart | null = null;

  private renderer: Renderer;
  private readonly a11y: AccessibilityLayer;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly hooks: BoardHooks;
  private readonly fingers: Gestures;

  private selection: string[] = [];
  private hover: string | null = null;
  private hoverPath: readonly string[] = [];
  private tip: { text: string; x: number; y: number } | null = null;
  private dragging: { ids: string[]; anchors: Point[]; moved: Point } | null = null;
  private snapMark: { x: number; y: number; kind: string } | null = null;
  private lasso: Point[] | null = null;
  private panFrom: Point | null = null;
  private grabbed: Grab | null = null;
  /** Connectors on the board, by group id, with where each was last drawn, to tell when to draw it again. */
  private readonly connectors = new Map<string, string>();
  private connectorCount = 0;

  private frame = 0;
  private viewKey = "";
  private stepped = false;
  private wheelFree = false;
  private keysToCards = false;
  private cardPress = false;
  private boardPress = false;
  private overCards = false;
  private flight = 0;
  /** Whether a wheel burst on free board pans or zooms, chosen at its start and kept until it ends. */
  private readonly wheelGesture = new WheelGesture();

  constructor(private readonly options: BoardOptions) {
    this.hooks = options.hooks ?? {};
    this.cards = options.cards;
    this.ctx = options.canvas.getContext("2d")!;
    this.octx = options.overlay.getContext("2d")!;
    this.scene = new Scene({ version: 1, ops: [] });
    this.router = new EventRouter(this.scene, { tolerance: 3 });
    this.renderer = new Renderer(this.scene, this.ctx, options.renderer?.() ?? {});
    this.components = new Components(this.scene, this.router, {
      ...(options.recorder ? { recorder: options.recorder } : {}),
      onChange: () => {
        if (!this.overCards) options.canvas.style.cursor = this.cursor();
        this.render();
      },
    });
    this.a11y = new AccessibilityLayer(this.scene, options.stage, {
      onFocus: (id) => {
        this.keysToCards = false;
        this.router.focusOn(id);
      },
      // Enter or Space presses the control where it is drawn, as a click would.
      onActivate: (id) => {
        const b = this.scene.bounds(id);
        if (!b) return;
        const p = applyToPoint(this.view, b.x + b.width / 2, b.y + b.height / 2);
        this.router.pointerDown({ x: p.x, y: p.y, button: 0 });
        this.router.pointerUp({ x: p.x, y: p.y, button: 0 });
      },
      onChange: (tree) => this.hooks.mirror?.(tree),
    });
    this.tools = new Tools({
      scene: () => this.scene,
      toWorld: (screen) => this.router.toWorld(screen),
      pixel: () => 1 / this.viewport.zoom,
      snap: (world) => {
        const s = this.snapSettings();
        if (!s.on || s.kinds.length === 0) return null;
        const found = this.scene.snap(world, { radius: s.radius / this.viewport.zoom, kinds: [...s.kinds] });
        return found ? { point: found.point, kind: found.kind } : null;
      },
      keyAt: (screen) => this.keyAt(screen),
      boxOf: (key) => this.boxOf(key),
      connect: (from, to) => this.connect(from, to),
      commit: (id, draw) => {
        this.drawGroup(id, draw);
        this.select([id]);
        this.hooks.changed?.({ kind: "drawn", ids: [id] });
      },
      recorder: options.recorder ?? {},
      stage: options.stage,
      redraw: () => this.render(),
      log: (line) => this.hooks.log?.(line),
    });
    // Two fingers on the board pinch it: the press the first began is let go, and the board zooms and pans with them.
    this.fingers = new Gestures({
      cancel: () => {
        this.tools.cancel();
        this.router.pointerCancel();
      },
      pinch: ({ scale, center, pan }) => {
        this.viewport.zoomAt(scale, center);
        this.viewport.panBy(pan.x, pan.y);
      },
    });
    this.viewport.onChange(() => this.viewChanged());
    this.listen();
    this.wire(false);
  }

  /** World to CSS pixels over the board. */
  get view(): Matrix2D {
    return this.viewport.matrix;
  }

  get selected(): readonly string[] {
    return this.selection;
  }

  get hovered(): string | null {
    return this.hover;
  }

  /** Whether things on the board are being dragged. */
  get dragActive(): boolean {
    return this.dragging !== null;
  }

  // ---- The scene ----

  /** Puts a new scene on the board, and wires everything that keeps one to it. */
  setScene(scene: Scene): void {
    this.scene = scene;
    this.wire();
  }

  /** Makes the renderer again, as when its options changed. */
  resetRenderer(): void {
    this.renderer.dispose();
    this.renderer = new Renderer(this.scene, this.ctx, this.options.renderer?.() ?? {});
    this.viewKey = "";
    this.render();
  }

  /** Records a drawing into a group of its own on the board, replacing any group with that id. */
  drawGroup(id: string, draw: (c: RecordingContext) => void, meta: Record<string, JsonValue> = {}): void {
    const recorder = new RecordingContext(this.options.recorder ?? {});
    recorder.beginGroup({ id, meta: { source: "drawn", ...meta } });
    draw(recorder);
    recorder.endGroup();
    const sources = recorder.getSources();
    const doc = recorder.getDocument();
    this.scene.replaceGroup(id, doc).forEach((opId, i) => {
      const source = sources.get(doc.ops[i]!.id);
      if (source !== undefined) this.hooks.recorded?.(opId, source);
    });
  }

  /** The world box around some ops and groups. */
  boxOf(ids: readonly string[]): Rect | null;
  /** The box of what an arrow's end holds, by its key. */
  boxOf(key: string): Rect | null;
  boxOf(what: string | readonly string[]): Rect | null {
    if (typeof what !== "string") return union(what.map((id) => this.scene.bounds(id) ?? null));
    const hooked = this.hooks.boxOf?.(what);
    if (hooked !== undefined) return hooked;
    const id = what.startsWith("board:") ? what.slice("board:".length) : what;
    return this.exists(id) ? (this.scene.bounds(id) ?? null) : null;
  }

  /** A group on the board as a document of its own: the group, the groups inside it and their ops, to keep or load again. */
  documentOf(id: string): IRDocument {
    const all = this.scene.document.groups ?? [];
    const inside = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of all)
        if (g.parent !== undefined && inside.has(g.parent) && !inside.has(g.id)) {
          inside.add(g.id);
          grew = true;
        }
    }
    return { version: 1, groups: all.filter((g) => inside.has(g.id)), ops: this.scene.document.ops.filter((op) => op.group !== undefined && inside.has(op.group)) } as IRDocument;
  }

  /** The board's outermost groups, each as a document of its own: what a host keeps for undo or saves. */
  documents(): IRDocument[] {
    return (this.scene.document.groups ?? []).filter((g) => g.parent === undefined).map((g) => this.documentOf(g.id));
  }

  /** Puts a new scene of these documents (as `documents` gave) on the board, with their connectors following again. */
  load(documents: readonly IRDocument[]): void {
    const scene = new Scene({ version: 1, ops: [] });
    for (const d of documents) {
      const root = d.groups?.find((g) => g.parent === undefined);
      if (root) scene.replaceGroup(root.id, d);
    }
    this.selection = this.selection.filter((id) => scene.getGroup(id) !== undefined);
    this.hover = null;
    this.connectors.clear();
    this.setScene(scene);
    this.adoptConnectors();
    this.hooks.selected?.(this.selection);
  }

  exists(id: string): boolean {
    return this.scene.getGroup(id) !== undefined || this.scene.get(id) !== undefined;
  }

  // ---- Selection ----

  select(ids: readonly string[]): void {
    this.selection = [...ids];
    this.hooks.selected?.(this.selection);
    this.render();
  }

  /** Deletes things from the board, with any component drawn in them. */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) if (this.exists(id)) this.scene.remove(id);
    for (const id of this.components.ids) if (!this.scene.getGroup(id)) this.components.unmount(id);
    this.hover = null;
    this.hooks.removed?.(ids);
    this.select(this.selection.filter((id) => this.exists(id)));
    this.hooks.changed?.({ kind: "removed", ids });
  }

  /** Moves things by (dx, dy), with what moves with them. */
  moveBy(ids: readonly string[], dx: number, dy: number): void {
    for (const id of ids) {
      this.components.move(id, move(dx, dy));
      this.hooks.moved?.(id, dx, dy);
    }
    this.render();
  }

  // ---- Tools ----

  useTool(name: ToolName): void {
    this.tools.cancel();
    this.tools.current = name;
    this.hooks.tool?.(name);
    this.options.canvas.style.cursor = this.cursor();
    this.render();
  }

  // ---- Connectors ----

  /** Draws a connector, from where its ends are now, into its group, and keeps it following what it holds. */
  drawConnector(id: string, c: Connector): void {
    if (c.kind === "ring") {
      const box = c.from.key ? this.boxOf(c.from.key) : null;
      const b = box ?? { x: c.from.x - 75, y: c.from.y - 75, width: 150, height: 150 };
      const kept: Connector = { ...c, from: { ...c.from, x: b.x + b.width / 2, y: b.y + b.height / 2 } };
      this.drawGroup(id, (ctx) => drawRing(ctx, b, c), { connector: toMeta(kept) });
      this.connectors.set(id, JSON.stringify(b));
      return;
    }
    const { from, to } = route(c, (key) => this.boxOf(key));
    const kept: Connector = { ...c, from: { ...c.from, x: from.x, y: from.y }, to: { ...(c.to ?? c.from), x: to.x, y: to.y } };
    this.drawGroup(id, (ctx) => drawArrow(ctx, from, to, c), { connector: toMeta(kept) });
    this.connectors.set(id, JSON.stringify([from, to]));
  }

  /** Starts following the connectors already in the scene, as after it was loaded. */
  adoptConnectors(): void {
    for (const g of this.scene.document.groups ?? []) if (g.parent === undefined && fromMeta(g.meta)) this.connectors.set(g.id, "");
    this.reconnect();
  }

  isConnector(id: string): boolean {
    return this.connectors.has(id);
  }

  /** Puts a new arrow on the board from one end to the other, in the tools' stroke color. */
  connect(from: { key: string | null; point: Point }, to: { key: string | null; point: Point }): void {
    const id = `drawn-arrow-${Date.now().toString(36)}-${this.connectorCount++}`;
    const end = (e: typeof from) => (e.key ? { key: e.key, x: e.point.x, y: e.point.y } : { x: e.point.x, y: e.point.y });
    this.drawConnector(id, { kind: "arrow", from: end(from), to: end(to), bend: 0.12, color: this.tools.style.stroke, seed: 1 + Math.floor(Math.random() * 1e6) });
    this.select([id]);
    this.hooks.log?.(`arrow from ${from.key ?? "a point"} to ${to.key ?? "a point"}`);
    this.hooks.changed?.({ kind: "connected", ids: [id] });
  }

  /** What an arrow's end would hold at a screen point: the host's key, or the outermost group under it; null over empty board. */
  keyAt(screen: Point): string | null {
    const hooked = this.hooks.keyAt?.(screen);
    if (hooked !== undefined) return hooked;
    const outer = this.outerAt(screen);
    return outer === null || this.connectors.has(outer) ? null : `board:${outer}`;
  }

  /** The outermost group (or ungrouped op) under a screen point, or null. */
  outerAt(screen: Point): string | null {
    const hit = this.scene.hitTest(this.router.toWorld(screen), { tolerance: 4 / this.viewport.zoom })[0];
    return hit ? (hit.groups.at(-1) ?? hit.id) : null;
  }

  /** Draws again every connector whose ends moved; forgets the ones deleted. */
  reconnect(): void {
    for (const [id, last] of this.connectors) {
      const c = fromMeta(this.scene.getGroup(id)?.meta);
      if (!c) {
        this.connectors.delete(id);
        continue;
      }
      if (c.kind === "ring") {
        const box = c.from.key ? this.boxOf(c.from.key) : null;
        if (box && JSON.stringify(box) !== last) this.drawConnector(id, c);
        continue;
      }
      const { from, to } = route(c, (key) => this.boxOf(key));
      if (JSON.stringify([from, to]) !== last) this.drawConnector(id, c);
    }
  }

  /** A connector dragged as a whole: its loose ends go with it, and the held ones stay on what they hold. */
  private movedConnector(id: string, dx: number, dy: number): void {
    const c = fromMeta(this.scene.getGroup(id)?.meta);
    if (!c) return;
    const shift = (e: Connector["from"]): Connector["from"] => (e.key ? e : { x: e.x + dx, y: e.y + dy });
    this.drawConnector(id, { ...c, from: shift(c.from), ...(c.to ? { to: shift(c.to) } : {}) });
  }

  // ---- The view ----

  setView(next: Matrix2D): void {
    this.viewport.setMatrix(next);
  }

  /** The box of the board's drawing and its cards. */
  contentBox(): Rect | null {
    return union([this.cards?.bounds() ?? null, ...this.scene.document.ops.map((op) => this.scene.bounds(op.id) ?? null)]);
  }

  /** The view that shows the whole board, at most at full size. */
  home(): Matrix2D {
    const box = this.contentBox();
    if (!box) return IDENTITY;
    const { width, height } = this.options.stage.getBoundingClientRect();
    const k = Math.min(1, (width - 48) / box.width, (height - 48) / box.height);
    return { a: k, b: 0, c: 0, d: k, e: (width - box.width * k) / 2 - box.x * k, f: Math.max(24, (height - box.height * k) / 2) - box.y * k };
  }

  /** Glides the view from where it is to `to`, zooming out and back in on the way when the move is long. */
  flyTo(to: Matrix2D): void {
    const from = this.view;
    const run = ++this.flight;
    const { width, height } = this.options.stage.getBoundingClientRect();
    // The world points at the center of the screen, and the zooms, at both ends.
    const center = (m: Matrix2D) => ({ x: (width / 2 - m.e) / m.a, y: (height / 2 - m.f) / m.d });
    const c0 = center(from);
    const c1 = center(to);
    const k0 = Math.log(from.a);
    const k1 = Math.log(to.a);
    // Far apart, the view backs out so both ends are in sight midway.
    const span = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const out = Math.min(k0, k1, Math.log(Math.max(0.05, Math.min(width, height) / Math.max(1, span * 1.4))));
    const start = performance.now();
    const ms = 450 + Math.min(450, span / 8);
    const step = (now: number): void => {
      if (run !== this.flight) return;
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const bump = Math.min(k0, k1) - out;
      const k = Math.exp(k0 + (k1 - k0) * e - bump * Math.sin(Math.PI * e));
      const x = c0.x + (c1.x - c0.x) * e;
      const y = c0.y + (c1.y - c0.y) * e;
      this.setView({ a: k, b: 0, c: 0, d: k, e: width / 2 - k * x, f: height / 2 - k * y });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Flies to a world rect, fitting it on the screen at most at full size. */
  reveal(b: Rect): void {
    const { width, height } = this.options.stage.getBoundingClientRect();
    const k = Math.min(1, (width - 120) / b.width, (height - 120) / b.height);
    this.flyTo({ a: k, b: 0, c: 0, d: k, e: width / 2 - k * (b.x + b.width / 2), f: height / 2 - k * (b.y + b.height / 2) });
  }

  // ---- Drawing ----

  /** Draws the board at the next frame, once however many changes come before it. */
  render(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    // Arrows follow what they hold before the frame is drawn.
    this.reconnect();
    this.hooks.beforeDraw?.();
    this.frame = 0;
    const { canvas, overlay, stage } = this.options;
    const { width, height } = stage.getBoundingClientRect();
    const part = this.part ?? { x: 0, y: 0, width, height, scale: window.devicePixelRatio || 1 };
    const dpr = part.scale;
    // Outlines and marks are as thin on the host's screen as on this one: canvas pixels per pixel of whoever is looking.
    const ui = part.ui ?? dpr;
    for (const c of [canvas, this.cards?.canvas, overlay]) {
      if (!c) continue;
      if (c.width !== Math.round(part.width * dpr) || c.height !== Math.round(part.height * dpr)) {
        c.width = Math.round(part.width * dpr);
        c.height = Math.round(part.height * dpr);
      }
    }
    this.drawnPart = part;
    const view = this.view;
    const device = multiply({ a: dpr, b: 0, c: 0, d: dpr, e: -part.x * dpr, f: -part.y * dpr }, view);
    // The board redraws only what changed since the last frame; outlines and marks go on the overlay, redrawn whole.
    const key = `${canvas.width}x${canvas.height} ${Object.values(device).join(",")}`;
    if (key !== this.viewKey) {
      this.renderer.setView(device, canvas.width, canvas.height);
      this.a11y.setView(view);
      this.cards?.setView(view, device);
      this.viewKey = key;
    }
    const start = performance.now();
    if (this.hooks.paint?.(this.ctx, device)) this.stepped = true;
    else if (this.stepped) {
      this.stepped = false;
      this.renderer.invalidate();
    }
    const stats = this.stepped ? ({ mode: "idle", ops: 0, rects: [] } as const) : this.renderer.render();
    if (stats.mode !== "idle") this.hooks.drawn?.(stats, performance.now() - start);
    this.drawOverlay(device, ui, dpr, part);
  }

  private drawOverlay(device: Matrix2D, ui: number, dpr: number, part: DrawPart): void {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.options.overlay.width, this.options.overlay.height);
    // Outlines, drawn in device pixels so they stay thin at any zoom.
    const outline = (id: string, color: string, dash: number[]): void => {
      const b = this.scene.bounds(id);
      if (!b) return;
      const p = applyToPoint(device, b.x, b.y);
      const q = applyToPoint(device, b.x + b.width, b.y + b.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * ui;
      ctx.setLineDash(dash.map((d) => d * ui));
      ctx.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, Math.round(q.x - p.x), Math.round(q.y - p.y));
    };
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim() || "#2563eb";
    if (this.hover && !this.selection.includes(this.hover)) outline(this.hover, style.getPropertyValue("--hover").trim() || "#94a3b8", [4, 3]);
    for (const id of this.selection) outline(id, accent, []);
    ctx.setLineDash([]);
    if (this.lasso && this.lasso.length > 1) {
      ctx.beginPath();
      for (const p of this.lasso) {
        const q = applyToPoint(device, p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = ui;
      ctx.stroke();
    }
    this.hooks.overlay?.(ctx, device, ui);
    this.tools.preview(ctx, device, ui);
    if (this.snapMark) {
      const q = applyToPoint(device, this.snapMark.x, this.snapMark.y);
      const r = 6 * ui;
      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 1.5 * ui;
      ctx.beginPath();
      ctx.moveTo(q.x - r, q.y - r);
      ctx.lineTo(q.x + r, q.y + r);
      ctx.moveTo(q.x + r, q.y - r);
      ctx.lineTo(q.x - r, q.y + r);
      ctx.stroke();
      ctx.font = `${11 * ui}px system-ui, sans-serif`;
      ctx.fillStyle = "#e11d48";
      ctx.fillText(this.snapMark.kind, q.x + r + 2 * ui, q.y - r);
    }
    const tip = this.tip;
    if (tip) {
      ctx.setTransform(dpr, 0, 0, dpr, -part.x * dpr, -part.y * dpr);
      ctx.font = "12px system-ui, sans-serif";
      const lines = tip.text.split("\n");
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const h = lines.length * 16 + 8;
      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.roundRect(tip.x, tip.y, w, h, 4);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "top";
      lines.forEach((l, i) => ctx.fillText(l, tip.x + 8, tip.y + 5 + i * 16));
    }
  }

  // ---- Wiring ----

  private snapSettings(): SnapSettings {
    return this.options.snap?.() ?? SNAP_DEFAULT;
  }

  private cursor(): string {
    return this.components.cursor ?? (this.tools.current === "select" ? "" : this.tools.current === "text" ? "text" : "crosshair");
  }

  private viewChanged(): void {
    this.router.setView(this.view);
    this.hooks.viewChanged?.(this.view);
    this.render();
  }

  /** What a click or drag acts on: the outermost group around the op, or the op itself with Alt held. */
  private objectOf(e: RouterEvent): string | null {
    if (e.target === null) return null;
    if ("altKey" in e.input && e.input.altKey) return e.target;
    return e.path[e.path.length - 1] ?? e.target;
  }

  private showTooltip(screen: Point): void {
    const text = this.hoverPath.length > 0 && !this.tools.drawing ? (this.hooks.tooltip?.(this.router.toWorld(screen), this.hoverPath) ?? null) : null;
    const next = text === null ? null : { text, x: screen.x + 14, y: screen.y + 14 };
    if (next?.text === this.tip?.text && next?.x === this.tip?.x && next?.y === this.tip?.y) return;
    this.tip = next;
    this.render();
  }

  /** Moves what is dragged so that, if one of its anchors lands near another thing's snap point, it lands on it. */
  private dragTo(total: Point, snap: boolean): void {
    const drag = this.dragging;
    if (!drag) return;
    let target = total;
    this.snapMark = null;
    const s = this.snapSettings();
    if (snap && s.on && s.kinds.length > 0) {
      const radius = s.radius / this.viewport.zoom;
      const exclude = [...drag.ids, ...(this.hooks.following?.(drag.ids) ?? [])];
      const filter = s.text ? undefined : (op: { kind: string }) => op.kind !== "text";
      let best: { dx: number; dy: number; distance: number; x: number; y: number; kind: string } | null = null;
      for (const a of drag.anchors) {
        const p = { x: a.x + total.x, y: a.y + total.y };
        const found = this.scene.snap(p, { radius, kinds: [...s.kinds], exclude, ...(filter ? { filter } : {}) });
        if (found && (!best || found.distance < best.distance)) {
          best = { dx: found.point.x - p.x, dy: found.point.y - p.y, distance: found.distance, x: found.point.x, y: found.point.y, kind: found.kind };
        }
      }
      if (best) {
        target = { x: total.x + best.dx, y: total.y + best.dy };
        this.snapMark = { x: best.x, y: best.y, kind: best.kind };
      }
    }
    const step = { x: target.x - drag.moved.x, y: target.y - drag.moved.y };
    if (step.x === 0 && step.y === 0) return;
    for (const id of drag.ids) {
      this.components.move(id, move(step.x, step.y));
      this.hooks.moved?.(id, step.x, step.y);
    }
    drag.moved = target;
  }

  /** Wires the router, renderer, mirror and components to the scene, with the board's selection, drag and keys. */
  private wire(notify = true): void {
    const scene = this.scene;
    this.router = new EventRouter(scene, { view: this.view, tolerance: 3 });
    this.a11y.setScene(scene);
    this.renderer.dispose();
    this.renderer = new Renderer(scene, this.ctx, this.options.renderer?.() ?? {});
    this.viewKey = "";
    this.components.bind(scene, this.router);
    const router = this.router;
    const shift = (e: RouterEvent): boolean => "shiftKey" in e.input && e.input.shiftKey === true;
    const snapping = (e: RouterEvent): boolean => !("ctrlKey" in e.input && (e.input.ctrlKey || e.input.metaKey));
    router.on("*", "wheel", () => {
      this.wheelFree = true;
    });
    router.on("*", "enter", (e) => {
      this.hoverPath = e.path;
      this.hooks.enter?.(e);
      this.hover = this.objectOf(e);
      this.render();
    });
    router.on("*", "leave", () => {
      // An enter for whatever is under the pointer now follows, if anything is.
      this.hover = null;
      this.hoverPath = [];
      this.render();
    });
    router.on("*", "click", (e) => {
      const id = this.objectOf(e);
      const sel = this.selection;
      if (shift(e)) this.select(id === null ? sel : sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
      else this.select(id === null ? [] : [id]);
      this.hooks.log?.(`click ${e.target ?? "empty space"}${e.path.length > 1 ? ` in ${e.path.slice(1).join(" < ")}` : ""}`);
    });
    router.on("*", "dragstart", (e) => {
      const grab = this.hooks.grab?.(e) ?? null;
      if (grab) {
        this.grabbed = grab;
        return;
      }
      const id = this.objectOf(e);
      if (id === null) {
        if (shift(e)) this.lasso = [router.toWorld(e.screen)];
        else this.panFrom = e.screen;
        return;
      }
      // Dragging a selected thing moves the whole selection, and whatever moves with it.
      if (!this.selection.includes(id)) this.select([id]);
      const picked = this.selection.includes(id) ? this.selection : [id];
      const ids = (this.hooks.expand?.(picked) ?? [...picked]).filter((x) => this.exists(x));
      // Bounds points and vertices are what usually lines up; keep the list short so each move stays cheap.
      const anchors = ids
        .flatMap((i) => scene.anchors(i).filter((a) => a.kind === "bounds" || (a.kind === "vertex" && ids.length === 1)))
        .slice(0, 120)
        .map((a) => a.point);
      this.dragging = { ids, anchors, moved: { x: 0, y: 0 } };
      // What is below and above the dragged things is cached, so each frame draws two bitmaps and them.
      this.renderer.lift(ids);
      this.hooks.log?.(`drag ${ids.join(", ")}`);
    });
    router.on("*", "drag", (e) => {
      if (this.grabbed) {
        this.grabbed.drag(e.point);
        return;
      }
      if (this.dragging) {
        this.dragTo(e.total!, snapping(e));
        this.hooks.selected?.(this.selection);
      } else if (this.lasso) {
        this.lasso.push(router.toWorld(e.screen));
      } else if (this.panFrom) {
        // Pan by the pointer's movement in screen pixels; world deltas shift as the view moves.
        const d = { x: e.screen.x - this.panFrom.x, y: e.screen.y - this.panFrom.y };
        this.panFrom = e.screen;
        this.viewport.panBy(d.x, d.y);
        return;
      }
      this.render();
    });
    router.on("*", "dragend", () => {
      this.grabbed?.end();
      this.grabbed = null;
      if (this.lasso && this.lasso.length > 2) {
        // Picks the outermost thing of every op the lasso touches.
        const picked = new Set<string>();
        for (const opId of scene.queryPolygon(this.lasso)) picked.add(scene.groupChain(opId).at(-1) ?? opId);
        this.select([...picked]);
        this.hooks.log?.(`lasso picked ${picked.size}`);
      }
      const drag = this.dragging;
      if (drag && (drag.moved.x !== 0 || drag.moved.y !== 0)) {
        for (const id of drag.ids) if (this.connectors.has(id)) this.movedConnector(id, drag.moved.x, drag.moved.y);
        this.hooks.changed?.({ kind: "moved", ids: drag.ids });
      }
      this.dragging = null;
      this.renderer.drop();
      this.lasso = null;
      this.snapMark = null;
      this.panFrom = null;
      this.render();
    });
    router.on("*", "keydown", (e) => {
      const key = (e.input as { key: string }).key;
      if ((key === "Delete" || key === "Backspace") && this.selection.length > 0) {
        this.hooks.log?.(`remove ${this.selection.join(", ")}`);
        this.remove(this.selection);
      }
    });
    if (notify) this.hooks.bound?.(scene, router);
    this.render();
  }

  /** The canvas's pointers, wheel and keys: the cards get the pointer where they are, the board everywhere else. */
  private listen(): void {
    const { canvas, stage } = this.options;
    const cards = this.cards;
    const point = (e: MouseEvent): Point => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pointer = (e: PointerEvent) => ({ ...point(e), button: e.button, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    canvas.addEventListener("pointerdown", (e) => {
      // A pointer a host page forwards, as a page showing the board on a 3D panel does, can't be captured here.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      // Keeps focus where it is, so the text tool's hidden textarea keeps the keyboard.
      e.preventDefault();
      textSink().release();
      // The arrow tool starts on cards too, to hold on to what is there.
      if (cards?.hits(point(e)) && this.tools.current !== "arrow") {
        this.cardPress = true;
        this.keysToCards = true;
        cards.down(point(e), e);
        return;
      }
      this.keysToCards = false;
      this.boardPress = true;
      this.fingers.down(e.pointerId, point(e));
      if (this.fingers.multiTouch) return;
      // A drawing tool takes the press; the select tool hands it to the router.
      if (this.tools.down(point(e), e.shiftKey)) return;
      this.router.pointerDown(pointer(e));
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.cardPress) {
        cards!.move(point(e), e);
        return;
      }
      if (cards && !this.boardPress && cards.hits(point(e))) {
        if (!this.overCards) {
          this.router.pointerLeave(pointer(e));
          this.tip = null;
          this.render();
        }
        this.overCards = true;
        cards.move(point(e), e);
        canvas.style.cursor = cards.components.cursor ?? "default";
        return;
      }
      if (this.overCards) {
        cards!.router.pointerLeave(pointer(e));
        this.overCards = false;
        canvas.style.cursor = this.cursor();
      }
      this.fingers.move(e.pointerId, point(e));
      if (this.fingers.multiTouch) return;
      if (this.tools.drawing) this.tools.move(point(e), e.shiftKey);
      else this.router.pointerMove(pointer(e));
      this.showTooltip(point(e));
    });
    canvas.addEventListener("pointerup", (e) => {
      if (this.cardPress) {
        this.cardPress = false;
        cards!.up(point(e), e);
        return;
      }
      const pinched = this.fingers.multiTouch;
      this.fingers.up(e.pointerId, point(e));
      this.boardPress = this.fingers.active > 0;
      if (pinched) return;
      if (this.tools.drawing) this.tools.up();
      else this.router.pointerUp(pointer(e));
    });
    canvas.addEventListener("pointercancel", (e) => {
      this.fingers.cancel(e.pointerId);
      this.cardPress = false;
      this.boardPress = false;
      cards?.cancel();
      this.router.pointerCancel();
    });
    canvas.addEventListener("pointerleave", (e) => {
      this.overCards = false;
      cards?.router.pointerLeave(pointer(e));
      this.router.pointerLeave(pointer(e));
      this.tip = null;
      this.render();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = point(e);
        // A card, or anything on the board that scrolls, keeps the wheel; elsewhere the board pans or zooms.
        const { x: deltaX, y: deltaY } = wheelPixels(e, canvas.clientHeight);
        const input = { ...p, deltaX, deltaY, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
        if (this.wheel(input)) return;
        if (this.wheelGesture.push({ deltaX, deltaY, timeStamp: e.timeStamp, ctrlKey: e.ctrlKey }) === "zoom") this.viewport.zoomAt(wheelZoom(deltaY), p);
        else this.viewport.panBy(-deltaX, -deltaY);
      },
      { passive: false },
    );
    const toolKeys = this.options.toolKeys ?? TOOL_KEYS;
    window.addEventListener("keydown", (e) => {
      // Typing in a text field goes through its hidden textarea, which keeps its keys.
      if (textSink().active) return;
      const keys: Modifiers & { key: string } = { key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
      if (this.keysToCards && cards) {
        if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
        cards.router.keyDown(keys);
        return;
      }
      const tool = toolKeys[e.key.toLowerCase()];
      if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.useTool(tool);
        return;
      }
      if (e.key === "Escape" && this.tools.current !== "select") {
        this.useTool("select");
        return;
      }
      this.router.keyDown(keys);
    });
    new ResizeObserver(() => this.render()).observe(stage);
  }

  /**
   * Offers a wheel at a screen point to the cards and then to what is on the board (a card or a table that scrolls);
   * true when one kept it, false when it is free to zoom the board.
   */
  wheel(input: Point & Modifiers & { deltaX: number; deltaY: number }): boolean {
    if (this.cards?.hits(input) && this.cards.wheel(input)) return true;
    this.wheelFree = false;
    this.router.wheel(input);
    if (this.wheelFree) return false;
    this.render();
    return true;
  }

  /** Gives the keyboard to the cards, as when one of their controls was focused. */
  keysToCardsLayer(): void {
    this.keysToCards = true;
  }

  /** Tells the board whether the pointer is over the cards, for their cursor. */
  get pointerOverCards(): boolean {
    return this.overCards;
  }
}

const union = (boxes: readonly (Rect | null)[]): Rect | null => {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const b of boxes) {
    if (!b) continue;
    box = box
      ? { minX: Math.min(box.minX, b.x), minY: Math.min(box.minY, b.y), maxX: Math.max(box.maxX, b.x + b.width), maxY: Math.max(box.maxY, b.y + b.height) }
      : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
  }
  return box && { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
};
