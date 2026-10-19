import type { Point } from "../types";

/** Pixels as `ImageData` holds them: RGBA bytes, row by row. */
export interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface TraceOptions {
  /** A pixel counts as opaque when its alpha is at least this, 0 to 255. Default 128, where an anti-aliased edge is half covered. */
  readonly threshold?: number;
  /** How far, in image pixels, the simplified outline may stray from the pixel edges. Default 0.75. */
  readonly tolerance?: number;
  /** Rings enclosing less area than this, in square pixels, are dropped: specks and pinholes. Default 0. */
  readonly minArea?: number;
}

/** A rectangle of whole pixels. */
export interface PixelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TraceMaskOptions {
  /**
   * Only pixels in this box are visited, and pixels outside it count as
   * outside: what tracing one region within its bounding box needs, without
   * scanning the image. The rings stay in the image's pixel space.
   */
  readonly bounds?: PixelBox;
}

/**
 * Traces the edges of a set of pixels (`inside(x, y)`) into closed rings in
 * pixel space, along pixel boundaries: the nonzero fill of the rings is exactly
 * the set. Outer edges run clockwise on screen and holes counterclockwise.
 */
export const traceMask = (width: number, height: number, inside: (x: number, y: number) => boolean, options: TraceMaskOptions = {}): Point[][] => {
  const b = options.bounds;
  const x0 = Math.max(0, b?.x ?? 0);
  const y0 = Math.max(0, b?.y ?? 0);
  const x1 = Math.min(width, b ? b.x + b.width : width);
  const y1 = Math.min(height, b ? b.y + b.height : height);
  if (x1 <= x0 || y1 <= y0) return [];
  // Vertices are keyed within the box, so a small region's keys stay small.
  const W = x1 - x0 + 1;
  const key = (x: number, y: number): number => (y - y0) * W + (x - x0);
  // Directed boundary edges, keyed by start vertex; a vertex where two regions touch corners has two.
  const out = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const from = key(ax, ay);
    const list = out.get(from);
    if (list) list.push(key(bx, by));
    else out.set(from, [key(bx, by)]);
  };
  const at = (x: number, y: number): boolean => x >= x0 && y >= y0 && x < x1 && y < y1 && inside(x, y);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!inside(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  // Link edges into rings. The winding of every point depends only on the edges,
  // not on how they are linked, so any choice at a shared corner is exact.
  const rings: Point[][] = [];
  for (const [start, list] of out) {
    while (list.length > 0) {
      const ring: Point[] = [];
      let v = start;
      do {
        ring.push({ x: (v % W) + x0, y: Math.floor(v / W) + y0 });
        const next = out.get(v)!;
        v = next.pop()!;
      } while (v !== start);
      rings.push(ring);
    }
  }
  return rings;
};

const ringArea = (ring: readonly Point[]): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

const segmentDistance = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Douglas–Peucker on an open polyline: keeps the ends, and every point needed to stay within `tolerance`. */
const simplifyOpen = (points: readonly Point[], tolerance: number): Point[] => {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let far = 0;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k]!, points[i]!, points[j]!);
      if (d > far) [far, worst] = [d, k];
    }
    if (worst >= 0 && far > tolerance) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
};

/**
 * Simplifies a closed ring with Douglas–Peucker, so no point of the original is
 * farther than `tolerance` from the result. The ring is cut at two extreme
 * points, which every simplification keeps, and each half simplified.
 */
export const simplifyRing = (ring: readonly Point[], tolerance: number): Point[] => {
  if (ring.length <= 4 || tolerance <= 0) return [...ring];
  const farthest = (from: Point): number => {
    let best = 0;
    let far = -1;
    ring.forEach((p, i) => {
      const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
      if (d > far) [far, best] = [d, i];
    });
    return best;
  };
  const start = farthest(ring[0]!);
  const rotated = [...ring.slice(start), ...ring.slice(0, start)];
  const split = farthest.call(null, rotated[0]!) - start;
  const k = ((split % ring.length) + ring.length) % ring.length;
  const a = simplifyOpen(rotated.slice(0, k + 1), tolerance);
  const b = simplifyOpen([...rotated.slice(k), rotated[0]!], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
};

/**
 * Traces where an image is opaque into rings in its pixel space: the outline a
 * hit test, closest point, snapping or text layout uses instead of the image's
 * box. The rings follow pixel edges, simplified to within `tolerance`, so a
 * pixel whose center is farther than that from the outline is inside exactly
 * when its alpha is at least `threshold`. Fill them with the nonzero rule.
 */
export const traceImageOutline = (image: PixelData, options: TraceOptions = {}): Point[][] => {
  const threshold = options.threshold ?? 128;
  const tolerance = options.tolerance ?? 0.75;
  const minArea = options.minArea ?? 0;
  const { width, data } = image;
  const rings = traceMask(image.width, image.height, (x, y) => data[(y * width + x) * 4 + 3]! >= threshold);
  return rings.filter((r) => Math.abs(ringArea(r)) >= minArea).map((r) => simplifyRing(r, tolerance));
};

/**
 * Traces an image the browser can draw, through an `OffscreenCanvas`, for a
 * recording context's `describeImage`: `{ src, width, height, outline }`.
 */
export const traceImageSource = (
  image: CanvasImageSource,
  width: number,
  height: number,
  options: TraceOptions = {},
): Point[][] => {
  const ctx = new OffscreenCanvas(width, height).getContext("2d");
  if (!ctx) throw new Error("no 2D context to read the image with");
  ctx.drawImage(image, 0, 0, width, height);
  return traceImageOutline(ctx.getImageData(0, 0, width, height), options);
};
