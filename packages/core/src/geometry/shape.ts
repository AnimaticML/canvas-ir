import { IDENTITY, applyToPoint, invert, multiply } from "../math";
import type { ClipPath, FillRule, ImageOp, Matrix2D, Op, Point, TextOp } from "../types";
import { type Box, EMPTY_BOX, boxOfPoints, isEmptyBox, pathBounds, unionBox } from "./bounds";
import { type Edge, edgeIntersections } from "./features";
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
  /** The clip region: a point must be inside every one of these. */
  readonly clips: readonly ClipShape[];
  /** An image with an outline: `rings` are its silhouette, filled nonzero, instead of its box. */
  readonly silhouette?: boolean;
}

export interface ClipShape {
  readonly rings: readonly (readonly Point[])[];
  readonly fillRule: FillRule;
  readonly box: Box;
}

const emptyShape = (op: Op): Shape => ({
  op,
  geometryBox: EMPTY_BOX,
  paintBox: EMPTY_BOX,
  rings: [],
  pieces: [],
  pieceBoxes: [],
  centerline: [],
  clips: [],
});

const intersectBoxes = (a: Box, b: Box): Box => ({
  minX: Math.max(a.minX, b.minX),
  minY: Math.max(a.minY, b.minY),
  maxX: Math.min(a.maxX, b.maxX),
  maxY: Math.min(a.maxY, b.maxY),
});

const clipCache = new WeakMap<ClipPath, ClipShape>();

const clipShape = (clip: ClipPath, tolerance: number): ClipShape => {
  let shape = clipCache.get(clip);
  if (!shape) {
    const rings = flattenPath(clip.path, IDENTITY, tolerance).map((l) => l.points);
    shape = { rings, fillRule: clip.fillRule, box: pathBounds(clip.path, IDENTITY) };
    clipCache.set(clip, shape);
  }
  return shape;
};

/** A local-space rectangle mapped to world space, as a ring. */
const quad = (m: Matrix2D, x0: number, y0: number, x1: number, y1: number): Point[] => [
  applyToPoint(m, x0, y0),
  applyToPoint(m, x1, y0),
  applyToPoint(m, x1, y1),
  applyToPoint(m, x0, y1),
];

/** Maps an image op's pixel space to world space. */
export const imageToWorld = (op: ImageOp): Matrix2D => {
  const { source: s, dest: d } = op;
  const kx = d.width / s.width;
  const ky = d.height / s.height;
  return multiply(op.transform, { a: kx, b: 0, c: 0, d: ky, e: d.x - s.x * kx, f: d.y - s.y * ky });
};

/** The world-space box of what an image op paints: the destination, cut down where the source leaves the image. */
export const imageRing = (op: ImageOp): Point[] | null => {
  const { source: s, dest: d, image } = op;
  const sx0 = Math.max(s.x, 0);
  const sy0 = Math.max(s.y, 0);
  const sx1 = Math.min(s.x + s.width, image.width);
  const sy1 = Math.min(s.y + s.height, image.height);
  if (sx1 <= sx0 || sy1 <= sy0) return null;
  const kx = d.width / s.width;
  const ky = d.height / s.height;
  return quad(op.transform, d.x + (sx0 - s.x) * kx, d.y + (sy0 - s.y) * ky, d.x + (sx1 - s.x) * kx, d.y + (sy1 - s.y) * ky);
};

/** The world-space box of a text op: its ink box from the recorded metrics, squeezed to maxWidth, widened by a stroke. */
const textRing = (op: TextOp): Point[] | null => {
  const m = op.metrics;
  const squeeze = op.maxWidth !== undefined && m.width > op.maxWidth ? op.maxWidth / m.width : 1;
  const pad = op.mode === "stroke" && op.stroke ? op.stroke.lineWidth / 2 : 0;
  const x0 = op.x - m.actualBoundingBoxLeft * squeeze - pad;
  const x1 = op.x + m.actualBoundingBoxRight * squeeze + pad;
  const y0 = op.y - m.actualBoundingBoxAscent - pad;
  const y1 = op.y + m.actualBoundingBoxDescent + pad;
  if (!(x1 > x0 && y1 > y0)) return null;
  return quad(op.transform, x0, y0, x1, y1);
};

/** Builds an op's shape, clipped; `tolerance` bounds the flattening error in world units. */
export const buildShape = (op: Op, tolerance: number): Shape => {
  const shape = buildUnclipped(op, tolerance);
  if (!op.clip || isEmptyBox(shape.paintBox)) return shape;
  const clips = [...shape.clips, ...op.clip.map((c) => clipShape(c, tolerance))];
  const paintBox = clips.reduce((box, c) => intersectBoxes(box, c.box), shape.paintBox);
  return { ...shape, clips, paintBox: isEmptyBox(paintBox) ? EMPTY_BOX : paintBox };
};

