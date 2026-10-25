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
  EmbedOp,
  HoleOp,
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
  simplifyDetours,
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
export { VirtualGroup } from "./virtual";
export type { VirtualGroupSpec, VirtualView } from "./virtual";
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
export { type Morph, type MorphOptions, keyByMeta, mixColors, morph } from "./morph";
export { EmbedLayer, type EmbedLayerOptions } from "./embed";
export { AccessibilityLayer, type AccessibilityLayerOptions, type AccessibleNode, accessibilityTree } from "./accessibility";
export { blendTransforms } from "./morph";
export {
  Clip,
  type ClipOptions,
  type Easing,
  type Keyframe,
  type MotionKey,
  Player,
  Timeline,
  type TimelineOptions,
  type Track,
  drawing,
  easings,
  motionAt,
  pose,
} from "./timeline";
export { parseColor, srgbToOklab } from "./color";
export { type PixelBox, type TraceMaskOptions } from "./geometry/trace";
export {
  type Border,
  type BorderOptions,
  type BorderUse,
  type LabelOptions,
  type Region,
  type RegionMap,
  type RegionOutlines,
  labelRegions,
  regionRings,
  traceBorders,
  traceRegion,
  traceRegionPath,
} from "./geometry/regions";

export { removeMicroLoops } from "./geometry/micro-loops";
