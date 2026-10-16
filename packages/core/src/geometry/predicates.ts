import type { FillRule, Point } from "../types";
import type { Box } from "./bounds";

/** Distance from `p` to segment ab, and the closest point on it. */
export const segmentClosest = (p: Point, a: Point, b: Point): { point: Point; distance: number; t: number } => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { point, distance: Math.hypot(p.x - point.x, p.y - point.y), t };
};

/** Inside test for a convex polygon of either orientation; points on an edge count as inside. */
export const inConvex = (p: Point, polygon: readonly Point[]): boolean => {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/** Distance from `p` to a polygon's boundary. */
export const distanceToRing = (p: Point, ring: readonly Point[], closed = true): number => {
  let best = Infinity;
  const n = ring.length;
  const edges = closed ? n : n - 1;
  if (n === 1) return Math.hypot(p.x - ring[0]!.x, p.y - ring[0]!.y);
  for (let i = 0; i < edges; i++) {
    const d = segmentClosest(p, ring[i]!, ring[(i + 1) % n]!).distance;
    if (d < best) best = d;
  }
  return best;
};

/** Winding number of the closed rings around `p`. */
export const winding = (p: Point, rings: readonly (readonly Point[])[]): number => {
  let w = 0;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
        w--;
      }
    }
  }
  return w;
};

export const insideFill = (p: Point, rings: readonly (readonly Point[])[], rule: FillRule): boolean => {
  const w = winding(p, rings);
  return rule === "nonzero" ? w !== 0 : w % 2 !== 0;
};

export const inBox = (p: Point, b: Box): boolean => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/** Whether segment ab touches the box (Liang-Barsky clipping). */
export const segmentTouchesBox = (a: Point, b: Point, box: Box): boolean => {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - box.minX) &&
    clip(dx, box.maxX - a.x) &&
    clip(-dy, a.y - box.minY) &&
    clip(dy, box.maxY - a.y)
  );
};

export const boxCorners = (b: Box): Point[] => [
  { x: b.minX, y: b.minY },
  { x: b.maxX, y: b.minY },
  { x: b.maxX, y: b.maxY },
  { x: b.minX, y: b.maxY },
];

/** Whether a ring's boundary or vertices touch the box. Interior containment of the box is tested separately. */
export const ringTouchesBox = (ring: readonly Point[], box: Box, closed = true): boolean => {
  const n = ring.length;
  if (n === 1) return inBox(ring[0]!, box);
  const edges = closed ? n : n - 1;
  for (let i = 0; i < edges; i++) if (segmentTouchesBox(ring[i]!, ring[(i + 1) % n]!, box)) return true;
  return false;
};
