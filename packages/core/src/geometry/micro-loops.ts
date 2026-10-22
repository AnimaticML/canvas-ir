import type { Point } from "../types";
import type { CubicPiece } from "./curves";

const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const controls = (p: CubicPiece): Point[] => [p.from, p.c1, p.c2, p.to];
const at = (p: CubicPiece, t: number): Point => {
  const u = 1 - t;
  return { x: u ** 3 * p.from.x + 3 * u * u * t * p.c1.x + 3 * u * t * t * p.c2.x + t ** 3 * p.to.x,
    y: u ** 3 * p.from.y + 3 * u * u * t * p.c1.y + 3 * u * t * t * p.c2.y + t ** 3 * p.to.y };
};
const derivative = (p: CubicPiece, t: number): Point => {
  const u = 1 - t;
  return { x: 3 * (u * u * (p.c1.x - p.from.x) + 2 * u * t * (p.c2.x - p.c1.x) + t * t * (p.to.x - p.c2.x)),
    y: 3 * (u * u * (p.c1.y - p.from.y) + 2 * u * t * (p.c2.y - p.c1.y) + t * t * (p.to.y - p.c2.y)) };
};
const split = (p: CubicPiece, t: number): [CubicPiece, CubicPiece] => {
  const a = mix(p.from, p.c1, t), b = mix(p.c1, p.c2, t), c = mix(p.c2, p.to, t);
  const d = mix(a, b, t), e = mix(b, c, t), join = mix(d, e, t);
  return [{ from: p.from, c1: a, c2: d, to: join }, { from: join, c1: e, c2: c, to: p.to }];
};
const portion = (p: CubicPiece, from: number, to: number): CubicPiece => split(split(p, to)[0], from / to)[1];
type Crossing = { t: number; u: number };
const curveExtent = (p: CubicPiece): Point[] => {
  const result = [p.from, p.to];
  for (const axis of ["x", "y"] as const) {
    const a = 3 * (-p.from[axis] + 3 * p.c1[axis] - 3 * p.c2[axis] + p.to[axis]);
    const b = 6 * (p.from[axis] - 2 * p.c1[axis] + p.c2[axis]);
    const c = 3 * (p.c1[axis] - p.from[axis]);
    const discriminant = b * b - 4 * a * c;
    const roots = Math.abs(a) < 1e-12 ? Math.abs(b) < 1e-12 ? [] : [-c / b] : discriminant < 0 ? [] : [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)];
    for (const t of roots) if (t > 0 && t < 1) result.push(at(p, t));
  }
  return result;
};
const span = (points: readonly Point[]): number => Math.max(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)));


/** Solve B(t) = B(u) analytically, excluding the legitimate ends of a closed cubic. */
const selfCrossing = (p: CubicPiece): Crossing[] => {
  const a = { x: -p.from.x + 3 * p.c1.x - 3 * p.c2.x + p.to.x, y: -p.from.y + 3 * p.c1.y - 3 * p.c2.y + p.to.y };
  const b = { x: 3 * p.from.x - 6 * p.c1.x + 3 * p.c2.x, y: 3 * p.from.y - 6 * p.c1.y + 3 * p.c2.y };
  const c = { x: 3 * (p.c1.x - p.from.x), y: 3 * (p.c1.y - p.from.y) };
  const den = cross(a, b);
  if (Math.abs(den) < 1e-12) return [];
  const sum = -cross(a, c) / den;
  const product = sum * sum + (a.x * (b.x * sum + c.x) + a.y * (b.y * sum + c.y)) / (a.x * a.x + a.y * a.y);
  const discriminant = sum * sum - 4 * product;
  if (discriminant <= 1e-12) return [];
  const t = (sum - Math.sqrt(discriminant)) / 2, u = (sum + Math.sqrt(discriminant)) / 2;
  return t > 1e-6 && u < 1 - 1e-6 && u - t > 1e-5 ? [{ t, u }] : [];
};

const samples = (p: CubicPiece): { t: number; point: Point }[] => {
  const dd = Math.max(Math.hypot(p.from.x - 2 * p.c1.x + p.c2.x, p.from.y - 2 * p.c1.y + p.c2.y),
    Math.hypot(p.c1.x - 2 * p.c2.x + p.to.x, p.c1.y - 2 * p.c2.y + p.to.y));
  const n = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(0.75 * dd / 0.01))));
  return Array.from({ length: n + 1 }, (_, i) => ({ t: i / n, point: at(p, i / n) }));
};
const crossings = (a: CubicPiece, b: CubicPiece): Crossing[] => {
  const pa = controls(a), pb = controls(b);
  if (Math.max(...pa.map(p => p.x)) < Math.min(...pb.map(p => p.x)) || Math.max(...pb.map(p => p.x)) < Math.min(...pa.map(p => p.x)) ||
      Math.max(...pa.map(p => p.y)) < Math.min(...pb.map(p => p.y)) || Math.max(...pb.map(p => p.y)) < Math.min(...pa.map(p => p.y))) return [];
  const aa = samples(a), bb = samples(b), result: Crossing[] = [];
  for (let i = 0; i + 1 < aa.length; i++) for (let j = 0; j + 1 < bb.length; j++) {
    const first = aa[i]!, second = bb[j]!, v = sub(aa[i + 1]!.point, first.point), w = sub(bb[j + 1]!.point, second.point);
    const den = cross(v, w);
    if (Math.abs(den) < 1e-12) continue;
    const delta = sub(second.point, first.point), x = cross(delta, w) / den, y = cross(delta, v) / den;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    let t = first.t + x * (aa[i + 1]!.t - first.t), u = second.t + y * (bb[j + 1]!.t - second.t);
    for (let round = 0; round < 12; round++) {
      const f = sub(at(a, t), at(b, u)), da = derivative(a, t), db = derivative(b, u), determinant = cross(da, db);
      if (Math.abs(determinant) < 1e-12) break;
      const dt = -cross(f, db) / determinant, du = cross(da, f) / determinant;
      t += dt; u += du;
      if (Math.abs(dt) + Math.abs(du) < 1e-12) break;
    }
    if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 && Math.hypot(at(a, t).x - at(b, u).x, at(a, t).y - at(b, u).y) < 1e-7)
      result.push({ t, u });
  }
  return result;
};

