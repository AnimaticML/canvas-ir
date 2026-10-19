// An experiment: turn flat art (UI screenshots, icons, illustrations with few
// colors) into fills. Colors are quantized to a small palette, anti-aliased
// fringes fold into their nearest palette color, each color's pixels are traced
// into rings, and the regions are drawn largest first, so smaller ones sit on
// top and the larger ones under them need no holes where those go. Or, with
// `layout: "regions"`, every connected area is its own fill, traced from
// borders shared with its neighbours so the fills tile the picture.
import {
  type IRDocument,
  type PixelData,
  type Point,
  type RegionMap,
  RecordingContext,
  fitCurve,
  isStraight,
  labelRegions,
  parseColor,
  simplifyRing,
  srgbToOklab,
  traceBorders,
  traceCurve,
  traceMask,
  traceRegionPath,
} from "canvas-ir";

/** A color of a fixed palette, with an id of the caller's that the result keeps. */
export interface PaletteColor {
  readonly id: string;
  /** Any CSS color; its alpha is ignored. */
  readonly color: string;
}

export interface VectorizeOptions {
  /**
   * Use exactly these colors: every opaque pixel takes the nearest one by
   * OKLab distance, no others are added, and some may go unused. Without it
   * the palette is picked from the image. Default: picked.
   */
  readonly palette?: readonly PaletteColor[];
  /**
   * `"layers"` (default): one fill per color, largest first, smaller ones on
   * top. `"regions"`: one fill per connected area of a color (4-connected),
   * holes kept, outlines from borders shared with the neighbours, so fills
   * neither gap nor overlap; `minArea` then merges smaller areas into the
   * neighbour they share the longest border with, in `indices` too.
   */
  readonly layout?: "layers" | "regions";
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
  /** Rings enclosing fewer square pixels than this are dropped (with regions: areas merged). Default 0. */
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

/** A palette color as the result uses it. */
export interface VectorizeColor {
  /** The fixed palette's id, or the color's hex when the palette was picked. */
  readonly id: string;
  /** As `#rrggbb`. */
  readonly color: string;
  /** Pixels that took it. */
  readonly pixels: number;
}

export interface VectorizeResult {
  /**
   * Layers: one fill per used color, largest first, each in a group with
   * `{ color, colorId, pixels }` meta. Regions: one fill per area, in region
   * id order, each with `{ region, color, colorId, pixels }`.
   */
  readonly document: IRDocument;
  /** The used colors' hex, in drawing order. */
  readonly palette: readonly string[];
  /** Every palette color, used or not: a fixed palette's in its order, a picked one most common first. */
  readonly colors: readonly VectorizeColor[];
  readonly width: number;
  readonly height: number;
  /** Each pixel's index into `colors`, row by row; -1 for left-out (transparent) pixels. The fills trace this. */
  readonly indices: Int16Array;
  /** With `layout: "regions"`: the connected areas, whose ids the groups' `region` meta gives. */
  readonly regions?: RegionMap;
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
const choosePalette = (counts: Map<number, number>, opaque: number, options: Required<Omit<VectorizeOptions, "palette">>): number[] => {
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

const oklab = (c: number): readonly [number, number, number] => srgbToOklab(c >> 16, (c >> 8) & 255, c & 255);
const lab2 = (a: readonly number[], b: readonly number[]): number => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

/** Folds areas smaller than `minArea` into the neighbour each shares the longest border with, until none is left (or none can go). */
const mergeSmall = (width: number, height: number, indices: Int16Array, minArea: number): RegionMap => {
  for (let round = 0; ; round++) {
    const map = labelRegions(width, height, indices);
    if (minArea <= 0 || round >= 16) return map;
    let changed = false;
    // Smallest first, each into a neighbour that is not itself going: an island of small areas still goes somewhere.
    const going = new Uint8Array(map.regions.length);
    for (const r of map.regions) if (r.area < minArea) going[r.id] = 1;
    const into = new Int32Array(map.regions.length).fill(-1);
    for (const r of [...map.regions].sort((a, b) => a.area - b.area)) {
      if (!going[r.id]) continue;
      let best = -1;
      let length = 0;
      for (const [other, shared] of r.neighbors) {
        if (other < 0) continue;
        const score = going[other] ? shared / 1024 : shared;
        if (score > length) {
          length = score;
          best = other;
        }
      }
      if (best < 0) continue;
      into[r.id] = best;
      going[r.id] = 0;
      changed = true;
    }
    if (!changed) return map;
    for (let i = 0; i < indices.length; i++) {
      const id = map.labels[i]!;
      if (id >= 0 && into[id]! >= 0) indices[i] = map.regions[into[id]!]!.value;
    }
  }
};

export const vectorize = (image: PixelData, options: VectorizeOptions = {}): VectorizeResult => {
  const o: Required<Omit<VectorizeOptions, "palette">> = {
    layout: options.layout ?? "layers",
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
  const fixed = options.palette;
  const palette = fixed
    ? fixed.map(({ color }) => {
        const c = parseColor(color);
        if (!c) throw new Error(`vectorize: palette color ${JSON.stringify(color)} is not a color`);
        return (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
      })
    : choosePalette(counts, opaque, o);
  const ids = fixed ? fixed.map((c) => c.id) : palette.map(hex);
  if (new Set(ids).size !== ids.length) throw new Error("vectorize: palette ids must be unique");
  // Every opaque pixel takes its nearest palette color, by OKLab; a fringe pixel goes to whichever side it is closer to.
  const labs = palette.map(oklab);
  const nearest = new Map<number, number>();
  const assigned = new Int16Array(n).fill(-1);
  for (let i = 0; i < n && palette.length > 0; i++) {
    const c = rgb[i]!;
    if (c < 0) continue;
    let k = nearest.get(c);
    if (k === undefined) {
      const lab = oklab(c);
      k = 0;
      for (let j = 1; j < labs.length; j++) if (lab2(lab, labs[j]!) < lab2(lab, labs[k]!)) k = j;
      nearest.set(c, k);
    }
    assigned[i] = k;
  }
  const regions = o.layout === "regions" ? mergeSmall(width, height, assigned, o.minArea) : undefined;
  const sizes = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < n; i++) if (assigned[i]! >= 0) sizes[assigned[i]!]!++;
  const colors: VectorizeColor[] = palette.map((c, k) => ({ id: ids[k]!, color: hex(c), pixels: sizes[k]! }));
  const base = { colors, width, height, indices: assigned };
  if (regions) return { ...drawRegions(regions, colors, o), ...base, regions };
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
    ctx.beginGroup({ meta: { color: hex(palette[k]!), colorId: ids[k]!, pixels: sizes[k]! } });
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
  return { document: ctx.getDocument(), palette: order.map((k) => hex(palette[k]!)), rings: ringCount, points: pointCount, ...base };
};

/** One fill per area, from shared borders. */
const drawRegions = (
  map: RegionMap,
  colors: readonly VectorizeColor[],
  o: Required<Omit<VectorizeOptions, "palette">>,
): { document: IRDocument; palette: string[]; rings: number; points: number } => {
  const outlines = traceBorders(map, { tolerance: o.tolerance, curves: o.curves, cornerAngle: o.cornerAngle });
  const ctx = new RecordingContext();
  for (const region of map.regions) {
    const color = colors[region.value]!;
    ctx.beginGroup({ meta: { region: region.id, color: color.color, colorId: color.id, pixels: region.area } });
    ctx.fillStyle = color.color;
    ctx.beginPath();
    traceRegionPath(ctx, outlines, region.id);
    ctx.fill();
    ctx.endGroup();
  }
  const rings = outlines.rings.reduce((n, r) => n + r.length, 0);
  // Each border is drawn twice, once by each side; count it once.
  const points = outlines.borders.reduce((n, b) => n + (b.pieces ? b.pieces.reduce((m, p) => m + (isStraight(p) ? 1 : 3), 0) : b.points.length - (b.closed ? 0 : 1)), 0);
  const used = colors.filter((c) => c.pixels > 0).sort((a, b) => b.pixels - a.pixels);
  return { document: ctx.getDocument(), palette: used.map((c) => c.color), rings, points };
};
