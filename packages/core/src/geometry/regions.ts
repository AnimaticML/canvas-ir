// Connected regions of a labeled image, and their outlines traced with every
// border between two regions shared: simplified or fitted with curves once,
// and used forwards by one region and backwards by the other, so neighbours
// never open a gap or overlap where they meet.
import type { Point } from "../types";
import { type CubicPiece, type CurveTarget, fitCurve, isStraight, simplifyPolyline } from "./curves";
import { type PixelBox, simplifyRing, traceMask } from "./trace";

export interface Region {
  /** The region's index in `RegionMap.regions`, and its label in `labels`. */
  readonly id: number;
  /** The value its pixels share, such as a palette index. */
  readonly value: number;
  /** Pixels in it. */
  readonly area: number;
  readonly bounds: PixelBox;
  /** Regions it shares an edge with, and how many pixel edges long that border is. `-1` is the image's edge or an empty pixel. */
  readonly neighbors: ReadonlyMap<number, number>;
}

export interface RegionMap {
  readonly width: number;
  readonly height: number;
  /** Each pixel's region id, row by row; -1 where the pixel is empty. */
  readonly labels: Int32Array;
  readonly regions: readonly Region[];
}

export interface LabelOptions {
  /**
   * 4: pixels join a region through a shared edge only, so two areas of one
   * value touching at a corner stay two regions. 8: corners join them too.
   * Default 4.
   */
  readonly connectivity?: 4 | 8;
  /** Pixels with this value belong to no region. Default -1. */
  readonly empty?: number;
}

/**
 * Splits an image of values (a palette index per pixel, say) into connected
 * regions of equal value, with each region's area, bounds and neighbours.
 * Region ids follow the scan order of each region's first pixel, so the same
 * values always give the same ids.
 */
export const labelRegions = (width: number, height: number, values: ArrayLike<number>, options: LabelOptions = {}): RegionMap => {
  const connectivity = options.connectivity ?? 4;
  const empty = options.empty ?? -1;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const found: { value: number; area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || values[start] === empty) continue;
    const id = found.length;
    const value = values[start]!;
    const r = { value, area: 0, x0: width, y0: height, x1: -1, y1: -1 };
    found.push(r);
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      r.area++;
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
      const visit = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const j = ny * width + nx;
        if (labels[j] !== -1 || values[j] !== value) return;
        labels[j] = id;
        stack[top++] = j;
      };
      visit(x + 1, y);
      visit(x - 1, y);
      visit(x, y + 1);
      visit(x, y - 1);
      if (connectivity === 8) {
        visit(x + 1, y + 1);
        visit(x - 1, y + 1);
        visit(x + 1, y - 1);
        visit(x - 1, y - 1);
      }
    }
  }
  // Neighbours through shared pixel edges, the image's edge counting as -1.
  const neighbors = found.map(() => new Map<number, number>());
  const touch = (a: number, b: number): void => {
    if (a === b) return;
    if (a >= 0) neighbors[a]!.set(b, (neighbors[a]!.get(b) ?? 0) + 1);
    if (b >= 0) neighbors[b]!.set(a, (neighbors[b]!.get(a) ?? 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = labels[y * width + x]!;
      touch(here, x + 1 < width ? labels[y * width + x + 1]! : -1);
      touch(here, y + 1 < height ? labels[(y + 1) * width + x]! : -1);
      if (x === 0) touch(here, -1);
      if (y === 0) touch(here, -1);
    }
  }
  const regions = found.map((r, id) => ({
    id,
    value: r.value,
    area: r.area,
    bounds: { x: r.x0, y: r.y0, width: r.x1 - r.x0 + 1, height: r.y1 - r.y0 + 1 },
    neighbors: neighbors[id]!,
  }));
  return { width, height, labels, regions };
};

/**
 * One region's exact outline, traced within its bounds: rings along pixel
 * edges, outer ones clockwise on screen and holes counterclockwise, in the
 * image's pixel space. Fill them with the nonzero rule.
 */
