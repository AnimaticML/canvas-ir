import type { Point } from "canvas-ir";

/** A horizontal span [left, right]. */
export type Interval = readonly [number, number];

export interface Region {
  /** Closed rings, in the same space as the layout. */
  readonly rings: readonly (readonly Point[])[];
  readonly fillRule?: "nonzero" | "evenodd";
}

interface Crossing {
  readonly xa: number;
  readonly xb: number;
  readonly xm: number;
  readonly dir: number;
}

/** Each ring's vertical extent, cached: a band skips rings it can't meet. */
const extents = new WeakMap<readonly Point[], readonly [number, number]>();
const extentOf = (ring: readonly Point[]): readonly [number, number] => {
  let e = extents.get(ring);
  if (!e) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of ring) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    e = [lo, hi];
    extents.set(ring, e);
  }
  return e;
};

/** The rings that reach into the band [y0, y1]. */
const ringsIn = (region: Region, y0: number, y1: number): (readonly Point[])[] =>
  region.rings.filter((ring) => {
    const [lo, hi] = extentOf(ring);
    return hi >= y0 && lo <= y1;
  });

/**
 * The parts of a region inside a horizontal band [y0, y1], as intervals per
 * stretch of the band between vertex heights. Between two consecutive vertex
 * heights no edge starts or ends, so each edge's x is linear in y there and the
 * stretch's inside spans are exact from its two ends.
 */
const stretches = (region: Region, y0: number, y1: number): { a: number; b: number; spans: [Crossing, Crossing][] }[] => {
  const rings = ringsIn(region, y0, y1);
  const ys = new Set<number>([y0, y1]);
  for (const ring of rings) for (const p of ring) if (p.y > y0 && p.y < y1) ys.add(p.y);
  const events = [...ys].sort((p, q) => p - q);
  const evenOdd = region.fillRule === "evenodd";
  const result: { a: number; b: number; spans: [Crossing, Crossing][] }[] = [];
  for (let i = 0; i + 1 < events.length; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    const m = (a + b) / 2;
    const crossings: Crossing[] = [];
    for (const ring of rings) {
      for (let j = 0; j < ring.length; j++) {
        const p = ring[j]!;
        const q = ring[(j + 1) % ring.length]!;
        if (p.y === q.y) continue;
        const lo = Math.min(p.y, q.y);
        const hi = Math.max(p.y, q.y);
        // No vertex lies strictly inside the stretch, so an edge that reaches into it spans all of it.
        if (lo > a || hi < b) continue;
        const at = (y: number): number => p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y);
        crossings.push({ xa: at(a), xb: at(b), xm: at(m), dir: q.y > p.y ? 1 : -1 });
      }
    }
    crossings.sort((c, d) => c.xm - d.xm);
    const spans: [Crossing, Crossing][] = [];
    let winding = 0;
    for (let k = 0; k + 1 < crossings.length; k++) {
      winding += crossings[k]!.dir;
      const inside = evenOdd ? (k + 1) % 2 === 1 : winding !== 0;
      if (inside) spans.push([crossings[k]!, crossings[k + 1]!]);
    }
    result.push({ a, b, spans });
  }
  return result;
};

const normalize = (intervals: Interval[]): Interval[] => {
  const sorted = intervals.filter(([l, r]) => r > l).sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const [l, r] of sorted) {
    const last = merged[merged.length - 1];
    if (last && l <= last[1]) last[1] = Math.max(last[1], r);
    else merged.push([l, r]);
  }
  return merged;
};

const intersect = (a: readonly Interval[], b: readonly Interval[]): Interval[] => {
  const out: Interval[] = [];
  for (const [l1, r1] of a) for (const [l2, r2] of b) if (Math.min(r1, r2) > Math.max(l1, l2)) out.push([Math.max(l1, l2), Math.min(r1, r2)]);
  return normalize(out);
};

const subtract = (a: readonly Interval[], b: readonly Interval[]): Interval[] => {
  let current = [...a];
  for (const [l2, r2] of b) {
    const next: Interval[] = [];
    for (const [l1, r1] of current) {
      if (r2 <= l1 || l2 >= r1) next.push([l1, r1]);
      else {
        if (l2 > l1) next.push([l1, l2]);
        if (r2 < r1) next.push([r2, r1]);
      }
    }
    current = next;
  }
  return current;
};

/** The x-intervals that are inside `region` for the whole height of the band. */
export const insideForBand = (region: Region, y0: number, y1: number): Interval[] => {
  let result: Interval[] | null = null;
  for (const { spans } of stretches(region, y0, y1)) {
    const here = normalize(spans.map(([l, r]) => [Math.max(l.xa, l.xb), Math.min(r.xa, r.xb)] as Interval));
    result = result === null ? here : intersect(result, here);
    if (result.length === 0) return [];
  }
  return result ?? [];
};

/**
 * The x-intervals that `region` touches anywhere in the band: its projection
 * onto x. A point of the region in the band either sees the band's top edge
 * straight up without leaving the region, so its x is inside at y0, or crosses
 * the region's outline on the way, so its x is under an outline edge within
 * the band. This takes time in the number of edges, not edges times vertices.
 */
export const touchedInBand = (region: Region, y0: number, y1: number): Interval[] => {
  const evenOdd = region.fillRule === "evenodd";
  const out: Interval[] = [];
  const crossings: { x: number; dir: number }[] = [];
  for (const ring of ringsIn(region, y0, y1)) {
    for (let j = 0; j < ring.length; j++) {
      const p = ring[j]!;
      const q = ring[(j + 1) % ring.length]!;
      const lo = Math.min(p.y, q.y);
      const hi = Math.max(p.y, q.y);
      if (hi < y0 || lo > y1) continue;
      if (p.y === q.y) {
        out.push([Math.min(p.x, q.x), Math.max(p.x, q.x)]);
        continue;
      }
      const at = (y: number): number => p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y);
      const xa = at(Math.max(lo, y0));
      const xb = at(Math.min(hi, y1));
      out.push([Math.min(xa, xb), Math.max(xa, xb)]);
      // Half-open in y, so a vertex at y0 counts once.
      if (lo <= y0 && y0 < hi) crossings.push({ x: at(y0), dir: q.y > p.y ? 1 : -1 });
    }
  }
  crossings.sort((c, d) => c.x - d.x);
  let winding = 0;
  for (let k = 0; k + 1 < crossings.length; k++) {
    winding += crossings[k]!.dir;
    if (evenOdd ? (k + 1) % 2 === 1 : winding !== 0) out.push([crossings[k]!.x, crossings[k + 1]!.x]);
  }
  return normalize(out);
};

/** Where a line in the band [y0, y1] can go: inside the container and clear of every obstacle. */
export const bandIntervals = (container: Region, obstacles: readonly Region[], y0: number, y1: number): Interval[] => {
  let free = insideForBand(container, y0, y1);
  for (const obstacle of obstacles) {
    if (free.length === 0) break;
    free = subtract(free, touchedInBand(obstacle, y0, y1));
  }
  return free;
};

/** The vertical extent of a region. */
export const regionTopBottom = (region: Region): { top: number; bottom: number } => {
  let top = Infinity;
  let bottom = -Infinity;
  for (const ring of region.rings) {
    for (const p of ring) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
  }
  return { top, bottom };
};
