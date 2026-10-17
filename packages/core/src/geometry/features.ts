import { applyToPoint } from "../math";
import type { Op, PathGeometry, Point } from "../types";
import { type Box, isEmptyBox } from "./bounds";
import { arcSweep, ellipseFrame } from "./flatten";
import { type Shape, imageRing } from "./shape";

/**
 * What an anchor marks: a path's vertices (subpath starts and segment ends),
 * segment midpoints, arc and ellipse centers, curve extremes (where a curve's
 * tangent is horizontal or vertical), text baseline ends, and the corners,
 * edge midpoints and center of a bounding box.
 */
export type AnchorKind = "vertex" | "midpoint" | "center" | "extreme" | "baseline" | "bounds";

export interface Anchor {
  readonly point: Point;
  readonly kind: AnchorKind;
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Roots in (0, 1) of a t² + b t + c. */
const unitRoots = (a: number, b: number, c: number): number[] => {
  const inside = (t: number) => t > 1e-9 && t < 1 - 1e-9;
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter(inside);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)].filter(inside);
};

const cubicAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

/** Anchors of a path in world space, from its segments as recorded (curves exact, not flattened). */
export const pathAnchors = (path: PathGeometry, closeAll = false): Anchor[] => {
  const out: Anchor[] = [];
  const add = (point: Point, kind: AnchorKind): void => {
    out.push({ point, kind });
  };
  for (const subpath of path.subpaths) {
    const start = applyToPoint(path.matrices[subpath.m]!, subpath.start.x, subpath.start.y);
    let current = start;
    if (!subpath.startImplied) add(start, "vertex");
    for (const s of subpath.segments) {
      const m = path.matrices[s.m]!;
      switch (s.kind) {
        case "line": {
          const to = applyToPoint(m, s.to.x, s.to.y);
          if (to.x !== current.x || to.y !== current.y) add(lerp(current, to, 0.5), "midpoint");
          add(to, "vertex");
          current = to;
          break;
        }
        case "quad": {
          // Affine maps keep Béziers Béziers, so work on the world-space control points.
          const p1 = applyToPoint(m, s.cp.x, s.cp.y);
          const p2 = applyToPoint(m, s.to.x, s.to.y);
          const at = (t: number) => lerp(lerp(current, p1, t), lerp(p1, p2, t), t);
          add(at(0.5), "midpoint");
          for (const axis of ["x", "y"] as const) {
            const d = current[axis] - 2 * p1[axis] + p2[axis];
            if (Math.abs(d) > 1e-12) {
              const t = (current[axis] - p1[axis]) / d;
              if (t > 1e-9 && t < 1 - 1e-9) add(at(t), "extreme");
            }
          }
          add(p2, "vertex");
          current = p2;
          break;
        }
        case "cubic": {
          const p0 = current;
          const p1 = applyToPoint(m, s.cp1.x, s.cp1.y);
          const p2 = applyToPoint(m, s.cp2.x, s.cp2.y);
          const p3 = applyToPoint(m, s.to.x, s.to.y);
          add(cubicAt(p0, p1, p2, p3, 0.5), "midpoint");
          for (const axis of ["x", "y"] as const) {
            // The derivative over 3: a t² + b t + c.
            const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
            const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
            const c = p1[axis] - p0[axis];
            for (const t of unitRoots(a, b, c)) add(cubicAt(p0, p1, p2, p3, t), "extreme");
          }
          add(p3, "vertex");
          current = p3;
          break;
        }
        case "arc":
        case "ellipse": {
          const { c, u, v } = ellipseFrame(s, m);
          const sweep = arcSweep(s);
          const at = (t: number): Point => ({ x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) });
          add(c, "center");
          const full = Math.abs(sweep) >= 2 * Math.PI - 1e-9;
          if (!full) add(at(s.startAngle + sweep / 2), "midpoint");
          // x' = -u.x sin t + v.x cos t is zero at t = atan2(v.x, u.x) + kπ; likewise for y.
          for (const base of [Math.atan2(v.x, u.x), Math.atan2(v.y, u.y)]) {
            for (let k = -4; k <= 4; k++) {
              const t = base + k * Math.PI;
              const rel = sweep >= 0 ? t - s.startAngle : s.startAngle - t;
              if (rel > 1e-9 && rel < Math.abs(sweep) - 1e-9) add(at(t), "extreme");
            }
          }
          const end = at(s.startAngle + sweep);
          add(end, "vertex");
          current = end;
          break;
        }
      }
    }
    // The closing edge, drawn by closePath (or by a fill closing every subpath).
    if ((subpath.closed || closeAll) && subpath.segments.length > 0 && (current.x !== start.x || current.y !== start.y)) {
      add(lerp(current, start, 0.5), "midpoint");
    }
  }
  return out;
};