export const traceRegion = (map: RegionMap, id: number): Point[][] => {
  const region = map.regions[id];
  if (!region) return [];
  const { width, labels } = map;
  return traceMask(map.width, map.height, (x, y) => labels[y * width + x] === id, { bounds: region.bounds });
};

/**
 * A stretch of boundary between two regions, from one junction (where three
 * or more meet, or two touch at a corner) to the next, or a closed loop when
 * one region lies inside another. Walking from the first point to the last,
 * `right` is on the right on screen and `left` on the left; -1 is the
 * image's edge or empty pixels.
 */
export interface Border {
  readonly id: number;
  readonly left: number;
  readonly right: number;
  readonly closed: boolean;
  /** The exact border, along pixel edges, every corner kept. A closed border repeats no point. */
  readonly exact: readonly Point[];
  /** The border simplified to within the tolerance, its ends (junctions) kept where they are; less smooth (down to exact) where simplifying would cross another border. */
  readonly points: readonly Point[];
  /** With curves: the border as cubic pieces, ends kept. */
  readonly pieces?: readonly CubicPiece[];
}

/** A border as one region walks it: forwards when the region is on its right, backwards otherwise. */
export interface BorderUse {
  readonly border: number;
  readonly reversed: boolean;
}

export interface BorderOptions {
  /** How far, in pixels, a simplified border may stray from the pixel edges. Default 0.75; 0 keeps them exact. */
  readonly tolerance?: number;
  /** Also fit cubic curves to each border, within `tolerance + 0.5`. Default false. */
  readonly curves?: boolean;
  /** Turns sharper than this, in degrees, stay corners when fitting curves. Default 50. */
  readonly cornerAngle?: number;
}

export interface RegionOutlines {
  readonly borders: readonly Border[];
  /** Each region's rings, as the borders it walks in order; outer rings clockwise on screen, holes counterclockwise. */
  readonly rings: readonly (readonly (readonly BorderUse[])[])[];
}

/**
 * Traces every region of a map at once, with each border between two
 * regions found, simplified and fitted once and shared by both, so filling
 * every region leaves no gap and no overlap along the borders. Junctions stay
 * on the pixel lattice. Where a simplified or curved border would cross
 * another (two running within the tolerance of each other), both are smoothed
 * less, in steps down to the exact pixel edges, so the outlines never tangle. With a tolerance below
 * 0.5 every pixel's center also stays inside its own region; above that, thin
 * parts of small regions may lose a pixel or two to their neighbours.
 */
