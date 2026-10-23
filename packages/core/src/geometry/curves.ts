import type { Point } from "../types";

/** A cubic Bézier piece. Consecutive pieces of a curve share end points. */
export interface CubicPiece {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

/** Anything with the path calls a curve needs: a `CanvasRenderingContext2D`, a `Path2D` or a recording context. */
export interface CurveTarget {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const length = (a: Point): number => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => {
  const l = length(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

const segmentDistance = (p: Point, a: Point, b: Point): number => {
  const d = sub(b, a);
  const len = dot(d, d);
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / len));
  return length(sub(p, add(a, scale(d, t))));
};

/** Drops repeated points, and the last point when it repeats the first of a closed line. */
export const dedupePoints = (points: readonly Point[], closed = false): Point[] => {
  const out = points.filter((p, i) => i === 0 || !same(p, points[i - 1]!));
  if (closed && out.length > 1 && same(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
};

/**
 * Removes points a polyline doesn't need (Douglas–Peucker): no point of the
 * input is farther than `tolerance` from the result, and points on a straight
 * stretch go. A closed line is cut at two extreme points, which any result keeps.
 */
export const simplifyPolyline = (points: readonly Point[], tolerance: number, closed = false): Point[] => {
  const pts = dedupePoints(points, closed);
  if (pts.length <= 2) return pts;
  const run = (line: readonly Point[]): Point[] => {
    const keep = new Uint8Array(line.length);
    keep[0] = 1;
    keep[line.length - 1] = 1;
    const stack: [number, number][] = [[0, line.length - 1]];
    while (stack.length > 0) {
      const [i, j] = stack.pop()!;
      let worst = -1;
      let far = 0;
      for (let k = i + 1; k < j; k++) {
        const d = segmentDistance(line[k]!, line[i]!, line[j]!);
        if (d > far) [far, worst] = [d, k];
      }
      if (worst >= 0 && far > tolerance) {
        keep[worst] = 1;
        stack.push([i, worst], [worst, j]);
      }
    }
    return line.filter((_, i) => keep[i] === 1);
  };
  if (!closed) return run(pts);
  const farthest = (from: Point): number => {
    let best = 0;
    pts.forEach((p, i) => {
      if (length(sub(p, from)) > length(sub(pts[best]!, from))) best = i;
    });
    return best;
  };
  const start = farthest(pts[0]!);
  const ring = [...pts.slice(start), ...pts.slice(0, start)];
  let split = 0;
  ring.forEach((p, i) => {
    if (length(sub(p, ring[0]!)) > length(sub(ring[split]!, ring[0]!))) split = i;
  });
  if (split === 0) return [ring[0]!];
  const a = run(ring.slice(0, split + 1));
  const b = run([...ring.slice(split), ring[0]!]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
};

/**
 * Shortcuts local hairpins whose neck is at most `size` wide and whose entire
 * excursion fits in a box of side `4 * size`. Long thin features are retained.
 * This intentionally removes detail, unlike a distance-bounded simplifier.
 * Open endpoints are fixed; closed rings retain their winding and at least half
 * their signed area. Use shared-border intersection checks before filling areas.
 */
export const simplifyDetours = (points: readonly Point[], size: number, closed = false): Point[] => {
  let pts = dedupePoints(points, closed);
  if (!Number.isFinite(size) || size <= 0 || pts.length < 4) return pts;
  const area = (line: readonly Point[]): number =>
    line.reduce((sum, p, i) => {
      const q = line[(i + 1) % line.length]!;
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
  const originalArea = closed ? area(pts) : 0;
  const run = (line: readonly Point[]): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < line.length; i++) {
      out.push(line[i]!);
      let end = i;
      let travel = 0;
      let x0 = line[i]!.x,
        x1 = x0,
        y0 = line[i]!.y,
        y1 = y0;
      for (let j = i + 1; j < line.length; j++) {
        const p = line[j]!;
        travel += length(sub(p, line[j - 1]!));
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
        if (x1 - x0 > size * 4 || y1 - y0 > size * 4 || travel > size * 12) break;
        const chord = length(sub(p, line[i]!));
        // A long thin feature also has a small loop at its tip. Do not shave
        // successive pieces off it: incoming/outgoing tangents at a legitimate
        // local detour continue in the same direction, not back along its neck.
        const before = i > 0 ? line[i - 1] : closed ? line.at(-1) : undefined;
        const after = j + 1 < line.length ? line[j + 1] : closed ? line[0] : undefined;
        const continues = !before || !after || dot(unit(sub(line[i]!, before)), unit(sub(after, p))) >= 0.25;
        if (continues && chord <= size && chord > 0 && travel > chord * 3 + size && Math.max(x1 - x0, y1 - y0) > size && (!closed || out.length + line.length - j >= 4)) end = j;
      }
      if (end > i) i = end - 1;
    }
    return out;
  };
  for (let pass = 0; pass < (closed ? 2 : 1); pass++) {
    const next = run(pts);
    const nextArea = closed ? area(next) : 0;
    if (!closed || (next.length >= 4 && nextArea * originalArea > 0 && Math.abs(nextArea) >= Math.abs(originalArea) * 0.5)) pts = next;
    // Expose detours straddling the arbitrary seam of a closed ring.
    if (closed && pass === 0) {
      const mid = Math.floor(pts.length / 2);
      pts = [...pts.slice(mid), ...pts.slice(0, mid)];
    }
  }
  return pts;
};

/**
 * A smooth curve through every point: centripetal Catmull–Rom, as cubic
 * pieces. It doesn't overshoot into loops or cusps on uneven spacing, and with
 * `closed` it joins the last point back to the first smoothly.
 */
export const smoothPolyline = (points: readonly Point[], closed = false): CubicPiece[] => {
  const pts = dedupePoints(points, closed);
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number): Point =>
    closed ? pts[((i % n) + n) % n]! : i < 0 ? sub(scale(pts[0]!, 2), pts[1]!) : i >= n ? sub(scale(pts[n - 1]!, 2), pts[n - 2]!) : pts[i]!;
  const pieces: CubicPiece[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    // Centripetal knots: spacing by the square root of distance.
    const d1 = Math.sqrt(length(sub(p1, p0))) || 1e-9;
    const d2 = Math.sqrt(length(sub(p2, p1))) || 1e-9;
    const d3 = Math.sqrt(length(sub(p3, p2))) || 1e-9;
    // Tangents at p1 and p2 for the knot spacing, scaled to the piece (Barry–Goldman, as Bézier handles).
    const m1 = scale(add(sub(scale(sub(p1, p0), 1 / d1), scale(sub(p2, p0), 1 / (d1 + d2))), scale(sub(p2, p1), 1 / d2)), d2);
    const m2 = scale(add(sub(scale(sub(p2, p1), 1 / d2), scale(sub(p3, p1), 1 / (d2 + d3))), scale(sub(p3, p2), 1 / d3)), d2);
    pieces.push({ from: p1, c1: add(p1, scale(m1, 1 / 3)), c2: sub(p2, scale(m2, 1 / 3)), to: p2 });
  }
  return pieces;
};

// --- Fitting (after Philip J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, 1990) ---

const bezierAt = (b: readonly Point[], t: number): Point => {
  const s = 1 - t;
  return {
    x: s * s * s * b[0]!.x + 3 * s * s * t * b[1]!.x + 3 * s * t * t * b[2]!.x + t * t * t * b[3]!.x,
    y: s * s * s * b[0]!.y + 3 * s * s * t * b[1]!.y + 3 * s * t * t * b[2]!.y + t * t * t * b[3]!.y,
  };
};

/** One Newton step improving the parameter of `p` on the curve. */
const newton = (b: readonly Point[], p: Point, t: number): number => {
  const d1 = [0, 1, 2].map((i) => scale(sub(b[i + 1]!, b[i]!), 3));
  const d2 = [0, 1].map((i) => scale(sub(d1[i + 1]!, d1[i]!), 2));
  const q = sub(bezierAt(b, t), p);
  const s = 1 - t;
  const q1 = add(add(scale(d1[0]!, s * s), scale(d1[1]!, 2 * s * t)), scale(d1[2]!, t * t));
  const q2 = add(scale(d2[0]!, s), scale(d2[1]!, t));
  const denominator = dot(q1, q1) + dot(q, q2);
  return denominator === 0 ? t : Math.max(0, Math.min(1, t - dot(q, q1) / denominator));
};

/** The control points that best fit `pts` at parameters `u`, with the end tangents given (least squares on the handle lengths). */
const generate = (pts: readonly Point[], u: readonly number[], t1: Point, t2: Point): Point[] => {
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  u.forEach((t, i) => {
    const s = 1 - t;
    const a1 = scale(t1, 3 * s * s * t);
    const a2 = scale(t2, 3 * s * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i]!, add(scale(first, s * s * s + 3 * s * s * t), scale(last, 3 * s * t * t + t * t * t)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  });
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det === 0 ? 0 : (x0 * c11 - c01 * x1) / det;
  let alpha2 = det === 0 ? 0 : (c00 * x1 - x0 * c01) / det;
  const span = length(sub(last, first));
  // Degenerate or backwards handles: fall back to a third of the chord.
  if (alpha1 < span * 1e-6 || alpha2 < span * 1e-6) alpha1 = alpha2 = span / 3;
  return [first, add(first, scale(t1, alpha1)), add(last, scale(t2, alpha2)), last];
};

const chordParameters = (pts: readonly Point[]): number[] => {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1]! + length(sub(pts[i]!, pts[i - 1]!)));
  const total = u[u.length - 1]! || 1;
  return u.map((d) => d / total);
};

const maxError = (pts: readonly Point[], b: readonly Point[], u: readonly number[]): { error: number; index: number } => {
  let error = 0;
  let index = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = length(sub(bezierAt(b, u[i]!), pts[i]!));
    if (d > error) [error, index] = [d, i];
  }
  return { error, index };
};

const fitRun = (pts: readonly Point[], t1: Point, t2: Point, tolerance: number, out: CubicPiece[], depth: number): void => {
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length === 2) {
    const d = length(sub(last, first)) / 3;
    out.push({ from: first, c1: add(first, scale(t1, d)), c2: add(last, scale(t2, d)), to: last });
    return;
  }
  let u = chordParameters(pts);
  let b = generate(pts, u, t1, t2);
  let { error, index } = maxError(pts, b, u);
  for (let iteration = 0; error > tolerance && error < tolerance * 4 && iteration < 8; iteration++) {
    u = u.map((t, i) => newton(b, pts[i]!, t));
    b = generate(pts, u, t1, t2);
    ({ error, index } = maxError(pts, b, u));
  }
  if (error <= tolerance || depth > 24) {
    out.push({ from: first, c1: b[1]!, c2: b[2]!, to: last });
    return;
  }
  // Split where the fit is worst, with a shared tangent there so the two halves join smoothly.
  index = Math.max(1, Math.min(pts.length - 2, index));
  const center = unit(sub(pts[index - 1]!, pts[index + 1]!));
  fitRun(pts.slice(0, index + 1), t1, center, tolerance, out, depth + 1);
  fitRun(pts.slice(index), scale(center, -1), t2, tolerance, out, depth + 1);
};

export interface FitOptions {
  /** The line is a loop: the last point joins the first. */
  readonly closed?: boolean;
  /** Where the line turns more sharply than this, in degrees, the curve keeps a corner. Default 60. */
  readonly cornerAngle?: number;
  /**
   * How far along the line, each way, to look when measuring a turn. 0 (the
   * default) compares a point's own two segments. A few units sees through
   * jitter and pixel staircases: a staircase circle turns gently over that
   * distance, a box corner sharply, and only the sharpest point of a turn is kept.
   */
  readonly cornerWindow?: number;
}

/**
 * Fits as few cubic Bézier pieces as it can to a polyline, such as a freehand
 * stroke or a traced outline, with every input point within `tolerance` of the
 * curve. Corners sharper than `cornerAngle` stay corners; elsewhere pieces
 * join with matching tangents. Simplify noisy input first, so the corner test
 * sees the shape rather than the jitter.
 */
export const fitCurve = (points: readonly Point[], tolerance: number, options: FitOptions = {}): CubicPiece[] => {
  const closed = options.closed ?? false;
  const pts = dedupePoints(points, closed);
  const n = pts.length;
  if (n < 2) return [];
  const limit = Math.cos(((options.cornerAngle ?? 60) * Math.PI) / 180);
  const window = options.cornerWindow ?? 0;
  const index = (i: number): number => ((i % n) + n) % n;
  /** The point at least `window` along the line from i, stepping by `step`; null past an open end. */
  const reach = (i: number, step: 1 | -1): Point | null => {
    let travelled = 0;
    let j = i;
    for (let k = 0; k < n; k++) {
      const next = j + step;
      if (!closed && (next < 0 || next >= n)) return k === 0 ? null : pts[j]!;
      travelled += length(sub(pts[index(next)]!, pts[index(j)]!));
      j = next;
      if (travelled >= window) break;
    }
    return pts[index(j)]!;
  };
  // How sharply the line turns at each point: the cosine between the way in and the way out.
  const turn = pts.map((p, i) => {
    const before = reach(i, -1);
    const after = reach(i, 1);
    if (!before || !after) return 1;
    return dot(unit(sub(p, before)), unit(sub(after, p)));
  });
  const corners: number[] = [];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    if (turn[i]! >= limit) continue;
    // Keep the sharpest point of a turn: no point within the window turns more sharply.
    let sharpest = true;
    for (const step of [1, -1] as const) {
      let travelled = 0;
      for (let j = i, k = 0; k < n && sharpest; k++) {
        const next = j + step;
        if (!closed && (next < 0 || next >= n)) break;
        travelled += length(sub(pts[index(next)]!, pts[index(j)]!));
        j = next;
        if (travelled > window) break;
        const t = turn[index(j)]!;
        if (t < turn[i]! || (t === turn[i]! && step === -1)) sharpest = false;
      }
    }
    if (sharpest) corners.push(i);
  }
  const out: CubicPiece[] = [];
  const fitBetween = (run: Point[], t1: Point | null, t2: Point | null): void => {
    const start = t1 ?? unit(sub(run[1]!, run[0]!));
    const end = t2 ?? unit(sub(run[run.length - 2]!, run[run.length - 1]!));
    fitRun(run, start, end, tolerance, out, 0);
  };
  if (!closed) {
    const cuts = [0, ...corners, n - 1];
    for (let k = 0; k + 1 < cuts.length; k++) fitBetween(pts.slice(cuts[k]!, cuts[k + 1]! + 1), null, null);
    return out;
  }
  if (corners.length === 0) {
    // A smooth loop: start anywhere, with the tangent there shared by both ends.
    const t = unit(sub(pts[1]!, pts[n - 1]!));
    fitBetween([...pts, pts[0]!], t, scale(t, -1));
    return out;
  }
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]!;
    const b = corners[(k + 1) % corners.length]!;
    const run: Point[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      run.push(pts[i]!);
      if (i === b && run.length > 1) break;
    }
    fitBetween(run, null, null);
  }
  return out;
};

/** Whether a piece is a straight line: both handles on the chord, between its ends. */
export const isStraight = (p: CubicPiece, epsilon = 1e-9): boolean => {
  const span = length(sub(p.to, p.from));
  const off = (c: Point) => segmentDistance(c, p.from, p.to);
  return span > 0 && off(p.c1) <= epsilon * span && off(p.c2) <= epsilon * span;
};

/**
 * Adds curve pieces to a path: a move to the first piece's start, then a
 * `bezierCurveTo` per piece, or a `lineTo` for a straight one.
 */
export const traceCurve = (target: CurveTarget, pieces: readonly CubicPiece[], closed = false): void => {
  if (pieces.length === 0) return;
  target.moveTo(pieces[0]!.from.x, pieces[0]!.from.y);
  for (const p of pieces) {
    if (isStraight(p)) target.lineTo(p.to.x, p.to.y);
    else target.bezierCurveTo(p.c1.x, p.c1.y, p.c2.x, p.c2.y, p.to.x, p.to.y);
  }
  if (closed) target.closePath();
};

/** The point at parameter t on a piece, for checking or sampling a fit. */
export const pieceAt = (piece: CubicPiece, t: number): Point => bezierAt([piece.from, piece.c1, piece.c2, piece.to], t);
