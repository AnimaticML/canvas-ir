import { applyToPoint, multiply } from "../math";
import type { Matrix2D, PathGeometry, Point, Rect } from "../types";
import { arcSweep, ellipseFrame } from "./flatten";

/** An axis-aligned box as min/max corners; easier to grow and test than a `Rect`. */
export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export const EMPTY_BOX: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

export const isEmptyBox = (b: Box): boolean => b.minX > b.maxX || b.minY > b.maxY;

export const boxToRect = (b: Box): Rect => ({ x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });

export const rectToBox = (r: Rect): Box => ({
  minX: Math.min(r.x, r.x + r.width),
  minY: Math.min(r.y, r.y + r.height),
  maxX: Math.max(r.x, r.x + r.width),
  maxY: Math.max(r.y, r.y + r.height),
});

export const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

export const expandBox = (b: Box, by: number): Box => ({
  minX: b.minX - by,
  minY: b.minY - by,
  maxX: b.maxX + by,
  maxY: b.maxY + by,
});

export const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export const boxOfPoints = (points: readonly Point[]): Box => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};

/** Roots in (0, 1) of a t^2 + b t + c. */
const unitRoots = (a: number, b: number, c: number): number[] => {
  const inside = (t: number): boolean => t > 0 && t < 1;
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter(inside);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b + sq) / (2 * a), (-b - sq) / (2 * a)].filter(inside);
};

/**
 * Exact bounds of a path's geometry (not its paint) in the space `space` maps
 * world space to. Curves contribute their true extrema, not their control points.
 */
export const pathBounds = (path: PathGeometry, space: Matrix2D): Box => {
  const toSpace = path.matrices.map((m) => multiply(space, m));
  const points: Point[] = [];
  for (const subpath of path.subpaths) {
    let from = applyToPoint(toSpace[subpath.m]!, subpath.start.x, subpath.start.y);
    points.push(from);
    for (const segment of subpath.segments) {
      const m = toSpace[segment.m]!;
      switch (segment.kind) {
        case "line":
          from = applyToPoint(m, segment.to.x, segment.to.y);
          points.push(from);
          break;
        case "quad": {
          const p1 = applyToPoint(m, segment.cp.x, segment.cp.y);
          const p2 = applyToPoint(m, segment.to.x, segment.to.y);
          for (const axis of ["x", "y"] as const) {
            const denom = from[axis] - 2 * p1[axis] + p2[axis];
            if (Math.abs(denom) < 1e-12) continue;
            const t = (from[axis] - p1[axis]) / denom;
            if (t <= 0 || t >= 1) continue;
            const s = 1 - t;
            points.push({
              x: s * s * from.x + 2 * s * t * p1.x + t * t * p2.x,
              y: s * s * from.y + 2 * s * t * p1.y + t * t * p2.y,
            });
          }
          points.push(p2);
          from = p2;
          break;
        }
        case "cubic": {
          const p1 = applyToPoint(m, segment.cp1.x, segment.cp1.y);
          const p2 = applyToPoint(m, segment.cp2.x, segment.cp2.y);
          const p3 = applyToPoint(m, segment.to.x, segment.to.y);
          for (const axis of ["x", "y"] as const) {
            const a = -from[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
            const b = 2 * (from[axis] - 2 * p1[axis] + p2[axis]);
            const c = p1[axis] - from[axis];
            for (const t of unitRoots(a, b, c)) {
              const s = 1 - t;
              const k0 = s * s * s;
              const k1 = 3 * s * s * t;
              const k2 = 3 * s * t * t;
              const k3 = t * t * t;
              points.push({
                x: k0 * from.x + k1 * p1.x + k2 * p2.x + k3 * p3.x,
                y: k0 * from.y + k1 * p1.y + k2 * p2.y + k3 * p3.y,
              });
            }
          }
          points.push(p3);
          from = p3;
          break;
        }
        case "arc":
        case "ellipse": {
          const { c, u, v } = ellipseFrame(segment, m);
          const at = (t: number): Point => ({
            x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t),
            y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t),
          });
          const start = segment.startAngle;
          const sweep = arcSweep(segment);
          points.push(at(start));
          // Each coordinate is extreme where its derivative -u sin t + v cos t vanishes.
          for (const axis of ["x", "y"] as const) {
            const base = Math.atan2(v[axis], u[axis]);
            for (const candidate of [base, base + Math.PI]) {
              const offset = sweep >= 0 ? candidate - start : start - candidate;
              const k = ((offset % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
              if (k <= Math.abs(sweep)) points.push(at(start + Math.sign(sweep || 1) * k));
            }
          }
          from = at(start + sweep);
          points.push(from);
          break;
        }
      }
    }
  }
  return boxOfPoints(points);
};
