// An experiment: turn flat art (UI screenshots, icons, illustrations with few
// colors) into fills. Colors are quantized to a small palette, anti-aliased
// fringes fold into their nearest palette color, each color's pixels are traced
// into rings, and the regions are drawn largest first, so smaller ones sit on
// top and the larger ones under them need no holes where those go.
import { type IRDocument, type PixelData, type Point, RecordingContext, fitCurve, isStraight, simplifyRing, traceCurve, traceMask } from "canvas-ir";

export interface VectorizeOptions {
  /** Most palette colors. Default 32. */
  readonly maxColors?: number;
  /** A color needs this share of the opaque pixels, and at least 12 pixels, to join the palette. Default 0.0005. */
  readonly minShare?: number;
  /** Palette colors closer than this (RGB distance) are merged. Default 12. */
  readonly mergeDistance?: number;
  /** Pixels with less alpha are left out. Default 128. */
  readonly alphaThreshold?: number;
  /** How far, in pixels, outlines may stray from pixel edges. Default 0.75. */
  readonly tolerance?: number;
  /** Rings enclosing fewer square pixels than this are dropped. Default 0. */
  readonly minArea?: number;
  /**
   * Fit cubic curves to the simplified outlines, keeping corners sharper than
   * `cornerAngle`: smoother edges and fewer points, at the cost of queries that
   * flatten curves. Default false: polygons.
   */
  readonly curves?: boolean;
  /** Turns sharper than this, in degrees, stay corners when fitting curves. Default 50. */
  readonly cornerAngle?: number;
}

export interface VectorizeResult {
  /** One fill per palette color, largest region first, each in a group with `{ color, pixels }` meta. */
  readonly document: IRDocument;
  readonly palette: readonly string[];
  readonly rings: number;
  /** Polygon vertices; with curves, one per straight piece and three per curved one (two handles and an end). */
  readonly points: number;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
const distance2 = (a: number, b: number): number => {
  const dr = (a >> 16) - (b >> 16);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db;
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

/** How far color c is from the line between colors p and q, in RGB, if it lies between them; Infinity otherwise. */
const offBlend = (c: number, p: number, q: number): number => {
  const v = [(q >> 16) - (p >> 16), ((q >> 8) & 255) - ((p >> 8) & 255), (q & 255) - (p & 255)];
  const w = [(c >> 16) - (p >> 16), ((c >> 8) & 255) - ((p >> 8) & 255), (c & 255) - (p & 255)];
  const len = v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2;
  if (len === 0) return Infinity;
  const t = (v[0]! * w[0]! + v[1]! * w[1]! + v[2]! * w[2]!) / len;
  if (t <= 0.02 || t >= 0.98) return Infinity;
  return Math.hypot(w[0]! - t * v[0]!, w[1]! - t * v[1]!, w[2]! - t * v[2]!);
};

/**
 * The colors of a quantized image: the most common ones, skipping near
 * duplicates and blends of two colors already chosen, which are anti-aliased
 * edges between them however often they occur.
 */
const choosePalette = (counts: Map<number, number>, opaque: number, options: Required<VectorizeOptions>): number[] => {
  const min = Math.max(12, options.minShare * opaque);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const palette: number[] = [];
  for (const [color, count] of sorted) {
    if (palette.length >= options.maxColors) break;
    if (count < min && palette.length > 0) break;
    if (palette.some((p) => distance2(p, color) < options.mergeDistance ** 2)) continue;
    if (palette.some((p, i) => palette.slice(i + 1).some((q) => offBlend(color, p, q) < options.mergeDistance))) continue;
    palette.push(color);
  }
  return palette;
};

export const vectorize = (image: PixelData, options: VectorizeOptions = {}): VectorizeResult => {
  const o: Required<VectorizeOptions> = {
    maxColors: options.maxColors ?? 32,
    minShare: options.minShare ?? 0.0005,
    mergeDistance: options.mergeDistance ?? 12,
    alphaThreshold: options.alphaThreshold ?? 128,
    tolerance: options.tolerance ?? 0.75,
    minArea: options.minArea ?? 0,
    curves: options.curves ?? false,
    cornerAngle: options.cornerAngle ?? 50,
  };
  const { width, height, data } = image;
  const n = width * height;
  const rgb = new Int32Array(n).fill(-1);
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3]! < o.alphaThreshold) continue;
    const c = (data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!;
    rgb[i] = c;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const opaque = [...counts.values()].reduce((a, b) => a + b, 0);
  const palette = choosePalette(counts, opaque, o);
  // Every opaque pixel takes its nearest palette color; a fringe pixel goes to whichever side it is closer to.
  const nearest = new Map<number, number>();
  const assigned = new Int16Array(n).fill(-1);
  const sizes = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < n; i++) {
    const c = rgb[i]!;
    if (c < 0) continue;
    let k = nearest.get(c);
    if (k === undefined) {
      k = 0;
      for (let j = 1; j < palette.length; j++) if (distance2(c, palette[j]!) < distance2(c, palette[k]!)) k = j;
      nearest.set(c, k);
    }
    assigned[i] = k;
    sizes[k]!++;
  }
  // Larger regions are drawn first; `rank` is each color's place in that order.
  const order = palette.map((_, k) => k).filter((k) => sizes[k]! > 0).sort((a, b) => sizes[b]! - sizes[a]!);
  const rank = new Int16Array(palette.length).fill(-1);
  order.forEach((k, r) => (rank[k] = r));
  const ctx = new RecordingContext();
  let ringCount = 0;
  let pointCount = 0;
  for (const k of order) {
    const rings = traceMask(width, height, (x, y) => assigned[y * width + x] === k);
    const kept = rings.filter((ring) => {
      if (Math.abs(ringArea(ring)) < o.minArea) return false;
      if (ringArea(ring) > 0) return true;
      // A hole whose edge pixels all belong to colors drawn later is covered by them: fill it instead.
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const x = Math.floor((a.x + b.x) / 2 + (b.y - a.y) / 2);
        const y = Math.floor((a.y + b.y) / 2 - (b.x - a.x) / 2);
        const other = x >= 0 && y >= 0 && x < width && y < height ? assigned[y * width + x]! : -1;
        if (other < 0 || rank[other]! < rank[k]!) return true;
      }
      return false;
    });
    if (kept.length === 0) continue;
    ctx.beginGroup({ meta: { color: hex(palette[k]!), pixels: sizes[k]! } });
    ctx.fillStyle = hex(palette[k]!);
    ctx.beginPath();
    for (const ring of kept) {
      const simple = simplifyRing(ring, o.tolerance);
      ringCount++;
      if (o.curves && simple.length > 4) {
        // Fit the pixel edges themselves, looking a few pixels each way for corners, so a staircase reads as a curve.
        const pieces = fitCurve(simplifyRing(ring, 0.01), o.tolerance + 0.5, { closed: true, cornerAngle: o.cornerAngle, cornerWindow: 3 });
        pointCount += pieces.reduce((n, p) => n + (isStraight(p) ? 1 : 3), 0);
        traceCurve(ctx, pieces, true);
        continue;
      }
      pointCount += simple.length;
      simple.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
    }
    ctx.fill();
    ctx.endGroup();
  }
  return { document: ctx.getDocument(), palette: order.map((k) => hex(palette[k]!)), rings: ringCount, points: pointCount };
};
