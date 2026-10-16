import { IDENTITY, applyToPoint, multiply } from "../math";
import type { ArcSegment, EllipseSegment, Matrix2D, PathGeometry, Point } from "../types";

/**
 * A subpath flattened into a polyline in some target space. `smooth[i]` is true
 * when vertex `i` lies inside a curve rather than between two path calls, so a
 * stroke joins there without the line join style. Where a curve meets vertex
 * `i`, `tangentIn[i]` / `tangentOut[i]` hold the curve's exact direction there
 * (not a chord's), which joins and caps need: a sharp miter magnifies any error
 * in direction.
 */
export interface Polyline {
  readonly points: readonly Point[];
  readonly smooth: readonly boolean[];
  readonly tangentIn: readonly (Point | null)[];
  readonly tangentOut: readonly (Point | null)[];
  readonly closed: boolean;
}

const direction = (x: number, y: number): Point | null => {
  const len = Math.hypot(x, y);
  return len > 1e-12 ? { x: x / len, y: y / len } : null;
};

/** The first non-degenerate direction among the given vectors. */
const firstDirection = (...vectors: Point[]): Point | null => {
  for (const v of vectors) {
    const d = direction(v.x, v.y);
    if (d) return d;
  }
  return null;
};

const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

const TWO_PI = Math.PI * 2;
const MAX_PIECES = 1024;

/** The largest factor by which `m` stretches a unit vector (its largest singular value). */
export const maxScale = (m: Matrix2D): number => {
  const p = m.a * m.a + m.b * m.b;
  const q = m.c * m.c + m.d * m.d;
  const r = m.a * m.c + m.b * m.d;
  return Math.sqrt((p + q) / 2 + Math.sqrt(((p - q) / 2) ** 2 + r * r));
};

/**
 * The signed sweep an `arc` or `ellipse` call covers. A sweep of a full turn or
 * more in the drawing direction is exactly one turn. Otherwise the arc runs from
 * the start angle to the end angle in the drawing direction, and when the end is
 * behind the start it wraps; an end a whole number of turns behind gives a full
 * turn, not an empty arc (as browsers draw `arc(x, y, r, 0, 2 * Math.PI, true)`).
 */
export const arcSweep = (segment: ArcSegment | EllipseSegment): number => {
  const { startAngle: start, endAngle: end, counterclockwise: ccw } = segment;
  if (!ccw) {
    if (end - start >= TWO_PI) return TWO_PI;
    return start > end ? TWO_PI - ((start - end) % TWO_PI) : end - start;
  }
  if (start - end >= TWO_PI) return -TWO_PI;
  return start < end ? -(TWO_PI - ((end - start) % TWO_PI)) : -(start - end);
};

/**
 * The ellipse segment as `center + u cos t + v sin t` in the space `m` maps to.
 * Affine maps send ellipses to ellipses, so this stays exact under any transform.
 */
export const ellipseFrame = (segment: ArcSegment | EllipseSegment, m: Matrix2D): { c: Point; u: Point; v: Point } => {
  const [rx, ry, rotation] =
    segment.kind === "arc" ? [segment.radius, segment.radius, 0] : [segment.rx, segment.ry, segment.rotation];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const c = applyToPoint(m, segment.center.x, segment.center.y);
  const ux = rx * cos;
  const uy = rx * sin;
  const vx = -ry * sin;
  const vy = ry * cos;
  return {
    c,
    u: { x: m.a * ux + m.c * uy, y: m.b * ux + m.d * uy },
    v: { x: m.a * vx + m.c * vy, y: m.b * vx + m.d * vy },
  };
};

const clampPieces = (n: number): number => Math.min(MAX_PIECES, Math.max(1, Math.ceil(n)));

/**
 * Flattens every subpath into a polyline in the space `space` maps world space to,
 * within `tolerance` in that space. Lines are exact; curves use uniform
 * subdivision with the standard second-difference error bound.
 */
