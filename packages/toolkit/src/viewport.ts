// The view onto a board: how far it is zoomed and where it is panned, as one uniform scale and a translation. Screen
// points are CSS pixels from the canvas's top left; world points are the drawing's own units.
//
// It holds only the view. Whoever owns the board keeps the drawing, its meaning and its history, and listens for
// changes to redraw. Zooming keeps the point under the anchor still, as a wheel or a pinch does; limits and bounds,
// when given, are applied to every change so no caller has to clamp afterwards.
import type { Matrix2D, Point } from "canvas-ir";

export interface View {
  /** Screen pixels per world unit. */
  readonly zoom: number;
  /** Where the world's origin is on the screen. */
  readonly x: number;
  readonly y: number;
}

export interface ViewportOptions {
  /** The least and most zoom. Unbounded when left out. */
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /**
   * Keeps a view in bounds after every change, with the zoom already limited: a gallery that can't be panned past
   * its edges, a canvas that centers itself when it fits. Returns the view to use.
   */
  readonly clamp?: (view: View) => View;
}

export type ViewListener = (view: View) => void;

export class Viewport {
  private current: View;
  private readonly listeners = new Set<ViewListener>();

  constructor(
    initial: View = { zoom: 1, x: 0, y: 0 },
    private options: ViewportOptions = {},
  ) {
    this.current = this.limit(initial);
  }

  get view(): View {
    return this.current;
  }

  get zoom(): number {
    return this.current.zoom;
  }

  /** World to screen, for a renderer, a router or an accessibility layer. */
  get matrix(): Matrix2D {
    const { zoom, x, y } = this.current;
    return { a: zoom, b: 0, c: 0, d: zoom, e: x, f: y };
  }

  /** The same at a device pixel ratio: world to canvas pixels. */
  device(pixelRatio: number): Matrix2D {
    const { zoom, x, y } = this.current;
    return { a: zoom * pixelRatio, b: 0, c: 0, d: zoom * pixelRatio, e: x * pixelRatio, f: y * pixelRatio };
  }

  toWorld(screen: Point): Point {
    const { zoom, x, y } = this.current;
    return { x: (screen.x - x) / zoom, y: (screen.y - y) / zoom };
  }

  toScreen(world: Point): Point {
    const { zoom, x, y } = this.current;
    return { x: world.x * zoom + x, y: world.y * zoom + y };
  }

  /** Replaces the view, within the limits. */
  set(view: View): void {
    const next = this.limit(view);
    if (next.zoom === this.current.zoom && next.x === this.current.x && next.y === this.current.y) return;
    this.current = next;
    for (const l of this.listeners) l(next);
  }

  /** From a matrix of a uniform scale and a translation, as hosts that keep a matrix have. */
  setMatrix(m: Matrix2D): void {
    this.set({ zoom: Math.hypot(m.a, m.b), x: m.e, y: m.f });
  }

  /** Moves the board by a distance on the screen. */
  panBy(dx: number, dy: number): void {
    this.set({ ...this.current, x: this.current.x + dx, y: this.current.y + dy });
  }

  /** Zooms by a factor, keeping the world point under the screen anchor where it is. */
  zoomAt(factor: number, anchor: Point): void {
    this.zoomTo(this.current.zoom * factor, anchor);
  }

  /** Zooms to a zoom, keeping the world point under the screen anchor where it is (as far as the limits allow). */
  zoomTo(zoom: number, anchor: Point): void {
    const old = this.current;
    const z = this.limitZoom(zoom);
    const k = z / old.zoom;
    this.set({ zoom: z, x: anchor.x - (anchor.x - old.x) * k, y: anchor.y - (anchor.y - old.y) * k });
  }

  /** Shows a world rectangle in a screen of a size, centered, with a margin in screen pixels. */
  fit(world: { x: number; y: number; width: number; height: number }, screen: { width: number; height: number }, margin = 0): void {
    const zoom = this.limitZoom(Math.min((screen.width - 2 * margin) / world.width, (screen.height - 2 * margin) / world.height));
    this.set({ zoom, x: screen.width / 2 - (world.x + world.width / 2) * zoom, y: screen.height / 2 - (world.y + world.height / 2) * zoom });
  }

  /** Changes the limits; the view is kept within the new ones. */
  setOptions(options: ViewportOptions): void {
    this.options = options;
    this.set(this.current);
  }

  /** Calls back on every change, until the returned function is called. */
  onChange(listener: ViewListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private limitZoom(zoom: number): number {
    const { minZoom = 0, maxZoom = Infinity } = this.options;
    return Math.max(minZoom, Math.min(maxZoom, zoom));
  }

  private limit(view: View): View {
    const zoom = this.limitZoom(view.zoom);
    const v = zoom === view.zoom ? view : { ...view, zoom };
    return this.options.clamp ? this.options.clamp(v) : v;
  }
}

/** The zoom factor for a wheel's vertical movement in pixels: smooth for trackpads, a step a notch for mice. */
export const wheelZoom = (deltaY: number, rate = 0.0015): number => Math.exp(-deltaY * rate);

/**
 * A wheel event's movement in pixels. Firefox reports a mouse wheel's notches in lines, three a notch; pages are a
 * screenful. The rest of the board reads pixels, about a hundred a notch.
 */
export const wheelPixels = (e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number): { x: number; y: number } => {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? pageHeight : 1;
  return { x: e.deltaX * unit, y: e.deltaY * unit };
};
