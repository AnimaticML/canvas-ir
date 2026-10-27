import { RecordingContext, type RecordingContextOptions } from "./context";
import { Scene } from "./geometry/scene";
import { IDENTITY, applyToPoint, invert, sameMatrix } from "./math";
import type { FillOp, IRDocument, JsonValue, Matrix2D, Op, Rect } from "./types";

export interface VirtualGroupSpec {
  /** The group's id in the scene. */
  readonly id: string;
  /** A group to put it in. */
  readonly parent?: string;
  readonly meta?: { readonly [key: string]: JsonValue };
  /** All of the content, in content coordinates: what windows are clamped to, however much of it is drawn. */
  readonly extent: Rect;
  /**
   * Records the part of the content that meets `window`, in content
   * coordinates: a million-row table draws the rows in it, a map the tiles. It
   * is called again whenever the window changes, so it should draw only what
   * meets it. Nested groups with stable ids (a row's key) keep events and
   * selection pointing at the same thing across redraws. `detail` is the
   * view's level of detail, as the host defined it.
   */
  draw(ctx: RecordingContext, window: Rect, detail: number): void;
  /**
   * How much past each side of what shows to draw, as a fraction of what
   * shows, so that small moves need no redraw. Default 0.5. A clipped
   * group draws exactly what shows.
   */
  readonly overscan?: number;
}

