import { applyToPoint } from "../math";
import type { LineCap, LineJoin, Matrix2D, Point, StrokeStyle } from "../types";
import type { Polyline } from "./flatten";

/**
 * A stroke's covered area as a union of convex polygons: one quad per polyline
 * segment, plus join and cap pieces. Built in the stroke's own space (where line
 * width and dashes are measured) and then mapped to world space, so it is exact
 * under non-uniform scale and skew up to the flattening tolerance.
 */
export type ConvexPolygon = readonly Point[];

interface Vertex {
  readonly p: Point;
  /** Inside a curve: joined with a bevel, not the line join style. */
  readonly smooth: boolean;
  /** Exact path direction arriving at / leaving the vertex, where a curve meets it. */
  readonly tin: Point | null;
  readonly tout: Point | null;
}

interface Run {
  readonly vertices: Vertex[];
  readonly closed: boolean;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const unit = (a: Point): Point | null => {
  const len = Math.hypot(a.x, a.y);
  return len > 1e-12 ? { x: a.x / len, y: a.y / len } : null;
};
/** Left-hand normal. */
const perp = (a: Point): Point => ({ x: -a.y, y: a.x });

const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;

/** Merges consecutive duplicate points so every segment has a direction. */
const dedupe = (run: Run): Run => {
  const vertices: Vertex[] = [];
  for (const v of run.vertices) {
    const last = vertices[vertices.length - 1];
    if (last && samePoint(last.p, v.p)) {
      // The merged vertex arrives like the first and leaves like the second; a real vertex wins over a smooth one.
      vertices[vertices.length - 1] = { p: last.p, smooth: last.smooth && v.smooth, tin: last.tin, tout: v.tout };
      continue;
    }
    vertices.push(v);
  }
  if (run.closed && vertices.length > 1 && samePoint(vertices[0]!.p, vertices[vertices.length - 1]!.p)) {
    const last = vertices.pop()!;
    vertices[0] = { ...vertices[0]!, tin: last.tin };
  }
  return { vertices, closed: run.closed };
};

/** Splits a run into its dashes, measured in stroke space as the spec does. */
const applyDash = (run: Run, dash: readonly number[], offset: number): Run[] => {
  const total = dash.reduce((s, d) => s + d, 0);
  if (total <= 0) return [run];
  const vertices = run.closed ? [...run.vertices, { ...run.vertices[0]!, smooth: false }] : run.vertices;

  let phase = ((offset % total) + total) % total;
  let index = 0;
  while (phase >= dash[index]!) {
    phase -= dash[index]!;
    index = (index + 1) % dash.length;
  }
  let remaining = dash[index]! - phase;
  let on = index % 2 === 0;
  const startsOn = on;

  const cutVertex = (p: Point): Vertex => ({ p, smooth: false, tin: null, tout: null });
  const runs: Run[] = [];
  let current: Vertex[] | null = on ? [{ ...vertices[0]!, tin: null }] : null;
  for (let i = 1; i < vertices.length; i++) {
    let a = vertices[i - 1]!.p;
    const b = vertices[i]!;
    let length = Math.hypot(b.p.x - a.x, b.p.y - a.y);
    while (length > remaining) {
      const t = remaining / length;
      const cut = { x: a.x + (b.p.x - a.x) * t, y: a.y + (b.p.y - a.y) * t };
      if (on) {
        current!.push(cutVertex(cut));
        runs.push({ vertices: current!, closed: false });
        current = null;
      } else {
        current = [cutVertex(cut)];
      }
      on = !on;
      length -= remaining;
      a = cut;
      index = (index + 1) % dash.length;
      remaining = dash[index]!;
    }
    remaining -= length;
    if (on) current!.push(b);
  }
  if (current) {
    // On a closed subpath, a dash running through the start point is one dash, joined there.
    if (run.closed && startsOn && runs.length > 0) {
      const first = runs.shift()!;
      runs.unshift({ vertices: [...current, ...first.vertices.slice(1)], closed: false });
    } else if (run.closed && startsOn) {
      return [run];
    } else {
      runs.push({ vertices: current, closed: false });
    }
  }
  return runs;
};

const circle = (center: Point, radius: number, tolerance: number): Point[] => {
  const step = radius > tolerance ? 2 * Math.acos(1 - tolerance / radius) : Math.PI / 2;
  const n = Math.min(256, Math.max(8, Math.ceil((2 * Math.PI) / step)));
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return { x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) };
  });
};