export const traceBorders = (map: RegionMap, options: BorderOptions = {}): RegionOutlines => {
  const { width: w, height: h, labels } = map;
  const tolerance = options.tolerance ?? 0.75;
  const label = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]!);
  // Unit edges: horizontal (x, y)–(x+1, y), numbered y * w + x; vertical (x, y)–(x, y+1), numbered after them.
  const H = (h + 1) * w;
  const hEdge = (x: number, y: number): number => y * w + x;
  const vEdge = (x: number, y: number): number => H + y * (w + 1) + x;
  const isBoundary = (e: number): boolean => {
    if (e < H) {
      const x = e % w;
      const y = (e - x) / w;
      return label(x, y - 1) !== label(x, y);
    }
    const k = e - H;
    const x = k % (w + 1);
    const y = (k - x) / (w + 1);
    return label(x - 1, y) !== label(x, y);
  };
  /** The boundary edges at a vertex, with the vertex each leads to. */
  const around = (x: number, y: number): { edge: number; to: Point }[] => {
    const out: { edge: number; to: Point }[] = [];
    if (y > 0 && label(x - 1, y - 1) !== label(x, y - 1)) out.push({ edge: vEdge(x, y - 1), to: { x, y: y - 1 } });
    if (y < h && label(x - 1, y) !== label(x, y)) out.push({ edge: vEdge(x, y), to: { x, y: y + 1 } });
    if (x > 0 && label(x - 1, y - 1) !== label(x - 1, y)) out.push({ edge: hEdge(x - 1, y), to: { x: x - 1, y } });
    if (x < w && label(x, y - 1) !== label(x, y)) out.push({ edge: hEdge(x, y), to: { x: x + 1, y } });
    return out;
  };
  // Where a border meets or leaves the image's frame, and the frame's corners, stay put, so the picture keeps its edges.
  const onFrame = (p: Point): boolean => p.x === 0 || p.y === 0 || p.x === w || p.y === h;
  const alongFrame = (p: Point, q: Point): boolean => (p.x === q.x && (p.x === 0 || p.x === w)) || (p.y === q.y && (p.y === 0 || p.y === h));
  /**
   * A border smoothed at a level: 0 as asked; 1 at half the tolerance; 2 cutting
   * every pixel corner (the midpoints of the pixel edges, so a staircase becomes
   * a slope), with curves if asked; 3 the same without curves; 4 the exact
   * pixel edges. Higher levels are for
   * borders that crossed a neighbour at the level before.
   */
  const smooth = (exact: readonly Point[], closed: boolean, level = 0): { points: Point[]; pieces?: CubicPiece[] } => {
    if ((tolerance <= 0 && !options.curves) || level >= 4) return { points: collinear(exact, closed) };
    const tol = level === 0 ? tolerance : level === 1 ? tolerance / 2 : Math.min(tolerance, 0.3);
    const curves = options.curves && level < 3;
    const n = exact.length;
    const anchor = (i: number): boolean => {
      const p = exact[i]!;
      if (!onFrame(p)) return false;
      const prev = closed || i > 0 ? exact[(i + n - 1) % n] : undefined;
      const next = closed || i < n - 1 ? exact[(i + 1) % n] : undefined;
      return !prev || !next || !alongFrame(prev, p) || !alongFrame(p, next) || (prev.x !== next.x && prev.y !== next.y);
    };
    const anchors = exact.map((_, i) => i).filter(anchor);
    const fit = (edges: readonly Point[], ring: boolean): { points: Point[]; pieces: CubicPiece[] | undefined } => {
      // Each pixel edge's midpoint, the ends kept: corners cut by at most half a pixel.
      const mid = edges.slice(0, ring ? edges.length : edges.length - 1).map((p, i) => {
        const q = edges[(i + 1) % edges.length]!;
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      });
      const cut = ring ? mid : [edges[0]!, ...mid, edges.at(-1)!];
      const pts = level >= 2 ? cut : edges;
      const points = tol <= 0 ? collinear(pts, ring) : ring ? simplifyRing(pts, tol) : simplifyPolyline(pts, tol);
      // Long borders: the pixel edges themselves, corners found a few pixels each way, so a staircase reads as a curve.
      // Short ones, a few pixels between junctions, have no room to find corners: their cut corners are fitted.
      const short = edges.length <= 12;
      const pieces = curves
        ? fitCurve(level >= 2 || short ? cut : collinear(edges, ring), level >= 2 ? tol : short ? tol + 0.25 : tol + 0.5, { closed: ring, cornerAngle: options.cornerAngle ?? 50, cornerWindow: short ? 1 : 3 })
        : undefined;
      return { points, pieces };
    };
    if (closed && anchors.length === 0) {
      const { points, pieces } = fit(exact, true);
      return pieces ? { points, pieces } : { points };
    }
    // Simplify between anchors; a closed border starts at its first anchor and comes back to it.
    const start = closed ? anchors[0]! : 0;
    const order = closed ? [...exact.slice(start), ...exact.slice(0, start + 1)] : [...exact];
    const cuts = closed ? [...anchors.map((i) => i - start), n] : [0, ...anchors.filter((i) => i > 0 && i < n - 1), n - 1];
    const points: Point[] = [];
    const pieces: CubicPiece[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const part = fit(order.slice(cuts[k]!, cuts[k + 1]! + 1), false);
      points.push(...(points.length > 0 ? part.points.slice(1) : part.points));
      if (part.pieces) pieces.push(...part.pieces);
    }
    if (closed) points.pop();
    return curves ? { points, pieces } : { points };
  };
  const visited = new Uint8Array(H + (w + 1) * h);
  const borders: Border[] = [];
  const total = visited.length;
  for (let e = 0; e < total; e++) {
    if (visited[e] || !isBoundary(e)) continue;
    visited[e] = 1;
    let from: Point;
    let to: Point;
    if (e < H) {
      const x = e % w;
      const y = (e - x) / w;
      from = { x, y };
      to = { x: x + 1, y };
    } else {
      const k = e - H;
      const x = k % (w + 1);
      const y = (k - x) / (w + 1);
      from = { x, y };
      to = { x, y: y + 1 };
    }
    // Walk on through vertices where the border only passes (two boundary edges), each way.
    const extend = (end: Point, line: Point[]): boolean => {
      let at = end;
      for (;;) {
        const edges = around(at.x, at.y);
        if (edges.length !== 2) return false;
        const next = edges.find((x) => !visited[x.edge]);
        if (!next) return true;
        visited[next.edge] = 1;
        line.push(next.to);
        at = next.to;
      }
    };
    const ahead: Point[] = [];
    const loop = extend(to, ahead);
    const behind: Point[] = [];
    if (!loop) extend(from, behind);
    const exact = [...behind.reverse(), from, to, ...ahead];
    // A loop came back to where it began: drop the repeated point.
    const closed = loop;
    if (closed) exact.pop();
    // Which region is on each side, from the first step: on screen, right of (dx, dy) is (-dy, dx).
    const a = exact[0]!;
    const b = exact[1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const right = dx === 1 ? label(a.x, a.y) : dx === -1 ? label(a.x - 1, a.y - 1) : dy === 1 ? label(a.x - 1, a.y) : label(a.x, a.y - 1);
    const left = dx === 1 ? label(a.x, a.y - 1) : dx === -1 ? label(a.x - 1, a.y) : dy === 1 ? label(a.x, a.y) : label(a.x - 1, a.y - 1);
    borders.push({ id: borders.length, left, right, closed, exact, ...smooth(exact, closed) });
  }
  if (tolerance > 0 || options.curves) untangle(borders, smooth);

  // Each region's rings: its borders, oriented so it is on their right, chained end to start.
  const uses = map.regions.map(() => [] as BorderUse[]);
  for (const border of borders) {
    if (border.right >= 0) uses[border.right]!.push({ border: border.id, reversed: false });
    if (border.left >= 0) uses[border.left]!.push({ border: border.id, reversed: true });
  }
  const key = (p: Point): number => p.y * (w + 1) + p.x;
  const ends = (use: BorderUse): { start: number; end: number } => {
    const pts = borders[use.border]!.exact;
    const first = key(pts[0]!);
    const last = key(pts.at(-1)!);
    return use.reversed ? { start: last, end: first } : { start: first, end: last };
  };
  const rings = uses.map((list) => {
    const out: BorderUse[][] = [];
    const starting = new Map<number, BorderUse[]>();
    for (const use of list) {
      if (borders[use.border]!.closed) {
        out.push([use]);
        continue;
      }
      const { start } = ends(use);
      const at = starting.get(start);
      if (at) at.push(use);
      else starting.set(start, [use]);
    }
    // Any choice where a region meets itself at a corner gives the same filled area.
    for (const [start, list] of starting) {
      while (list.length > 0) {
        const ring: BorderUse[] = [];
        let use = list.pop()!;
        for (;;) {
          ring.push(use);
          const { end } = ends(use);
          if (end === start) break;
          const next = starting.get(end)?.pop();
          if (!next) break;
          use = next;
        }
        out.push(ring);
      }
    }
    return out;
  });
  return { borders, rings };
};