export interface VirtualView {
  /** Content coordinates to world. Default identity. */
  readonly transform?: Matrix2D;
  /** The world rect that shows, such as the board's viewport or a scroll container's box. */
  readonly visible: Rect;
  /** Clips the drawing to `visible`, as a scroll container does. Default false. */
  readonly clip?: boolean;
  /**
   * A level of detail, passed to `draw`; the group draws again when it
   * changes. A chart of millions of points might pass the log2 of how many
   * points fall in a pixel, and draw one bar per pixel above 0. Default 0.
   */
  readonly detail?: number;
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right < x || bottom < y ? null : { x, y, width: right - x, height: bottom - y };
};

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** The axis-aligned box around a world rect in content coordinates. */
const toContent = (transform: Matrix2D, r: Rect): Rect => {
  const inv = invert(transform) ?? IDENTITY;
  const corners = [
    applyToPoint(inv, r.x, r.y),
    applyToPoint(inv, r.x + r.width, r.y),
    applyToPoint(inv, r.x, r.y + r.height),
    applyToPoint(inv, r.x + r.width, r.y + r.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/**
 * A group whose content is too big to record whole, such as a table of a
 * million rows, a long log or a chart of millions of points: it records only
 * the part of its extent that shows (and some way past it), and records again
 * when what shows moves past what it drew. Everything else (rendering, hit
 * tests, events, accessibility, export) sees ordinary ops in an ordinary
 * group, so it all works on the drawn part without knowing about the rest.
 */
export class VirtualGroup {
  private drawn: Rect | null = null;
  private view: VirtualView | null = null;
  private placed: Matrix2D = IDENTITY;

  constructor(
    private scene: Scene,
    private spec: VirtualGroupSpec,
    private readonly options: { readonly recorder?: RecordingContextOptions } = {},
  ) {}

  get id(): string {
    return this.spec.id;
  }

  /** The part of the content last drawn, in content coordinates, or null before anything showed. */
  get window(): Rect | null {
    return this.drawn;
  }

  /** The whole content's box in world coordinates, where it is placed now. */
  get bounds(): Rect {
    const t = this.view?.transform ?? IDENTITY;
    const e = this.spec.extent;
    const corners = [applyToPoint(t, e.x, e.y), applyToPoint(t, e.x + e.width, e.y + e.height), applyToPoint(t, e.x + e.width, e.y), applyToPoint(t, e.x, e.y + e.height)];
    const x = Math.min(...corners.map((p) => p.x));
    const y = Math.min(...corners.map((p) => p.y));
    return { x, y, width: Math.max(...corners.map((p) => p.x)) - x, height: Math.max(...corners.map((p) => p.y)) - y };
  }

  /**
   * Says what shows and where the content is. Redraws when the visible part
   * moves past what was drawn, when the content moved or the level of detail
   * changed, or, clipped, whenever the view changed; returns whether it redrew.
   */
  show(view: VirtualView): boolean {
    const transform = view.transform ?? IDENTITY;
    let moved = !sameMatrix(transform, this.placed);
    const visible = intersect(toContent(transform, view.visible), this.spec.extent);
    const clipChanged = view.clip === true && (this.view?.clip !== true || !sameRect(view.visible, this.view.visible));
    const detailChanged = this.drawn !== null && (view.detail ?? 0) !== (this.view?.detail ?? 0);
    this.view = view;
    if (detailChanged) moved = true;
    if (!moved && !clipChanged && visible && this.drawn && contains(this.drawn, visible)) return false;
    if (!moved && !clipChanged && !visible && this.drawn) return false;
    this.record(visible);
    return true;
  }

  /** Draws the current window again, as after the data changed. */
  refresh(): void {
    if (!this.view) return;
    const visible = intersect(toContent(this.view.transform ?? IDENTITY, this.view.visible), this.spec.extent);
    this.record(visible);
  }

  /** Changes what is drawn (a new extent, or a new `draw`) and draws again. */
  update(spec: Partial<Omit<VirtualGroupSpec, "id">>): void {
    this.spec = { ...this.spec, ...spec };
    this.refresh();
  }

  /** Moves the group to another scene, such as after the host rebuilt its scene from its document, and draws it there. */
  bind(scene: Scene): void {
    this.scene = scene;
    this.refresh();
  }

  /** Takes the group out of the scene. */
  remove(): void {
    if (this.scene.getGroup(this.spec.id)) this.scene.remove(this.spec.id);
    this.drawn = null;
  }

  private record(visible: Rect | null): void {
    const view = this.view!;
    const transform = view.transform ?? IDENTITY;
    let window: Rect | null = null;
    if (visible) {
      const k = view.clip ? 0 : (this.spec.overscan ?? 0.5);
      window = intersect({ x: visible.x - visible.width * k, y: visible.y - visible.height * k, width: visible.width * (1 + 2 * k), height: visible.height * (1 + 2 * k) }, this.spec.extent);
    }
    const ctx = new RecordingContext(this.options.recorder);
    ctx.beginGroup({ id: this.spec.id, meta: { ...this.spec.meta, virtual: true } });
    if (window) {
      ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      this.spec.draw(ctx, window, view.detail ?? 0);
    }
    ctx.endGroup();
    let document = ctx.getDocument();
    if (window && view.clip) document = clipEdges(document, view.visible);
    this.scene.replaceGroup(this.spec.id, document, this.spec.parent !== undefined ? { parent: this.spec.parent } : {});
    this.drawn = window;
    this.placed = transform;
  }
}

/**
 * Clips the ops that cross the edge of `visible` to it. Ops wholly inside
 * need no clip, and a clip on every op would cost every replay and hit test.
 */
const clipEdges = (document: IRDocument, visible: Rect): IRDocument => {
  const shape = new RecordingContext();
  shape.beginPath();
  shape.rect(visible.x, visible.y, visible.width, visible.height);
  shape.clip();
  shape.fillRect(visible.x, visible.y, 1, 1);
  const clip = (shape.getDocument().ops[0] as FillOp).clip!;
  const boxes = new Scene(document);
  const ops = document.ops.map((op) => {
    const b = boxes.bounds(op.id, "index");
    if (b && b.x >= visible.x && b.y >= visible.y && b.x + b.width <= visible.x + visible.width && b.y + b.height <= visible.y + visible.height) return op;
    return { ...op, clip: [...clip, ...(op.clip ?? [])] } as Op;
  });
  return { ...document, ops };
};

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
