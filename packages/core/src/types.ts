export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A 2D affine matrix in Canvas order: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Path geometry keeps the coordinates the caller passed. Each subpath start and
 * segment names the matrix (an index into `PathGeometry.matrices`) that was the
 * current transform when it was added, so a path built across transform changes
 * stays exact. A segment starts where the previous one ended, in world space.
 */
export type Segment = LineSegment | QuadSegment | CubicSegment | EllipseSegment;

export interface LineSegment {
  readonly kind: "line";
  readonly m: number;
  readonly to: Point;
}

export interface QuadSegment {
  readonly kind: "quad";
  readonly m: number;
  readonly cp: Point;
  readonly to: Point;
}

export interface CubicSegment {
  readonly kind: "cubic";
  readonly m: number;
  readonly cp1: Point;
  readonly cp2: Point;
  readonly to: Point;
}

/** An `arc` or `ellipse` call as made. `arc` is stored with `rx === ry` and `rotation === 0`. */
export interface EllipseSegment {
  readonly kind: "ellipse";
  readonly m: number;
  readonly center: Point;
  readonly rx: number;
  readonly ry: number;
  readonly rotation: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly counterclockwise: boolean;
}

export interface Subpath {
  readonly m: number;
  readonly start: Point;
  readonly segments: readonly Segment[];
  readonly closed: boolean;
  /**
   * Present when an `arc` or `ellipse` call began the subpath, with no `moveTo`;
   * `start` is then the arc's start point. Replay leaves out the `moveTo` too,
   * because browsers rasterize a path that is only an ellipse as an oval.
   */
  readonly startImplied?: true;
}

export interface PathGeometry {
  readonly matrices: readonly Matrix2D[];
  readonly subpaths: readonly Subpath[];
}

export type FillRule = "nonzero" | "evenodd";
export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";

/** Paints are CSS color strings in this phase; gradients and patterns come later. */
export type Paint = string;

export interface Compositing {
  readonly globalAlpha: number;
  readonly globalCompositeOperation: string;
  readonly filter: string;
  readonly shadowColor: string;
  readonly shadowBlur: number;
  readonly shadowOffsetX: number;
  readonly shadowOffsetY: number;
}

export interface StrokeStyle {
  readonly paint: Paint;
  readonly lineWidth: number;
  readonly lineCap: LineCap;
  readonly lineJoin: LineJoin;
  readonly miterLimit: number;
  readonly lineDash: readonly number[];
  readonly lineDashOffset: number;
}

interface OpBase {
  readonly id: string;
  /** The current transform when the op was drawn. Stroke widths and paints live in this space. */
  readonly transform: Matrix2D;
  readonly compositing: Compositing;
}

export interface FillOp extends OpBase {
  readonly kind: "fill";
  readonly fillRule: FillRule;
  readonly paint: Paint;
  readonly path: PathGeometry;
}

export interface StrokeOp extends OpBase {
  readonly kind: "stroke";
  readonly stroke: StrokeStyle;
  readonly path: PathGeometry;
}

/** `clearRect`: clears pixels in `rect`, in `transform` space. Compositing does not apply to it. */
export interface ClearOp {
  readonly kind: "clear";
  readonly id: string;
  readonly transform: Matrix2D;
  readonly rect: Rect;
}

export type Op = FillOp | StrokeOp | ClearOp;

export interface IRDocument {
  readonly version: 1;
  readonly ops: readonly Op[];
}