const joinPiece = (
  p: Point,
  dIn: Point,
  dOut: Point,
  hw: number,
  join: LineJoin,
  miterLimit: number,
  tolerance: number,
): ConvexPolygon | null => {
  const turn = cross(dIn, dOut);
  if (Math.abs(turn) < 1e-12 && dot(dIn, dOut) > 0) return null;
  // The outer side of the turn is the right side for a left turn, and vice versa.
  const side = turn > 0 ? -1 : 1;
  const o0 = scale(perp(dIn), side * hw);
  const o1 = scale(perp(dOut), side * hw);
  if (join === "round") return circle(p, hw, tolerance);
  if (join === "miter") {
    const cosHalf = Math.sqrt(Math.max(0, (1 + dot(dIn, dOut)) / 2));
    // Miter length over line width is 1 / sin(interior / 2), which is 1 / cos(turn / 2).
    if (cosHalf > 1e-12 && 1 / cosHalf <= miterLimit) {
      const bisector = unit(add(o0, o1));
      if (bisector) return [p, add(p, o0), add(p, scale(bisector, hw / cosHalf)), add(p, o1)];
    }
  }
  return [p, add(p, o0), add(p, o1)];
};

const capPiece = (p: Point, d: Point, hw: number, cap: LineCap, tolerance: number): ConvexPolygon | null => {
  if (cap === "butt") return null;
  if (cap === "round") return circle(p, hw, tolerance);
  const n = scale(perp(d), hw);
  const back = scale(d, hw);
  return [add(p, n), sub(add(p, n), back), sub(sub(p, n), back), sub(p, n)];
};

/**
 * Builds the stroke's convex pieces in world space. `lines` are in stroke space;
 * `toWorld` maps stroke space to world space and `tolerance` is in stroke space.
 */
export const strokePieces = (
  lines: readonly Polyline[],
  style: StrokeStyle,
  toWorld: Matrix2D,
  tolerance: number,
): ConvexPolygon[] => {
  const hw = style.lineWidth / 2;
  const pieces: ConvexPolygon[] = [];
  const emit = (polygon: ConvexPolygon | null): void => {
    if (polygon) pieces.push(polygon.map((p) => applyToPoint(toWorld, p.x, p.y)));
  };

  for (const line of lines) {
    const base = dedupe({
      vertices: line.points.map((p, i) => ({
        p,
        smooth: line.smooth[i]!,
        tin: line.tangentIn[i]!,
        tout: line.tangentOut[i]!,
      })),
      closed: line.closed,
    });
    if (base.vertices.length === 1) {
      // A zero-length subpath still gets round or square caps.
      const p = base.vertices[0]!.p;
      if (style.lineCap === "round") emit(circle(p, hw, tolerance));
      if (style.lineCap === "square") {
        emit([
          { x: p.x - hw, y: p.y - hw },
          { x: p.x + hw, y: p.y - hw },
          { x: p.x + hw, y: p.y + hw },
          { x: p.x - hw, y: p.y + hw },
        ]);
      }
      continue;
    }
    const runs = style.lineDash.length > 0 ? applyDash(base, style.lineDash, style.lineDashOffset).map(dedupe) : [base];
    for (const { vertices, closed } of runs) {
      if (vertices.length < 2) continue;
      const count = closed ? vertices.length : vertices.length - 1;
      const dirs: Point[] = [];
      for (let i = 0; i < count; i++) {
        const a = vertices[i]!.p;
        const b = vertices[(i + 1) % vertices.length]!.p;
        const d = unit(sub(b, a))!;
        dirs.push(d);
        const n = scale(perp(d), hw);
        emit([add(a, n), add(b, n), sub(b, n), sub(a, n)]);
      }
      // Joins between consecutive segments; inside a curve, a bevel fills the sliver.
      const joinAt = (i: number, chordIn: Point, chordOut: Point): void => {
        const v = vertices[i]!;
        const join = v.smooth ? "bevel" : style.lineJoin;
        emit(joinPiece(v.p, v.tin ?? chordIn, v.tout ?? chordOut, hw, join, style.miterLimit, tolerance));
        fillTangentWedges(v, chordIn, chordOut);
      };
      // Where an exact curve tangent differs from the chord, the chord's quad leaves a sliver on the outside.
      const fillTangentWedges = (v: Vertex, chordIn: Point | null, chordOut: Point | null): void => {
        if (v.tin && chordIn) emit(joinPiece(v.p, chordIn, v.tin, hw, "bevel", style.miterLimit, tolerance));
        if (v.tout && chordOut) emit(joinPiece(v.p, v.tout, chordOut, hw, "bevel", style.miterLimit, tolerance));
      };
      for (let i = 1; i < count; i++) joinAt(i, dirs[i - 1]!, dirs[i]!);
      if (closed) {
        joinAt(0, dirs[count - 1]!, dirs[0]!);
      } else {
        const first = vertices[0]!;
        const last = vertices[vertices.length - 1]!;
        emit(capPiece(first.p, first.tout ?? dirs[0]!, hw, style.lineCap, tolerance));
        emit(capPiece(last.p, scale(last.tin ?? dirs[count - 1]!, -1), hw, style.lineCap, tolerance));
        fillTangentWedges(first, null, dirs[0]!);
        fillTangentWedges(last, dirs[count - 1]!, null);
      }
    }
  }
  return pieces;
};
