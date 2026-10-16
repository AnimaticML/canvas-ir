import { IDENTITY, applyToPoint, invert } from "../math";
import type { Op, Point } from "../types";
import { type Box, EMPTY_BOX, boxOfPoints, isEmptyBox, pathBounds, unionBox } from "./bounds";
import { type Polyline, flattenPath, maxScale } from "./flatten";
import {
  boxCorners,
  distanceToRing,
  inConvex,
  insideFill,
  ringTouchesBox,
  segmentClosest,
} from "./predicates";
import { type ConvexPolygon, strokePieces } from "./stroke";

/**
 * Everything the queries need about one op, derived once and cached: world-space
 * outlines for its painted area, exact geometry bounds and paint bounds.
 */
export interface Shape {
  readonly op: Op;
  /** Bounds of the path itself, with curve extrema exact. Empty for an op that paints nothing. */
  readonly geometryBox: Box;
  /** Bounds of everything the op paints or clears. */
  readonly paintBox: Box;
  /** Fill and clear: the closed rings of the painted area, in world space. */
  readonly rings: readonly (readonly Point[])[];
  /** Stroke: convex pieces whose union is the stroked area, with their boxes. */
  readonly pieces: readonly ConvexPolygon[];
  readonly pieceBoxes: readonly Box[];
  /** The path's centerline in world space, for closest-point queries. */
  readonly centerline: readonly Polyline[];
}

const emptyShape = (op: Op): Shape => ({
  op,
  geometryBox: EMPTY_BOX,
  paintBox: EMPTY_BOX,
  rings: [],
  pieces: [],
  pieceBoxes: [],
  centerline: [],
});

/** Builds an op's shape; `tolerance` bounds the flattening error in world units. */
export const buildShape = (op: Op, tolerance: number): Shape => {
  // Canvas paints nothing while the current transform is not invertible.
  const inverse = invert(op.transform);
  if (inverse === null) return emptyShape(op);

  switch (op.kind) {
    case "clear": {
      const { x, y, width, height } = op.rect;
      if (width === 0 || height === 0) return emptyShape(op);
      const ring = [
        applyToPoint(op.transform, x, y),
        applyToPoint(op.transform, x + width, y),
        applyToPoint(op.transform, x + width, y + height),
        applyToPoint(op.transform, x, y + height),
      ];
      const box = boxOfPoints(ring);
      return { ...emptyShape(op), geometryBox: box, paintBox: box, rings: [ring] };
    }
    case "fill": {
      const centerline = flattenPath(op.path, IDENTITY, tolerance);
      const geometryBox = pathBounds(op.path, IDENTITY);
      return { ...emptyShape(op), geometryBox, paintBox: geometryBox, rings: centerline.map((l) => l.points), centerline };
    }
    case "stroke": {
      const strokeTolerance = tolerance / maxScale(op.transform);
      const local = flattenPath(op.path, inverse, strokeTolerance);
      const pieces = strokePieces(local, op.stroke, op.transform, strokeTolerance);
      const pieceBoxes = pieces.map(boxOfPoints);
      const paintBox = pieceBoxes.reduce(unionBox, EMPTY_BOX);
      return {
        op,
        geometryBox: pathBounds(op.path, IDENTITY),
        paintBox,
        rings: [],
        pieces,
        pieceBoxes,
        centerline: flattenPath(op.path, IDENTITY, tolerance),
      };
    }
  }
};

/** Whether `p` is in the painted area, or within `tolerance` of it. */
export const shapeContains = (shape: Shape, p: Point, tolerance: number): boolean => {
  if (isEmptyBox(shape.paintBox)) return false;
  const { paintBox: b } = shape;
  if (p.x < b.minX - tolerance || p.x > b.maxX + tolerance || p.y < b.minY - tolerance || p.y > b.maxY + tolerance) {
    return false;
  }
  switch (shape.op.kind) {
    case "clear":
      return inConvex(p, shape.rings[0]!) || (tolerance > 0 && distanceToRing(p, shape.rings[0]!) <= tolerance);
    case "fill":
      if (insideFill(p, shape.rings, shape.op.fillRule)) return true;
      return tolerance > 0 && shape.rings.some((ring) => distanceToRing(p, ring) <= tolerance);
    case "stroke":
      for (let i = 0; i < shape.pieces.length; i++) {
        const box = shape.pieceBoxes[i]!;
        if (p.x < box.minX - tolerance || p.x > box.maxX + tolerance || p.y < box.minY - tolerance || p.y > box.maxY + tolerance) {
          continue;
        }
        const piece = shape.pieces[i]!;
        if (inConvex(p, piece) || (tolerance > 0 && distanceToRing(p, piece) <= tolerance)) return true;
      }
      return false;
  }
};

/** Whether the painted area touches the box. */
export const shapeIntersectsBox = (shape: Shape, box: Box): boolean => {
  const { paintBox: b } = shape;
  if (isEmptyBox(b) || b.minX > box.maxX || b.maxX < box.minX || b.minY > box.maxY || b.maxY < box.minY) return false;
  // Painted area wholly inside the box.
  if (b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY) return true;
  if (shape.op.kind === "stroke") {
    return shape.pieces.some((piece, i) => {
      const pb = shape.pieceBoxes[i]!;
      if (pb.minX > box.maxX || pb.maxX < box.minX || pb.minY > box.maxY || pb.maxY < box.minY) return false;
      return ringTouchesBox(piece, box) || inConvex(boxCorners(box)[0]!, piece);
    });
  }
  if (shape.rings.some((ring) => ringTouchesBox(ring, box))) return true;
  // No boundary crosses the box, so it is either wholly inside the area or wholly outside.
  const corner = boxCorners(box)[0]!;
  return shape.op.kind === "fill" ? insideFill(corner, shape.rings, shape.op.fillRule) : inConvex(corner, shape.rings[0]!);
};

/** Whether the painted area lies entirely inside the box. */
export const shapeEnclosedBy = (shape: Shape, box: Box): boolean => {
  if (isEmptyBox(shape.paintBox)) return false;
  const b = shape.paintBox;
  return b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY;
};

export interface ClosestPoint {
  readonly point: Point;
  readonly distance: number;
  /** Unit direction of the path at `point`, in world space. */
  readonly tangent: Point;
  /** `tangent` rotated a quarter turn: (-tangent.y, tangent.x). */
  readonly normal: Point;
}

/** The closest point on the path's centerline, within the flattening tolerance. */
export const shapeClosestPoint = (shape: Shape, p: Point): ClosestPoint | null => {
  let best: ClosestPoint | null = null;
  for (const line of shape.centerline) {
    const pts = line.points;
    // A fill closes every subpath; a stroke only the closed ones.
    const closed = line.closed || shape.op.kind === "fill";
    const edges = closed ? pts.length : pts.length - 1;
    if (pts.length === 1) {
      const d = Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
      if (!best || d < best.distance) best = { point: pts[0]!, distance: d, tangent: { x: 1, y: 0 }, normal: { x: 0, y: 1 } };
      continue;
    }
    for (let i = 0; i < edges; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const hit = segmentClosest(p, a, b);
      if (best && hit.distance >= best.distance) continue;
      const tangent = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      best = { point: hit.point, distance: hit.distance, tangent, normal: { x: -tangent.y, y: tangent.x } };
    }
  }
  return best;
};
