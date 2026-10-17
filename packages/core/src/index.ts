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
export { SNAP_PRIORITY, Scene, transformOp } from "./geometry/scene";
export { imageToWorld } from "./geometry/shape";
export { maxScale, pathRings } from "./geometry/flatten";
export { normalizeRings, offsetRings, outlineBand } from "./geometry/offset";
export { opIsInvisible, paintIsTransparent } from "./geometry/visibility";
export type { Anchor, AnchorKind } from "./geometry/features";
export type {
  ClosestPointResult,
  Hit,
  HitTestOptions,
  QueryOptions,
  RectQueryMode,
  SceneChange,
  SceneOptions,
  Snap,
  SnapKind,
  SnapOptions,
} from "./geometry/scene";
export {
  type CubicPiece,
  type CurveTarget,
  type FitOptions,
  dedupePoints,
  fitCurve,
  isStraight,
  pieceAt,
  simplifyPolyline,
  smoothPolyline,
  traceCurve,
} from "./geometry/curves";
export { type PixelData, type TraceOptions, simplifyRing, traceImageOutline, traceImageSource, traceMask } from "./geometry/trace";
export {
  type ComponentHandle,
  type ComponentHandler,
  type ComponentSpec,
  type ComponentUi,
  Components,
  type ComponentsOptions,
} from "./components";
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
export { Renderer } from "./render";
export type { LevelOfDetail, RenderStats, RendererOptions, Surface } from "./render";
