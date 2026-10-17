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
export type Segment = LineSegment | QuadSegment | CubicSegment | ArcSegment | EllipseSegment;

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

/**
 * An `arc` call as made (also what `arcTo` lowers to). Kept apart from
 * `ellipse` because browsers rasterize the two calls slightly differently.
 */
export interface ArcSegment {
  readonly kind: "arc";
  readonly m: number;
  readonly center: Point;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly counterclockwise: boolean;
}

/** An `ellipse` call as made. */
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

export interface ColorStop {
  readonly offset: number;
  readonly color: string;
}

/** Gradient coordinates are in the space of the op's `transform`, as Canvas interprets them at paint time. */
export interface LinearGradientPaint {
  readonly kind: "linear";
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** In the order they were added; the spec sorts equal offsets by that order. */
  readonly stops: readonly ColorStop[];
}

export interface RadialGradientPaint {
  readonly kind: "radial";
  readonly x0: number;
  readonly y0: number;
  readonly r0: number;
  readonly x1: number;
  readonly y1: number;
  readonly r1: number;
  readonly stops: readonly ColorStop[];
}

export interface ConicGradientPaint {
  readonly kind: "conic";
  readonly startAngle: number;
  readonly x: number;
  readonly y: number;
  readonly stops: readonly ColorStop[];
}

export type GradientPaint = LinearGradientPaint | RadialGradientPaint | ConicGradientPaint;

/**
 * An image as the IR stores it: a reference the host can resolve back to pixels
 * (a URL, an asset id), and the intrinsic size it had when it was drawn.
 */
export interface ImageRef {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  /**
   * Where the image is opaque, as closed rings in its pixel space filled with
   * the nonzero rule (see `traceImageOutline`). Hit tests, closest points,
   * snapping and text layout use it instead of the image's box.
   */
  readonly outline?: readonly (readonly Point[])[];
}

export type PatternRepetition = "repeat" | "repeat-x" | "repeat-y" | "no-repeat";

export interface PatternPaint {
  readonly kind: "pattern";
  readonly image: ImageRef;
  readonly repetition: PatternRepetition;
  /** The pattern's own `setTransform`, applied inside the op's transform. */
  readonly transform: Matrix2D;
}

/** A CSS color (normalized as browsers serialize it), or a gradient or pattern snapshotted when the op was drawn. */
export type Paint = string | GradientPaint | PatternPaint;

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

/** One `clip()` call: the path and fill rule it intersected the clip region with, and the transform then. */
export interface ClipPath {
  readonly fillRule: FillRule;
  readonly transform: Matrix2D;
  readonly path: PathGeometry;
}

/** Any JSON value, for caller metadata. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A named set of ops, such as an SVG asset or a text block, so it can be hit,
 * moved and listened to as one object. Groups nest through `parent`.
 */
export interface Group {
  readonly id: string;
  readonly parent?: string;
  readonly meta?: { readonly [key: string]: JsonValue };
}

interface OpBase {
  readonly id: string;
  /** The current transform when the op was drawn. Stroke widths and paints live in this space. */
  readonly transform: Matrix2D;
  readonly compositing: Compositing;
  /** The clip region in effect: the intersection of these paths, outermost first. Absent when unclipped. */
  readonly clip?: readonly ClipPath[];
  /** The innermost group the op was drawn in. */
  readonly group?: string;
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

/** `clearRect`: clears pixels in `rect`, in `transform` space, inside the clip. Compositing does not apply to it. */
export interface ClearOp {
  readonly kind: "clear";
  readonly id: string;
  readonly transform: Matrix2D;
  readonly rect: Rect;
  readonly clip?: readonly ClipPath[];
  readonly group?: string;
}

/**
 * An extension: a place for an HTML element (a video, a form, a WebGL or 3D
 * canvas) in the drawing order. Replayed onto a canvas it cuts a hole the size
 * of `rect`, like `clearRect`, so the element can sit beneath the canvas and
 * show through it: what was drawn before is covered by the element, what is
 * drawn after paints over it. `content` says what to put there; the host
 * decides how (see `EmbedLayer`).
 */
export interface EmbedOp {
  readonly kind: "embed";
  readonly id: string;
  readonly transform: Matrix2D;
  readonly rect: Rect;
  readonly content: { readonly [key: string]: JsonValue };
  readonly clip?: readonly ClipPath[];
  readonly group?: string;
}

export type ImageSmoothingQuality = "low" | "medium" | "high";

/** `drawImage`, normalized to its nine-argument form: `source` within the image, drawn into `dest`. */
export interface ImageOp extends OpBase {
  readonly kind: "image";
  readonly image: ImageRef;
  readonly source: Rect;
  readonly dest: Rect;
  readonly smoothing: { readonly enabled: boolean; readonly quality: ImageSmoothingQuality };
}

export type TextAlign = "start" | "end" | "left" | "right" | "center";
export type TextBaseline = "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
export type TextDirection = "ltr" | "rtl" | "inherit";

/** The text properties of the drawing state. */
export interface TextStyle {
  readonly font: string;
  readonly textAlign: TextAlign;
  readonly textBaseline: TextBaseline;
  readonly direction: TextDirection;
  readonly letterSpacing: string;
  readonly wordSpacing: string;
  readonly fontKerning: string;
  readonly fontStretch: string;
  readonly fontVariantCaps: string;
  readonly textRendering: string;
}

/**
 * `measureText` of the op's text, taken while recording. Bounding-box values
 * are relative to the anchor (x, y), with `textAlign` and `textBaseline` applied,
 * as `TextMetrics` reports them. Nothing measures again after recording.
 */
export interface TextMeasure {
  readonly width: number;
  readonly actualBoundingBoxLeft: number;
  readonly actualBoundingBoxRight: number;
  readonly actualBoundingBoxAscent: number;
  readonly actualBoundingBoxDescent: number;
  readonly fontBoundingBoxAscent: number;
  readonly fontBoundingBoxDescent: number;
}

/** `fillText` or `strokeText`. A stroked op carries its line style; both carry the paint. */
export interface TextOp extends OpBase {
  readonly kind: "text";
  readonly mode: "fill" | "stroke";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly maxWidth?: number;
  readonly style: TextStyle;
  readonly paint: Paint;
  readonly stroke?: StrokeStyle;
  readonly metrics: TextMeasure;
}

export type Op = FillOp | StrokeOp | ClearOp | ImageOp | TextOp | EmbedOp;

/** Ops that cut a hole rather than paint: they have no compositing. */
export type HoleOp = ClearOp | EmbedOp;

export interface IRDocument {
  readonly version: 1;
  readonly ops: readonly Op[];
  /** Groups in the order they were opened; absent when there are none. */
  readonly groups?: readonly Group[];
}
