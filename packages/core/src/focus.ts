// Which part of a drawing on a plane in 3D to draw, and at what detail, so it
// stays as sharp as the screen up close and costs little far away. Engine
// neutral: a 3D package's world says what of a plane the camera sees and how
// densely, and the focus picks the region and the detail in steps of two.

/** A part of a drawing, in its units, and how many texture pixels to draw per unit. */
export interface FocusRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** Texture pixels per CSS pixel of the host where the content is closest: how wide to draw lines meant to look the same on any screen, as a hover outline. */
  readonly ui?: number;
}

/** What a focus asks of a 3D world: what of a plane's content is in view, the host's size, and a key that changes when the camera or the plane moves. */
export interface FocusWorld<T> {
  /**
   * What of a plane's content (`width` by `height`, from the top left) the
   * camera sees, and how many CSS pixels of the host one unit of it covers
   * where it is closest; null when none of its front is in view.
   */
  inView(plane: T, width: number, height: number): { x0: number; y0: number; x1: number; y1: number; density: number } | null;
  readonly viewSize: { width: number; height: number };
  /** Any string that changes when the camera or the plane moves. */
  pose(plane: T): string;
}

export interface FocusOptions {
  /** The longest side of the texture, in pixels. Default 4096, which every WebGL 2 device has. */
  readonly maxSide?: number;
  /** The most pixels in the texture: memory is four bytes each. Default twice the host's device pixels, at least a million and at most 8 million (32 MB): more than that can't show. */
  readonly maxPixels?: number;
  /** Texture pixels per unit of the drawing, at the least and at the most. Default 0.5 and 16. */
  readonly minScale?: number;
  readonly maxScale?: number;
  /** Device pixels per CSS pixel of the host. Default `devicePixelRatio`. */
  readonly pixelRatio?: () => number;
  /**
   * How long the camera and the plane must rest, in milliseconds, before more
   * detail is drawn: while they move, the region follows at the detail it has,
   * so walking up to a board costs no redraws until you stop. Default 150.
   */
  readonly settle?: number;
  /** The time now, in milliseconds. Default `performance.now()`. */
  readonly now?: () => number;
}

/**
 * Which part of a plane's content to draw, and at what detail, so it stays as
 * sharp as the screen up close and costs little far away. The detail goes in
 * steps of two, so walking about doesn't draw it again every frame; the region
 * is the part in view with a margin, snapped to a grid, and is asked for again
 * only when the view leaves it or needs another step of detail.
 */
export class Focus<T> {
  private region: FocusRegion | null = null;
  private level = 0;
  private pose = "";
  private moved = -Infinity;

  constructor(
    private readonly world: FocusWorld<T>,
    private readonly mesh: T,
    private readonly content: () => { readonly width: number; readonly height: number },
    private readonly options: FocusOptions = {},
  ) {}

  /** What it holds now. */
  get current(): FocusRegion | null {
    return this.region;
  }

  /** A new region to draw when the view needs one, or null to keep the last. */
  update(): FocusRegion | null {
    const { width, height } = this.content();
    const seen = this.world.inView(this.mesh, width, height);
    if (!seen) return null;
    const ratio = this.options.pixelRatio?.() ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    const min = this.options.minScale ?? 0.5;
    const max = this.options.maxScale ?? 16;
    const want = Math.log2(Math.min(max, Math.max(min, seen.density * ratio)));
    // A step of detail is taken once the view is most of a step past the one held, and a step up only once the view rests.
    const now = this.options.now?.() ?? performance.now();
    const pose = this.world.pose(this.mesh);
    if (pose !== this.pose) {
      this.pose = pose;
      this.moved = now;
    }
    const resting = now - this.moved >= (this.options.settle ?? 150);
    let level = this.level > 0 && Math.abs(want - Math.log2(this.level)) < 0.75 ? this.level : 2 ** Math.round(want);
    if (level > this.level && this.level > 0 && !resting) level = this.level;
    const r = this.region;
    if (r && level === this.level && seen.x0 >= r.x - 1e-6 && seen.y0 >= r.y - 1e-6 && seen.x1 <= r.x + r.width + 1e-6 && seen.y1 <= r.y + r.height + 1e-6) return null;
    // The part in view, a sixth again on each side, snapped outward to a 64th of the content.
    const padX = (seen.x1 - seen.x0) / 6;
    const padY = (seen.y1 - seen.y0) / 6;
    const g = Math.max(width, height) / 64;
    const x0 = Math.max(0, Math.floor((seen.x0 - padX) / g) * g);
    const y0 = Math.max(0, Math.floor((seen.y0 - padY) / g) * g);
    const x1 = Math.min(width, Math.ceil((seen.x1 + padX) / g) * g);
    const y1 = Math.min(height, Math.ceil((seen.y1 + padY) / g) * g);
    const side = this.options.maxSide ?? 4096;
    const host = this.world.viewSize;
    const budget = this.options.maxPixels ?? Math.min(8_388_608, Math.max(1 << 20, 2 * host.width * host.height * ratio * ratio));
    const scale = Math.min(level, side / (x1 - x0), side / (y1 - y0), Math.sqrt(budget / ((x1 - x0) * (y1 - y0))));
    // The texture's size goes in steps of 256 pixels and the region grows to fill it, so most moves keep the size, and the GPU its storage.
    const STEP = 256;
    const w = Math.min(width, Math.min(side, Math.ceil(((x1 - x0) * scale) / STEP) * STEP) / scale);
    const h = Math.min(height, Math.min(side, Math.ceil(((y1 - y0) * scale) / STEP) * STEP) / scale);
    const x = Math.max(0, Math.min(width - w, (x0 + x1) / 2 - w / 2));
    const y = Math.max(0, Math.min(height - h, (y0 + y1) / 2 - h / 2));
    this.level = level;
    this.region = { x, y, width: w, height: h, scale, ui: Math.min(scale * 8, Math.max(scale / 8, scale / seen.density)) };
    return this.region;
  }
}