const signedArea = (pieces: readonly CubicPiece[]): number => pieces.reduce((area, p) => {
  const coefficients = (axis: "x" | "y") => [p.from[axis], 3 * (p.c1[axis] - p.from[axis]), 3 * (p.from[axis] - 2 * p.c1[axis] + p.c2[axis]), -p.from[axis] + 3 * p.c1[axis] - 3 * p.c2[axis] + p.to[axis]];
  const x = coefficients("x"), y = coefficients("y");
  for (let i = 0; i < 4; i++) for (let j = 1; j < 4; j++) area += (x[i]! * j * y[j]! - y[i]! * j * x[j]!) / (i + j) / 2;
  return area;
}, 0);

/**
 * Remove only bounded self-intersection loops in one cubic or across up to four
 * neighboring pieces. Unaffected curves and open endpoints stay exact. Intended
 * for shared outlines: run intersection/junction guards after this operation.
 */
export const removeMicroLoops = (input: readonly CubicPiece[], size: number, closed = false): CubicPiece[] => {
  let pieces = [...input];
  if (!Number.isFinite(size) || size <= 0) return pieces;
  const originalArea = closed ? signedArea(input) : 0;
  let rotated = false;
  for (let repair = 0; repair < 24; repair++) {
    let changed = false;
    search: for (let i = 0; i < pieces.length; i++) for (let j = i; j < Math.min(pieces.length, i + 4); j++) {
      for (const { t, u } of i === j ? selfCrossing(pieces[i]!) : crossings(pieces[i]!, pieces[j]!)) {
        const loop = i === j ? [portion(pieces[i]!, t, u)] : [split(pieces[i]!, t)[1], ...pieces.slice(i + 1, j), split(pieces[j]!, u)[0]];
        const points = loop.flatMap(controls);
        const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
        const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
        if (Math.max(width, height) > size || Math.max(width, height) < 1e-6) continue;
        // Preserve both end tangents, including at shared junctions. A straight
        // shortcut changes their turning order and can force neighboring waves
        // through the topology guard's coarse fallback.
        const window = pieces.slice(i, j + 1);
        let replacement: CubicPiece[];
        if (span(window.flatMap(curveExtent)) <= size && Math.hypot(pieces[i]!.from.x - pieces[j]!.to.x, pieces[i]!.from.y - pieces[j]!.to.y) > 1e-8) {
          const first = pieces[i]!, last = pieces[j]!, from = first.from, to = last.to;
          const chord = Math.hypot(to.x - from.x, to.y - from.y);
          const direction = (a: Point, b: Point, fallback: Point): Point => {
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            return length > 1e-10 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : fallback;
          };
          const fallback = { x: (to.x - from.x) / chord, y: (to.y - from.y) / chord };
          const incoming = direction(from, first.c1, direction(from, first.c2, fallback));
          const outgoing = direction(last.c2, to, direction(last.c1, to, fallback));
          const handle = chord / 4;
          const connector = { from, c1: { x: from.x + incoming.x * handle, y: from.y + incoming.y * handle },
            c2: { x: to.x - outgoing.x * handle, y: to.y - outgoing.y * handle }, to };
          if (selfCrossing(connector).length) continue;
          replacement = [...pieces.slice(0, i), connector, ...pieces.slice(j + 1)];
        } else {
          const prefix = split(pieces[i]!, t)[0], suffix = split(pieces[j]!, u)[1];
          const join = mix(prefix.to, suffix.from, 0.5);
          replacement = [...pieces.slice(0, i), { ...prefix, to: join }, { ...suffix, from: join }, ...pieces.slice(j + 1)];
        }
        if (closed) {
          const area = signedArea(replacement);
          if (area * originalArea <= 0 || Math.abs(area) < Math.abs(originalArea) * 0.5) continue;
        }
        pieces = replacement;
        changed = true;
        break search;
      }
    }
    if (changed) continue;
    if (closed && !rotated && pieces.length > 1) {
      const half = Math.floor(pieces.length / 2);
      pieces = [...pieces.slice(half), ...pieces.slice(0, half)];
      rotated = true;
    } else break;
  }
  if (closed && input.length) {
    const start = pieces.indexOf(input[0]!);
    if (start > 0) pieces = [...pieces.slice(start), ...pieces.slice(0, start)];
  }
  return pieces;
};
