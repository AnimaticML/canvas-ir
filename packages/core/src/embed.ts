import { maxScale, pathRings } from "./geometry/flatten";
import type { Scene } from "./geometry/scene";
import { applyToPoint, invert, multiply } from "./math";
import type { EmbedOp, Matrix2D } from "./types";

export interface EmbedLayerOptions {
  /**
   * Makes the element for an embed: a video, an iframe, a WebGL canvas. Called
   * once per op, and again when its content changes. Null leaves the hole empty.
   */
  readonly create: (op: EmbedOp) => HTMLElement | null;
  /** Called when an element is taken off the board, to stop what it runs. */
  readonly destroy?: (element: HTMLElement, op: EmbedOp) => void;
}

interface Placed {
  op: EmbedOp;
  element: HTMLElement | null;
  content: string;
}

/**
 * Puts the HTML elements of a scene's embed ops beneath its canvas, each
 * where its hole is. The canvas paints everything else, so whatever is drawn
 * after an embed covers its element and whatever was drawn before is covered
 * by it, with no z-index juggling. The canvas must be positioned and come
 * after the container's other children, with a transparent background where
 * the holes are (the renderer's `background` is painted over by the holes too).
 *
 * The canvas takes every pointer event, so a host that wants the element to
 * get them calls `passThrough(id)` while the pointer is over that embed (for
 * instance on the router's `enter`); the canvas takes them back when the
 * pointer leaves the element or moves onto something drawn over it.
 */
export class EmbedLayer {
  private readonly placed = new Map<string, Placed>();
  private view: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private unsubscribe: (() => void) | null = null;
  private passing: string | null = null;
  private pending = false;

  constructor(
    private scene: Scene,
    private readonly container: HTMLElement,
    private readonly canvas: HTMLElement,
    private readonly options: EmbedLayerOptions,
  ) {
    this.watch();
    this.sync();
  }

  /** Follows another scene, such as one rebuilt from a new document. */
  setScene(scene: Scene): void {
    this.scene = scene;
    this.watch();
    this.sync();
  }

  /** The view from world space to the container's CSS pixels. */
  setView(view: Matrix2D): void {
    this.view = view;
    for (const p of this.placed.values()) this.position(p);
  }

  /** The element of an embed op, once made. */
  element(id: string): HTMLElement | null {
    return this.placed.get(id)?.element ?? null;
  }

  /** Lets pointer events through the canvas to an embed's element, or (with null) gives them back to the canvas. */
  passThrough(id: string | null): void {
    const element = id === null ? null : this.element(id);
    this.passing = element ? id : null;
    this.canvas.style.pointerEvents = element ? "none" : "";
  }

  get passingTo(): string | null {
    return this.passing;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.passThrough(null);
    for (const [id] of this.placed) this.take(id);
  }

  private watch(): void {
    this.unsubscribe?.();
    // Edits come in bursts (a drag moves every op of a group); place the elements once per frame.
    this.unsubscribe = this.scene.onChange(() => {
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        this.sync();
      });
    });
  }

  /** Makes, moves and removes elements to match the scene's embeds. */
  sync(): void {
    const seen = new Set<string>();
    for (const op of this.scene.document.ops) {
      if (op.kind !== "embed") continue;
      seen.add(op.id);
      const content = JSON.stringify(op.content);
      let p = this.placed.get(op.id);
      if (p && p.content !== content) {
        this.take(op.id);
        p = undefined;
      }
      if (!p) {
        const element = this.options.create(op);
        p = { op, element, content };
        if (element) this.adopt(op.id, element);
        this.placed.set(op.id, p);
      }
      p.op = op;
      this.position(p);
    }
    for (const id of [...this.placed.keys()]) if (!seen.has(id)) this.take(id);
  }

  private adopt(id: string, element: HTMLElement): void {
    const s = element.style;
    s.position = "absolute";
    s.left = "0";
    s.top = "0";
    s.transformOrigin = "0 0";
    s.boxSizing = "border-box";
    // Beneath the canvas: it comes first, and the canvas, positioned after it, paints on top.
    this.container.insertBefore(element, this.container.firstChild);
    element.addEventListener("pointerleave", () => {
      if (this.passing === id) this.passThrough(null);
    });
    // Over something drawn on top of the embed, the canvas takes the pointer back. (An iframe keeps its events to itself; leaving it is enough there.)
    element.addEventListener("pointermove", (e) => {
      if (this.passing !== id) return;
      const box = this.container.getBoundingClientRect();
      const back = invert(this.view);
      if (!back) return;
      const world = applyToPoint(back, e.clientX - box.left, e.clientY - box.top);
      if (this.scene.hitTest(world)[0]?.id !== id) this.passThrough(null);
    });
  }

  private take(id: string): void {
    const p = this.placed.get(id);
    if (!p) return;
    if (this.passing === id) this.passThrough(null);
    if (p.element) {
      p.element.remove();
      this.options.destroy?.(p.element, p.op);
    }
    this.placed.delete(id);
  }

  private position(p: Placed): void {
    const element = p.element;
    if (!element) return;
    const { transform, clip } = p.op;
    // The element overlaps its hole by about a pixel all round, so the hole's anti-aliased edge shows no seam.
    const pad = 1 / maxScale(multiply(this.view, transform));
    const rect = { x: p.op.rect.x - pad, y: p.op.rect.y - pad, width: p.op.rect.width + 2 * pad, height: p.op.rect.height + 2 * pad };
    const local = multiply(transform, { a: 1, b: 0, c: 0, d: 1, e: rect.x, f: rect.y });
    const m = multiply(this.view, local);
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
    // A clip on the embed clips its element too, in the element's own pixels.
    const back = clip && clip.length > 0 ? invert(local) : null;
    if (!clip || clip.length === 0 || !back) {
      element.style.clipPath = "";
      return;
    }
    // Several clips intersect; CSS takes one path, so the last (innermost) is used.
    const last = clip[clip.length - 1]!;
    const d = pathRings(last.path, 0.25)
      .map((ring) => `M${ring.map((q) => applyToPoint(back, q.x, q.y)).map((q) => `${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join("L")}Z`)
      .join("");
    element.style.clipPath = `path(${last.fillRule}, "${d}")`;
  }
}
