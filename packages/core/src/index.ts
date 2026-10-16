export { RecordingContext, UnsupportedCanvasCallError } from "./context";
export type { Matrix2DInit, RecordingContextOptions } from "./context";
export { replayDocument, replayOp } from "./replay";
export type { ReplayOptions, ReplayTarget } from "./replay";
export { deserializeDocument, irDocumentSchema, parseDocument, serializeDocument } from "./serialization";
export { IDENTITY, applyToPoint, invert, multiply } from "./math";
export type {
  ArcSegment,
  ClearOp,
  Compositing,
  CubicSegment,
  EllipseSegment,
  FillOp,
  FillRule,
  IRDocument,
  LineCap,
  LineJoin,
  LineSegment,
  Matrix2D,
  Op,
  Paint,
  PathGeometry,
  Point,
  QuadSegment,
  Rect,
  Segment,
  StrokeOp,
  StrokeStyle,
  Subpath,
} from "./types";
export { Scene, transformOp } from "./geometry/scene";
export type { ClosestPointResult, Hit, HitTestOptions, RectQueryMode, SceneOptions } from "./geometry/scene";
