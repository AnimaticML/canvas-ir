export { RecordingContext, UnsupportedCanvasCallError, describeImageElement } from "./context";
export type { Matrix2DInit, RecordingContextOptions, StyleValue } from "./context";
export { RecordingGradient, RecordingPattern } from "./paint";
export { RecordingPath2D } from "./path2d";
export { canvasColor } from "./color";
export { replayDocument, replayOp } from "./replay";
export type { ReplayOptions, ReplayTarget } from "./replay";
export { deserializeDocument, irDocumentSchema, parseDocument, serializeDocument } from "./serialization";
export { IDENTITY, applyToPoint, invert, multiply } from "./math";
export type {
  ArcSegment,
  ClearOp,
  ClipPath,
  ColorStop,
  Compositing,
  ConicGradientPaint,
  CubicSegment,
  EllipseSegment,
  FillOp,
  FillRule,
  Group,
  JsonValue,
  GradientPaint,
  IRDocument,
  ImageOp,
  ImageRef,
  ImageSmoothingQuality,
  LineCap,
  LineJoin,
  LineSegment,
  LinearGradientPaint,
  Matrix2D,
  Op,
  Paint,
  PathGeometry,
  PatternPaint,
  PatternRepetition,
  Point,
  QuadSegment,
  RadialGradientPaint,
  Rect,
  Segment,
  StrokeOp,
  StrokeStyle,
  Subpath,
  TextAlign,
  TextBaseline,
  TextDirection,
  TextMeasure,
  TextOp,
  TextStyle,
} from "./types";
export { Scene, transformOp } from "./geometry/scene";
export { pathRings } from "./geometry/flatten";
export type { ClosestPointResult, Hit, HitTestOptions, RectQueryMode, SceneOptions } from "./geometry/scene";
export { EventRouter } from "./interaction";
export type {
  EventRouterOptions,
  KeyInput,
  PointerInput,
  RouterEvent,
  RouterEventType,
  RouterHandler,
  WheelInput,
} from "./interaction";
export { ellipseAxes, svgPathData, toSVG } from "./svg";
export type { SvgOptions } from "./svg";