/** A border as the segments it is drawn with: its points, or its curves flattened. */
const drawnSegments = (border: Border): Point[] => {
  if (border.pieces && border.pieces.length > 0) {
    const out: Point[] = [border.pieces[0]!.from];
    for (const p of border.pieces) {
      if (isStraight(p)) {
        out.push(p.to);
        continue;
      }
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        out.push({ x: a * p.from.x + b * p.c1.x + c * p.c2.x + d * p.to.x, y: a * p.from.y + b * p.c1.y + c * p.c2.y + d * p.to.y });
      }
    }
    return out;
  }
  return border.closed ? [...border.points, border.points[0]!] : [...border.points];
};

/**
 * Whether segments ab and cd meet anywhere but at an end they share: crossing,
 * one touching the other's middle, or running along it.
 */
const crosses = (a: Point, b: Point, c: Point, d: Point): boolean => {
  const side = (p: Point, q: Point, r: Point): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const same = (p: Point, q: Point): boolean => p.x === q.x && p.y === q.y;
  // Strictly between p and q, given r is on their line.
  const within = (p: Point, q: Point, r: Point): boolean =>
    !same(r, p) && !same(r, q) && Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  const s1 = side(a, b, c);
  const s2 = side(a, b, d);
  const s3 = side(c, d, a);
  const s4 = side(c, d, b);
  if (s1 * s2 < 0 && s3 * s4 < 0) return true;
  return (s1 === 0 && within(a, b, c)) || (s2 === 0 && within(a, b, d)) || (s3 === 0 && within(c, d, a)) || (s4 === 0 && within(c, d, b));
};