export const flattenPath = (path: PathGeometry, space: Matrix2D, tolerance: number): Polyline[] => {
  const toSpace = path.matrices.map((m) => multiply(space, m));
  const result: Polyline[] = [];
  for (const subpath of path.subpaths) {
    const points: Point[] = [applyToPoint(toSpace[subpath.m]!, subpath.start.x, subpath.start.y)];
    const smooth: boolean[] = [false];
    const tangentIn: (Point | null)[] = [null];
    const tangentOut: (Point | null)[] = [null];
    const add = (p: Point, isSmooth: boolean, tin: Point | null = null): void => {
      points.push(p);
      smooth.push(isSmooth);
      tangentIn.push(tin);
      tangentOut.push(null);
    };
    /** Records the exact direction a curve leaves the current last vertex in. */
    const leaving = (d: Point | null): void => {
      tangentOut[tangentOut.length - 1] = d;
    };
    for (const segment of subpath.segments) {
      const m = toSpace[segment.m]!;
      const from = points[points.length - 1]!;
      switch (segment.kind) {
        case "line":
          add(applyToPoint(m, segment.to.x, segment.to.y), false);
          break;
        case "quad": {
          const p1 = applyToPoint(m, segment.cp.x, segment.cp.y);
          const p2 = applyToPoint(m, segment.to.x, segment.to.y);
          const dd = Math.hypot(from.x - 2 * p1.x + p2.x, from.y - 2 * p1.y + p2.y);
          const n = clampPieces(Math.sqrt(dd / (4 * tolerance)));
          leaving(firstDirection(minus(p1, from), minus(p2, from)));
          const end = firstDirection(minus(p2, p1), minus(p2, from));
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const s = 1 - t;
            add(
              {
                x: s * s * from.x + 2 * s * t * p1.x + t * t * p2.x,
                y: s * s * from.y + 2 * s * t * p1.y + t * t * p2.y,
              },
              i < n,
              i === n ? end : null,
            );
          }
          break;
        }
        case "cubic": {
          const p1 = applyToPoint(m, segment.cp1.x, segment.cp1.y);
          const p2 = applyToPoint(m, segment.cp2.x, segment.cp2.y);
          const p3 = applyToPoint(m, segment.to.x, segment.to.y);
          const dd = Math.max(
            Math.hypot(from.x - 2 * p1.x + p2.x, from.y - 2 * p1.y + p2.y),
            Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y),
          );
          const n = clampPieces(Math.sqrt((0.75 * dd) / tolerance));
          leaving(firstDirection(minus(p1, from), minus(p2, from), minus(p3, from)));
          const end = firstDirection(minus(p3, p2), minus(p3, p1), minus(p3, from));
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const s = 1 - t;
            const a = s * s * s;
            const b = 3 * s * s * t;
            const c = 3 * s * t * t;
            const d = t * t * t;
            add(
              { x: a * from.x + b * p1.x + c * p2.x + d * p3.x, y: a * from.y + b * p1.y + c * p2.y + d * p3.y },
              i < n,
              i === n ? end : null,
            );
          }
          break;
        }
        case "arc":
        case "ellipse": {
          const { c, u, v } = ellipseFrame(segment, m);
          const sweep = arcSweep(segment);
          const radius = Math.max(Math.hypot(u.x, u.y), Math.hypot(v.x, v.y));
          // A chord spanning angle s deviates from a circle of radius r by r (1 - cos(s / 2)).
          const step = radius > tolerance ? 2 * Math.acos(1 - tolerance / radius) : Math.PI;
          const n = sweep === 0 ? 1 : clampPieces(Math.abs(sweep) / step);
          // The derivative of c + u cos t + v sin t, in the drawing direction.
          const tangent = (t: number): Point | null => {
            const k = sweep < 0 ? -1 : 1;
            return direction(k * (-u.x * Math.sin(t) + v.x * Math.cos(t)), k * (-u.y * Math.sin(t) + v.y * Math.cos(t)));
          };
          if (sweep !== 0) leaving(tangent(segment.startAngle));
          for (let i = 1; i <= n; i++) {
            const t = segment.startAngle + (sweep * i) / n;
            add(
              { x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) },
              i < n,
              i === n && sweep !== 0 ? tangent(t) : null,
            );
          }
          break;
        }
      }
    }
    result.push({ points, smooth, tangentIn, tangentOut, closed: subpath.closed });
  }
  return result;
};

/** A path's outline as closed rings in world space, each within `tolerance` of the true curve. */
export const pathRings = (path: PathGeometry, tolerance = 0.1): Point[][] =>
  flattenPath(path, IDENTITY, tolerance).map((line) => [...line.points]);
