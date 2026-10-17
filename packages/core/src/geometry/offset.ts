import type { FillRule, Point } from "../types";
import { insideFill } from "./predicates";

type Ring = readonly Point[];

const signedArea = (ring: Ring): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

/**
 * The rings oriented so that, under the nonzero rule, they cover exactly what
 * they covered under `fillRule`: a ring with the filled side inside turns the
 * positive way, one with the filled side outside (a hole) the other way, and a
 * ring with fill on both sides or neither is dropped. The winding number is then
 * 1 inside and 0 outside. Rings are assumed not to cross each other.
 */
export const normalizeRings = (rings: readonly Ring[], fillRule: FillRule = "nonzero"): Point[][] => {
  const filled = rings.filter((r) => r.length >= 3 && signedArea(r) !== 0);
  const out: Point[][] = [];
  for (const ring of filled) {
    // Probe both sides of the ring's longest edge, a hair away from it.
    let best = 0;
    let len = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const l = Math.hypot(q.x - p.x, q.y - p.y);
      if (l > len) [best, len] = [i, l];
    }
    const p = ring[best]!;
    const q = ring[(best + 1) % ring.length]!;
    const eps = len * 1e-6;
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const side = (k: number): Point => ({ x: mid.x - ((q.y - p.y) / len) * eps * k, y: mid.y + ((q.x - p.x) / len) * eps * k });
    const [a, b] = [side(1), side(-1)];
    const interior = insideFill(a, [ring], "evenodd") ? a : b;
    const exterior = interior === a ? b : a;
    const fillIn = insideFill(interior, filled, fillRule);
    const fillOut = insideFill(exterior, filled, fillRule);
    if (fillIn === fillOut) continue;
    const positive = signedArea(ring) > 0;
    out.push(positive === fillIn ? [...ring] : [...ring].reverse());
  }
  return out;
};

/** A polygon around a circle of radius r, within `tolerance` outside it, turning the positive way. */
const disk = (c: Point, r: number, tolerance: number): Point[] => {
  const n = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - Math.min(tolerance, r) / r))));
  const R = r / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, i) => ({ x: c.x + R * Math.cos((i / n) * 2 * Math.PI), y: c.y + R * Math.sin((i / n) * 2 * Math.PI) }));
};

/**
 * Every point within `distance` of the rings' edges, as rings that all turn the
 * positive way, so their nonzero fill is the union: a rectangle along each edge,
 * and a disk at each vertex whose turn leaves a gap wider than `tolerance`.
 */
export const outlineBand = (rings: readonly Ring[], distance: number, tolerance = 0.1): Point[][] => {
  if (!(distance > 0)) return [];
  const out: Point[][] = [];
  const positive = (ring: Point[]): Point[] => (signedArea(ring) > 0 ? ring : ring.reverse());
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 0) {
        const nx = (-(b.y - a.y) / len) * distance;
        const ny = ((b.x - a.x) / len) * distance;
        out.push(positive([
          { x: a.x + nx, y: a.y + ny },
          { x: b.x + nx, y: b.y + ny },
          { x: b.x - nx, y: b.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ]));
      }
      // Between this edge's and the previous edge's rectangles, a turn of θ leaves a wedge d (1 - cos(θ/2)) deep.
      const prev = ring[(i - 1 + n) % n]!;
      const u = Math.atan2(a.y - prev.y, a.x - prev.x);
      const v = Math.atan2(b.y - a.y, b.x - a.x);
      let turn = Math.abs(v - u);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (n < 2 || distance * (1 - Math.cos(turn / 2)) > tolerance || len === 0) out.push(disk(a, distance, tolerance));
    }
  }
  return out;
};

/**
 * The region grown by `distance`: every point inside it or within `distance` of
 * its outline, with round corners, within `tolerance`. The result is meant for
 * the nonzero rule. To shrink a region, subtract `outlineBand` from it instead
 * (text layout does that for padding).
 */
export const offsetRings = (rings: readonly Ring[], distance: number, options: { fillRule?: FillRule; tolerance?: number } = {}): Point[][] => {
  if (distance < 0) throw new RangeError("offsetRings grows regions; subtract outlineBand to shrink one");
  const normalized = normalizeRings(rings, options.fillRule ?? "nonzero");
  return [...normalized, ...outlineBand(normalized, distance, options.tolerance ?? 0.1)];
};