/**
 * Steps every border that crosses another border or itself, or turns a
 * region inside out at a junction, down a smoothing level (half the tolerance,
 * then pixel corners cut, curved and then straight, then the exact pixel edges) until none do. Exact
 * borders never cross, so this ends; borders in tight places end up a little
 * less smooth and the rest stay as asked.
 */
const untangle = (borders: Border[], smooth: (exact: readonly Point[], closed: boolean, level: number) => { points: Point[]; pieces?: CubicPiece[] }): void => {
  const CELL = 8;
  const levels = new Uint8Array(borders.length);
  for (let round = 0; round < 64; round++) {
    const grid = new Map<number, { border: number; i: number }[]>();
    const lines = borders.map(drawnSegments);
    const cellsOf = (a: Point, b: Point): number[] => {
      const out: number[] = [];
      const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
      const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const y0 = Math.floor(Math.min(a.y, b.y) / CELL);
      const y1 = Math.floor(Math.max(a.y, b.y) / CELL);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push((y + 1) * 65536 + x + 1);
      return out;
    };
    const bad = new Set<number>();
    lines.forEach((line, border) => {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i]!;
        const b = line[i + 1]!;
        for (const cell of cellsOf(a, b)) {
          const there = grid.get(cell);
          if (!there) {
            grid.set(cell, [{ border, i }]);
            continue;
          }
          for (const other of there) {
            // Neighbouring segments of one border share an end; they cannot cross.
            if (other.border === border && Math.abs(other.i - i) <= 1) continue;
            const o = lines[other.border]!;
            if (crosses(a, b, o[other.i]!, o[other.i + 1]!)) {
              bad.add(border);
              bad.add(other.border);
            }
          }
          there.push({ border, i });
        }
      }
    });
    // Around each junction the borders must leave in the same turning order as
    // the exact ones, or a region between two of them has turned inside out.
    const leaving = new Map<string, { border: number; exact: number; drawn: number }[]>();
    lines.forEach((line, border) => {
      const { exact, closed } = borders[border]!;
      if (closed || line.length < 2) return;
      const n = exact.length;
      const angle = (p: Point, q: Point): number => Math.atan2(q.y - p.y, q.x - p.x);
      for (const [at, next, drawn] of [
        [exact[0]!, exact[1]!, angle(line[0]!, line[1]!)],
        [exact[n - 1]!, exact[n - 2]!, angle(line.at(-1)!, line.at(-2)!)],
      ] as const) {
        const key = `${at.x},${at.y}`;
        const list = leaving.get(key) ?? [];
        list.push({ border, exact: angle(at, next), drawn });
        leaving.set(key, list);
      }
    });
    for (const list of leaving.values()) {
      if (list.length < 3) continue;
      list.sort((p, q) => p.exact - q.exact);
      let descents = 0;
      for (let i = 0; i < list.length; i++) if (list[(i + 1) % list.length]!.drawn <= list[i]!.drawn) descents++;
      if (descents !== 1) for (const l of list) bad.add(l.border);
    }
    if (bad.size === 0) return;
    let changed = false;
    for (const id of bad) {
      if (levels[id]! >= 4) continue;
      const border = borders[id]!;
      levels[id]!++;
      borders[id] = { id, left: border.left, right: border.right, closed: border.closed, exact: border.exact, ...smooth(border.exact, border.closed, levels[id]!) };
      changed = true;
    }
    if (!changed) return;
  }
};