/** The shape before clipping. */
export const buildUnclipped = (op: Op, tolerance: number): Shape => {
  // Canvas paints nothing while the current transform is not invertible.
  const inverse = invert(op.transform);
  if (inverse === null) return emptyShape(op);

  switch (op.kind) {
    case "clear":
    case "embed": {
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
        ...emptyShape(op),
        geometryBox: pathBounds(op.path, IDENTITY),
        paintBox,
        pieces,
        pieceBoxes,
        centerline: flattenPath(op.path, IDENTITY, tolerance),
      };
    }
    case "image":
      if (op.image.outline) {
        const crop = imageRing(op);
        if (!crop) return emptyShape(op);
        // The silhouette, cut to the part of the image the source takes: the crop is a clip.
        const m = imageToWorld(op);
        const rings = op.image.outline.map((r) => r.map((p) => applyToPoint(m, p.x, p.y)));
        const cropBox = boxOfPoints(crop);
        const box = intersectBoxes(rings.map(boxOfPoints).reduce(unionBox, EMPTY_BOX), cropBox);
        if (isEmptyBox(box)) return emptyShape(op);
        const centerline: Polyline[] = rings.map((points) => ({
          points,
          smooth: points.map(() => false),
          tangentIn: points.map(() => null),
          tangentOut: points.map(() => null),
          closed: true,
        }));
        return {
          ...emptyShape(op),
          geometryBox: box,
          paintBox: box,
          rings,
          centerline,
          clips: [{ rings: [crop], fillRule: "nonzero", box: cropBox }],
          silhouette: true,
        };
      }
      return boxShape(op, imageRing(op));
    case "text":
      return boxShape(op, textRing(op));
  }
};

/** An image or text as its box. */
const boxShape = (op: Op, ring: Point[] | null): Shape => {
  if (!ring) return emptyShape(op);
  const box = boxOfPoints(ring);
  const outline: Polyline = {
    points: ring,
    smooth: ring.map(() => false),
    tangentIn: ring.map(() => null),
    tangentOut: ring.map(() => null),
    closed: true,
  };
  return { ...emptyShape(op), geometryBox: box, paintBox: box, rings: [ring], centerline: [outline] };
};

const insideClips = (shape: Shape, p: Point): boolean =>
  shape.clips.every((c) => insideFill(p, c.rings, c.fillRule));

/** Whether `p` is in the painted area, or within `tolerance` of it. */
export const shapeContains = (shape: Shape, p: Point, tolerance: number): boolean => {
  if (isEmptyBox(shape.paintBox)) return false;
  if (shape.clips.length > 0 && !insideClips(shape, p)) return false;
  const { paintBox: b } = shape;
  if (p.x < b.minX - tolerance || p.x > b.maxX + tolerance || p.y < b.minY - tolerance || p.y > b.maxY + tolerance) {
    return false;
  }
  if (shape.silhouette) return insideFill(p, shape.rings, "nonzero") || (tolerance > 0 && shape.rings.some((ring) => distanceToRing(p, ring) <= tolerance));
  switch (shape.op.kind) {
    case "clear":
    case "embed":
    case "image":
    case "text":
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
export const shapeIntersectsBox = (shape: Shape, query: Box): boolean => {
  // With a clip, only the part of the box inside the clip's bounds can touch paint (an approximation for non-rectangular clips).
  const box = shape.clips.reduce((q, c) => intersectBoxes(q, c.box), query);
  if (isEmptyBox(box)) return false;
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
  if (shape.silhouette) return insideFill(corner, shape.rings, "nonzero");
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

/** The closed outlines of the painted area: a fill's rings, a stroke's pieces, or a box. */
const paintedOutlines = (shape: Shape): readonly (readonly Point[])[] =>
  shape.op.kind === "stroke" ? shape.pieces : shape.rings;

const ringEdges = (rings: readonly (readonly Point[])[]): Edge[] =>
  rings.flatMap((ring) => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length]! })));

const crosses = (rings: readonly (readonly Point[])[], polygon: readonly Point[]): boolean =>
  edgeIntersections(ringEdges(rings), ringEdges([polygon]), 0).length > 0;

/**
 * Whether the painted area touches a polygon (such as a lasso; nonzero fill).
 * Like the rect query, a non-rectangular clip is approximated by its bounds.
 */
export const shapeTouchesPolygon = (shape: Shape, polygon: readonly Point[]): boolean => {
  if (isEmptyBox(shape.paintBox) || polygon.length < 3) return false;
  const pbox = boxOfPoints(polygon);
  const b = shape.clips.reduce((box, c) => intersectBoxes(box, c.box), shape.paintBox);
  if (isEmptyBox(b) || b.minX > pbox.maxX || b.maxX < pbox.minX || b.minY > pbox.maxY || b.maxY < pbox.minY) return false;
  const outlines = paintedOutlines(shape);
  if (outlines.some((ring) => ring.some((p) => insideFill(p, [polygon], "nonzero")))) return true;
  if (polygon.some((p) => shapeContains(shape, p, 0))) return true;
  return crosses(outlines, polygon);
};

/** Whether the painted area lies entirely inside a polygon. */
export const shapeEnclosedByPolygon = (shape: Shape, polygon: readonly Point[]): boolean => {
  if (isEmptyBox(shape.paintBox) || polygon.length < 3) return false;
  const outlines = paintedOutlines(shape);
  return outlines.every((ring) => ring.every((p) => insideFill(p, [polygon], "nonzero"))) && !crosses(outlines, polygon);
};