/** A box's corners, edge midpoints and center. */
export const boxAnchors = (b: Box): Anchor[] => {
  if (isEmptyBox(b)) return [];
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
    [cx, b.minY],
    [b.maxX, cy],
    [cx, b.maxY],
    [b.minX, cy],
    [cx, cy],
  ].map(([x, y]) => ({ point: { x: x!, y: y! }, kind: "bounds" as const }));
};

/** Every anchor of an op, in world space. Duplicates (such as a closed subpath's start and end) are merged. */
export const opAnchors = (op: Op, shape: Shape): Anchor[] => {
  let anchors: Anchor[];
  switch (op.kind) {
    case "fill":
    case "stroke":
      anchors = [...pathAnchors(op.path, op.kind === "fill"), ...boxAnchors(shape.geometryBox)];
      break;
    case "image":
    case "embed":
    case "clear": {
      // An outlined image still snaps by its box; its silhouette is snapped to as an outline.
      const ring = op.kind === "image" && shape.silhouette ? imageRing(op) : shape.rings[0];
      if (!ring) return [];
      anchors = ring.flatMap((p, i) => [
        { point: p, kind: "vertex" as const },
        { point: lerp(p, ring[(i + 1) % ring.length]!, 0.5), kind: "midpoint" as const },
      ]);
      anchors.push({ point: lerp(ring[0]!, ring[2]!, 0.5), kind: "center" });
      break;
    }
    case "text": {
      const ring = shape.rings[0];
      if (!ring) return [];
      const m = op.metrics;
      const squeeze = op.maxWidth !== undefined && m.width > op.maxWidth ? op.maxWidth / m.width : 1;
      anchors = [
        ...ring.map((p) => ({ point: p, kind: "vertex" as const })),
        { point: applyToPoint(op.transform, op.x - m.actualBoundingBoxLeft * squeeze, op.y), kind: "baseline" },
        { point: applyToPoint(op.transform, op.x + m.actualBoundingBoxRight * squeeze, op.y), kind: "baseline" },
        { point: lerp(ring[0]!, ring[2]!, 0.5), kind: "center" },
      ];
      break;
    }
  }
  const seen = new Set<string>();
  return anchors.filter((a) => {
    const key = `${a.kind}:${a.point.x.toFixed(9)}:${a.point.y.toFixed(9)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** One straight piece of an op's outline, in world space. */
export interface Edge {
  readonly a: Point;
  readonly b: Point;
}

/**
 * The outline whose crossings count as intersections: a fill's or stroke's path
 * (its centerline, not the stroke's edges), and the box of text, images and clears.
 */
export const outlineEdges = (shape: Shape): Edge[] => {
  const edges: Edge[] = [];
  for (const line of shape.centerline) {
    const pts = line.points;
    const closed = line.closed || shape.op.kind !== "stroke";
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if (a.x !== b.x || a.y !== b.y) edges.push({ a, b });
    }
  }
  if (shape.centerline.length === 0 && shape.rings[0]) {
    const ring = shape.rings[0];
    for (let i = 0; i < ring.length; i++) edges.push({ a: ring[i]!, b: ring[(i + 1) % ring.length]! });
  }
  return edges;
};

/** Where segments ab and cd cross or touch; null when they are parallel or apart. */
export const segmentIntersection = (a: Point, b: Point, c: Point, d: Point): Point | null => {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const eps = 1e-12;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
};

const edgeBox = (e: Edge): Box => ({
  minX: Math.min(e.a.x, e.b.x),
  minY: Math.min(e.a.y, e.b.y),
  maxX: Math.max(e.a.x, e.b.x),
  maxY: Math.max(e.a.y, e.b.y),
});

/**
 * Crossing points of two edge lists, merged within `merge` of each other (a
 * crossing at a shared vertex is found once per edge it ends). The second list is
 * sorted by left end, so the scan for each edge stops at the first one past it.
 */
export const edgeIntersections = (first: readonly Edge[], second: readonly Edge[], merge: number): Point[] => {
  const left = first.map((e) => ({ e, box: edgeBox(e) }));
  const right = second.map((e) => ({ e, box: edgeBox(e) })).sort((p, q) => p.box.minX - q.box.minX);
  const points: Point[] = [];
  for (const l of left) {
    for (const r of right) {
      if (r.box.minX > l.box.maxX) break;
      if (r.box.maxX < l.box.minX || r.box.minY > l.box.maxY || r.box.maxY < l.box.minY) continue;
      const p = segmentIntersection(l.e.a, l.e.b, r.e.a, r.e.b);
      if (p && !points.some((q) => Math.abs(q.x - p.x) <= merge && Math.abs(q.y - p.y) <= merge)) points.push(p);
    }
  }
  return points;
};