/** Drops points in the middle of straight runs, keeping every corner: the exact outline with fewer points. */
const collinear = (points: readonly Point[], closed: boolean): Point[] => {
  const n = points.length;
  if (n < 3) return [...points];
  const keep = (i: number): boolean => {
    if (!closed && (i === 0 || i === n - 1)) return true;
    const p = points[(i + n - 1) % n]!;
    const q = points[i]!;
    const r = points[(i + 1) % n]!;
    return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x) !== 0;
  };
  return points.filter((_, i) => keep(i));
};

/** A border's points in the direction a region walks it. */
const walk = (border: Border, reversed: boolean, exact: boolean): readonly Point[] => {
  const pts = exact ? border.exact : border.points;
  return reversed ? [...pts].reverse() : pts;
};

/**
 * A region's rings as points, from the shared borders: simplified, or with
 * `exact` along the pixel edges. Neighbouring regions' rings meet exactly.
 */
export const regionRings = (outlines: RegionOutlines, id: number, exact = false): Point[][] =>
  (outlines.rings[id] ?? []).map((ring) => {
    const out: Point[] = [];
    for (const use of ring) {
      const border = outlines.borders[use.border]!;
      const pts = walk(border, use.reversed, exact);
      // Each border starts where the last ended; a closed border is a ring by itself.
      for (let i = out.length === 0 || border.closed ? 0 : 1; i < pts.length; i++) out.push(pts[i]!);
    }
    if (out.length > 1 && out[0]!.x === out.at(-1)!.x && out[0]!.y === out.at(-1)!.y) out.pop();
    return out;
  });

/**
 * Adds a region's outline to a path: its rings from the shared borders, as
 * curves when they were fitted, else as the simplified points. Fill with the
 * nonzero rule.
 */
export const traceRegionPath = (target: CurveTarget, outlines: RegionOutlines, id: number): void => {
  for (const ring of outlines.rings[id] ?? []) {
    let started = false;
    for (const use of ring) {
      const border = outlines.borders[use.border]!;
      if (border.pieces && border.pieces.length > 0) {
        const pieces = use.reversed ? [...border.pieces].reverse().map((p) => ({ from: p.to, c1: p.c2, c2: p.c1, to: p.from })) : border.pieces;
        if (!started) {
          target.moveTo(pieces[0]!.from.x, pieces[0]!.from.y);
          started = true;
        }
        for (const p of pieces) {
          if (isStraight(p)) target.lineTo(p.to.x, p.to.y);
          else target.bezierCurveTo(p.c1.x, p.c1.y, p.c2.x, p.c2.y, p.to.x, p.to.y);
        }
        continue;
      }
      const pts = walk(border, use.reversed, false);
      pts.forEach((p, i) => {
        if (!started) {
          target.moveTo(p.x, p.y);
          started = true;
        } else if (i > 0 || border.closed) target.lineTo(p.x, p.y);
      });
    }
    if (started) target.closePath();
  }
};
