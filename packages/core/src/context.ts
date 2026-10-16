import { canvasColor } from "./color";
import { buildShape, shapeContains } from "./geometry/shape";
import { IDENTITY, allFinite, multiply } from "./math";
import {
  RecordingGradient,
  RecordingPattern,
  createConicGradient,
  createLinearGradient,
  createRadialGradient,
  parseRepetition,
} from "./paint";
import { PathBuilder } from "./path";
import { type DOMPointInitLike, RecordingPath2D, normalizeRadii } from "./path2d";
import type {
  Group,
  JsonValue,
  ClipPath,
  Compositing,
  FillRule,
  ImageRef,
  ImageSmoothingQuality,
  IRDocument,
  LineCap,
  LineJoin,
  Matrix2D,
  Op,
  Paint,
  StrokeStyle,
  TextAlign,
  TextBaseline,
  TextDirection,
  TextMeasure,
  TextStyle,
} from "./types";

/** What a style property holds: a color string, or a gradient or pattern object. */
export type StyleValue = string | RecordingGradient | RecordingPattern;

interface DrawingState {
  transform: Matrix2D;
  clip: readonly ClipPath[];
  fillStyle: StyleValue;
  strokeStyle: StyleValue;
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  lineDash: readonly number[];
  lineDashOffset: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  text: TextStyle;
}

const DEFAULT_TEXT: TextStyle = {
  font: "10px sans-serif",
  textAlign: "start",
  textBaseline: "alphabetic",
  direction: "inherit",
  letterSpacing: "0px",
  wordSpacing: "0px",
  fontKerning: "auto",
  fontStretch: "normal",
  fontVariantCaps: "normal",
  textRendering: "auto",
};

const defaultState = (): DrawingState => ({
  transform: IDENTITY,
  clip: [],
  fillStyle: "#000000",
  strokeStyle: "#000000",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 10,
  lineDash: [],
  lineDashOffset: 0,
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  filter: "none",
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  imageSmoothingEnabled: true,
  imageSmoothingQuality: "low",
  text: DEFAULT_TEXT,
});

const TEXT_ALIGNS: readonly string[] = ["start", "end", "left", "right", "center"];
const TEXT_BASELINES: readonly string[] = ["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"];
const DIRECTIONS: readonly string[] = ["ltr", "rtl", "inherit"];
const FONT_KERNINGS: readonly string[] = ["auto", "normal", "none"];
const FONT_STRETCHES: readonly string[] = [
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal",
  "semi-expanded", "expanded", "extra-expanded", "ultra-expanded",
];
const FONT_VARIANT_CAPS: readonly string[] = [
  "normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps",
];
const TEXT_RENDERINGS: readonly string[] = ["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"];
const SMOOTHING_QUALITIES: readonly string[] = ["low", "medium", "high"];
const SYSTEM_FONTS = /^(caption|icon|menu|message-box|small-caption|status-bar)$/;
/** A CSS font shorthand needs a size (optionally /line-height) followed by a family. */
const FONT_SHORTHAND = /(^|\s)[+]?(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%|vw|vh|vmin|vmax|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)?(\/\S+)?\s+\S/i;
const FONT_SIZE_KEYWORD = /(^|\s)(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(\/\S+)?\s+\S/i;
const LENGTH = /^[+-]?(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch)$|^0$/i;

const LINE_CAPS: readonly string[] = ["butt", "round", "square"];
const LINE_JOINS: readonly string[] = ["miter", "round", "bevel"];
const COMPOSITE_OPERATIONS: readonly string[] = [
  "source-over", "source-in", "source-out", "source-atop",
  "destination-over", "destination-in", "destination-out", "destination-atop",
  "lighter", "copy", "xor", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
];

/** Thrown by Canvas calls this version records nothing for, so callers fail loudly rather than draw nothing. */
export class UnsupportedCanvasCallError extends Error {
  constructor(method: string) {
    super(`CanvasIR does not support ${method} yet.`);
    this.name = "UnsupportedCanvasCallError";
  }
}

export interface Matrix2DInit {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
  m11?: number;
  m12?: number;
  m21?: number;
  m22?: number;
  m41?: number;
  m42?: number;
}

export interface RecordingContextOptions {
  /** Size reported by `ctx.canvas`, for code that reads it. Defaults to the HTML canvas default, 300 x 150. */
  readonly width?: number;
  readonly height?: number;
  /**
   * Measures text for `measureText`, `fillText` and `strokeText`. Defaults to a
   * real canvas where one exists (browsers, or anywhere `OffscreenCanvas` is
   * defined); elsewhere, drawing text without a measurer throws.
   */
  readonly measureText?: (text: string, style: TextStyle) => TextMeasure;
  /**
   * Turns an image passed to `drawImage` or `createPattern` into a reference
   * the IR can store. Return null for an image that isn't ready, which draws
   * nothing. Defaults to the element's `src` and natural size.
   */
  readonly describeImage?: (image: unknown) => ImageRef | null;
}

/** The default image description: an `<img>`-like object's `src` and natural size. */
export const describeImageElement = (image: unknown): ImageRef | null => {
  const candidate = image as { src?: unknown; naturalWidth?: unknown; naturalHeight?: unknown; width?: unknown; height?: unknown };
  if (typeof candidate?.src !== "string" || candidate.src === "") {
    throw new UnsupportedCanvasCallError("drawing an image without a src (pass describeImage to record it)");
  }
  const width = typeof candidate.naturalWidth === "number" ? candidate.naturalWidth : candidate.width;
  const height = typeof candidate.naturalHeight === "number" ? candidate.naturalHeight : candidate.height;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return null;
  return { src: candidate.src, width, height };
};

let measuringContext: OffscreenCanvasRenderingContext2D | null | undefined;

/** Measures with a real canvas, where the environment has one. */
const measureWithCanvas = (text: string, style: TextStyle): TextMeasure => {
  if (measuringContext === undefined) {
    measuringContext =
      typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("2d") : null;
  }
  const ctx = measuringContext;
  if (!ctx) throw new UnsupportedCanvasCallError("text without a measureText option outside a browser");
  const target = ctx as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(style)) if (key in target) target[key] = value;
  const m = ctx.measureText(text);
  return {
    width: m.width,
    actualBoundingBoxLeft: m.actualBoundingBoxLeft,
    actualBoundingBoxRight: m.actualBoundingBoxRight,
    actualBoundingBoxAscent: m.actualBoundingBoxAscent,
    actualBoundingBoxDescent: m.actualBoundingBoxDescent,
    fontBoundingBoxAscent: m.fontBoundingBoxAscent,
    fontBoundingBoxDescent: m.fontBoundingBoxDescent,
  };
};

const matrixFromInit = (init: Matrix2DInit): Matrix2D => ({
  a: init.a ?? init.m11 ?? 1,
  b: init.b ?? init.m12 ?? 0,
  c: init.c ?? init.m21 ?? 0,
  d: init.d ?? init.m22 ?? 1,
  e: init.e ?? init.m41 ?? 0,
  f: init.f ?? init.m42 ?? 0,
});

const toDOMMatrix = (m: Matrix2D): DOMMatrix | Matrix2D =>
  typeof DOMMatrix === "function" ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : { ...m };

const normalizeRect = (x: number, y: number, w: number, h: number) => ({
  x: Math.min(x, x + w),
  y: Math.min(y, y + h),
  width: Math.abs(w),
  height: Math.abs(h),
});

const parseFillRule = (value: unknown): FillRule => {
  if (value === undefined || value === "nonzero") return "nonzero";
  if (value === "evenodd") return "evenodd";
  throw new TypeError(`The provided value '${String(value)}' is not a valid enum value of type CanvasFillRule.`);
};

/**
 * A stand-in for `CanvasRenderingContext2D` that records drawing into an
 * `IRDocument` instead of painting. Calls follow the Canvas 2D spec: invalid
 * property values and calls with non-finite arguments are ignored, as a browser
 * ignores them.
 */
export class RecordingContext {
  readonly canvas: { width: number; height: number };

  private ops: Op[] = [];
  private nextId = 0;
  private groups: Group[] = [];
  private groupStack: string[] = [];
  private nextGroupId = 0;
  private state: DrawingState = defaultState();
  private stack: DrawingState[] = [];
  private readonly path = new PathBuilder();
  private readonly measurer: (text: string, style: TextStyle) => TextMeasure;
  private readonly describeImage: (image: unknown) => ImageRef | null;

  constructor(options: RecordingContextOptions = {}) {
    this.canvas = { width: options.width ?? 300, height: options.height ?? 150 };
    this.measurer = options.measureText ?? measureWithCanvas;
    this.describeImage = options.describeImage ?? describeImageElement;
  }

  getDocument(): IRDocument {
    return this.groups.length > 0 ? { version: 1, ops: [...this.ops], groups: [...this.groups] } : { version: 1, ops: [...this.ops] };
  }

  // --- Groups (an extension; not part of Canvas 2D) ---

  /**
   * Opens a group: ops drawn until the matching `endGroup` belong to it, and to
   * any group it is nested in. Returns the group's id. Groups are separate from
   * `save`/`restore`. Passing the id of a closed group in the same parent, with
   * no `meta`, adds to that group again.
   */
  beginGroup(options: { id?: string; meta?: { [key: string]: JsonValue } } = {}): string {
    const id = options.id ?? `g${this.nextGroupId++}`;
    const parent = this.groupStack[this.groupStack.length - 1];
    const existing = this.groups.find((g) => g.id === id);
    // Opening a closed group again, in the same parent, adds to it: a group's ops needn't be consecutive.
    if (existing && existing.parent === parent && !this.groupStack.includes(id) && options.meta === undefined) {
      this.groupStack.push(id);
      return id;
    }
    if (existing || this.ops.some((op) => op.id === id)) throw new Error(`a group or op with id ${id} already exists`);
    this.groups.push({ id, ...(parent !== undefined ? { parent } : {}), ...(options.meta ? { meta: options.meta } : {}) });
    this.groupStack.push(id);
    return id;
  }

  /** Closes the innermost open group. */
  endGroup(): void {
    if (this.groupStack.pop() === undefined) throw new Error("endGroup() without a matching beginGroup()");
  }

  // --- State ---

  save(): void {
    this.stack.push({ ...this.state });
  }

  restore(): void {
    const previous = this.stack.pop();
    if (previous !== undefined) this.state = previous;
  }

  /** Like the spec's `reset()`: clears the drawing, the path, the state stack and all state. */
  reset(): void {
    this.ops = [];
    this.nextId = 0;
    this.groups = [];
    this.groupStack = [];
    this.nextGroupId = 0;
    this.state = defaultState();
    this.stack = [];
    this.path.reset();
  }

  get fillStyle(): StyleValue {
    return this.state.fillStyle;
  }
  set fillStyle(value: StyleValue) {
    const style = this.style(value, "fillStyle");
    if (style !== null) this.state.fillStyle = style;
  }

  get strokeStyle(): StyleValue {
    return this.state.strokeStyle;
  }
  set strokeStyle(value: StyleValue) {
    const style = this.style(value, "strokeStyle");
    if (style !== null) this.state.strokeStyle = style;
  }

  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    if (Number.isFinite(value) && value > 0) this.state.lineWidth = value;
  }

  get lineCap(): LineCap {
    return this.state.lineCap;
  }
  set lineCap(value: LineCap) {
    if (LINE_CAPS.includes(value)) this.state.lineCap = value;
  }

  get lineJoin(): LineJoin {
    return this.state.lineJoin;
  }
  set lineJoin(value: LineJoin) {
    if (LINE_JOINS.includes(value)) this.state.lineJoin = value;
  }

  get miterLimit(): number {
    return this.state.miterLimit;
  }
  set miterLimit(value: number) {
    if (Number.isFinite(value) && value > 0) this.state.miterLimit = value;
  }

  setLineDash(segments: readonly number[]): void {
    if (segments.some((value) => !Number.isFinite(value) || value < 0)) return;
    this.state.lineDash = segments.length % 2 === 1 ? [...segments, ...segments] : [...segments];
  }

  getLineDash(): number[] {
    return [...this.state.lineDash];
  }

  get lineDashOffset(): number {
    return this.state.lineDashOffset;
  }
  set lineDashOffset(value: number) {
    if (Number.isFinite(value)) this.state.lineDashOffset = value;
  }

  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (Number.isFinite(value) && value >= 0 && value <= 1) this.state.globalAlpha = value;
  }

  get globalCompositeOperation(): string {
    return this.state.globalCompositeOperation;
  }
  set globalCompositeOperation(value: string) {
    if (COMPOSITE_OPERATIONS.includes(value)) this.state.globalCompositeOperation = value;
  }

  get filter(): string {
    return this.state.filter;
  }
  set filter(value: string) {
    this.state.filter = String(value);
  }

  get shadowColor(): string {
    return this.state.shadowColor;
  }
  set shadowColor(value: string) {
    const color = canvasColor(String(value));
    if (color !== null) this.state.shadowColor = color;
  }

  get shadowBlur(): number {
    return this.state.shadowBlur;
  }
  set shadowBlur(value: number) {
    if (Number.isFinite(value) && value >= 0) this.state.shadowBlur = value;
  }

  get shadowOffsetX(): number {
    return this.state.shadowOffsetX;
  }
  set shadowOffsetX(value: number) {
    if (Number.isFinite(value)) this.state.shadowOffsetX = value;
  }

  get shadowOffsetY(): number {
    return this.state.shadowOffsetY;
  }
  set shadowOffsetY(value: number) {
    if (Number.isFinite(value)) this.state.shadowOffsetY = value;
  }

  get imageSmoothingEnabled(): boolean {
    return this.state.imageSmoothingEnabled;
  }
  set imageSmoothingEnabled(value: boolean) {
    this.state.imageSmoothingEnabled = Boolean(value);
  }

  get imageSmoothingQuality(): ImageSmoothingQuality {
    return this.state.imageSmoothingQuality;
  }
  set imageSmoothingQuality(value: ImageSmoothingQuality) {
    if (SMOOTHING_QUALITIES.includes(value)) this.state.imageSmoothingQuality = value;
  }

  // --- Text state ---

  get font(): string {
    return this.state.text.font;
  }
  set font(value: string) {
    const font = String(value).trim().replace(/\s+/g, " ");
    if (SYSTEM_FONTS.test(font) || FONT_SHORTHAND.test(font) || FONT_SIZE_KEYWORD.test(font)) this.setText({ font });
  }

  get textAlign(): TextAlign {
    return this.state.text.textAlign;
  }
  set textAlign(value: TextAlign) {
    if (TEXT_ALIGNS.includes(value)) this.setText({ textAlign: value });
  }

  get textBaseline(): TextBaseline {
    return this.state.text.textBaseline;
  }
  set textBaseline(value: TextBaseline) {
    if (TEXT_BASELINES.includes(value)) this.setText({ textBaseline: value });
  }

  get direction(): TextDirection {
    return this.state.text.direction;
  }
  set direction(value: TextDirection) {
    if (DIRECTIONS.includes(value)) this.setText({ direction: value });
  }

  get letterSpacing(): string {
    return this.state.text.letterSpacing;
  }
  set letterSpacing(value: string) {
    const v = String(value).trim();
    if (LENGTH.test(v)) this.setText({ letterSpacing: v === "0" ? "0px" : v });
  }

  get wordSpacing(): string {
    return this.state.text.wordSpacing;
  }
  set wordSpacing(value: string) {
    const v = String(value).trim();
    if (LENGTH.test(v)) this.setText({ wordSpacing: v === "0" ? "0px" : v });
  }

  get fontKerning(): string {
    return this.state.text.fontKerning;
  }
  set fontKerning(value: string) {
    if (FONT_KERNINGS.includes(value)) this.setText({ fontKerning: value });
  }

  get fontStretch(): string {
    return this.state.text.fontStretch;
  }
  set fontStretch(value: string) {
    if (FONT_STRETCHES.includes(value)) this.setText({ fontStretch: value });
  }

  get fontVariantCaps(): string {
    return this.state.text.fontVariantCaps;
  }
  set fontVariantCaps(value: string) {
    if (FONT_VARIANT_CAPS.includes(value)) this.setText({ fontVariantCaps: value });
  }

  get textRendering(): string {
    return this.state.text.textRendering;
  }
  set textRendering(value: string) {
    if (TEXT_RENDERINGS.includes(value)) this.setText({ textRendering: value });
  }

  // --- Transforms ---

  scale(x: number, y: number): void {
    if (!allFinite(x, y)) return;
    this.applyTransform({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
  }

  rotate(angle: number): void {
    if (!Number.isFinite(angle)) return;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.applyTransform({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  }

  translate(x: number, y: number): void {
    if (!allFinite(x, y)) return;
    this.applyTransform({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (!allFinite(a, b, c, d, e, f)) return;
    this.applyTransform({ a, b, c, d, e, f });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(transform?: Matrix2DInit): void;
  setTransform(a?: number | Matrix2DInit, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (typeof a === "number") {
      const values = [a, b, c, d, e, f];
      if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return;
      const [ma, mb, mc, md, me, mf] = values as [number, number, number, number, number, number];
      this.state.transform = { a: ma, b: mb, c: mc, d: md, e: me, f: mf };
      return;
    }
    const matrix = a === undefined ? IDENTITY : matrixFromInit(a);
    if (!allFinite(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)) {
      throw new TypeError("setTransform() was given a matrix with non-finite values.");
    }
    this.state.transform = matrix;
  }

  getTransform(): DOMMatrix | Matrix2D {
    return toDOMMatrix(this.state.transform);
  }

  resetTransform(): void {
    this.state.transform = IDENTITY;
  }

  // --- Paths ---

  beginPath(): void {
    this.path.reset();
  }

  moveTo(x: number, y: number): void {
    this.path.moveTo(this.state.transform, x, y);
  }

  lineTo(x: number, y: number): void {
    this.path.lineTo(this.state.transform, x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.path.quadraticCurveTo(this.state.transform, cpx, cpy, x, y);
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.path.bezierCurveTo(this.state.transform, cp1x, cp1y, cp2x, cp2y, x, y);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    this.path.arc(this.state.transform, x, y, radius, startAngle, endAngle, counterclockwise);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.path.arcTo(this.state.transform, x1, y1, x2, y2, radius);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.path.ellipse(this.state.transform, x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.rect(this.state.transform, x, y, w, h);
  }

  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | DOMPointInitLike | readonly (number | DOMPointInitLike)[] = 0,
  ): void {
    if (!allFinite(x, y, w, h)) return;
    const corners = normalizeRadii(radii);
    if (corners) this.path.roundRect(this.state.transform, x, y, w, h, corners);
  }

  closePath(): void {
    this.path.closePath();
  }

  // --- Drawing ---

  fill(fillRule?: FillRule): void;
  fill(path: RecordingPath2D, fillRule?: FillRule): void;
  fill(a?: FillRule | RecordingPath2D, b?: FillRule): void {
    if (typeof a === "object") this.recordFill(this.pathFrom(a), parseFillRule(b));
    else this.recordFill(this.path, parseFillRule(a));
  }

  stroke(path?: RecordingPath2D): void {
    this.recordStroke(path === undefined ? this.path : this.pathFrom(path));
  }

  /** Intersects the clip region with the path. Clipping is part of the saved state. */
  clip(fillRule?: FillRule): void;
  clip(path: RecordingPath2D, fillRule?: FillRule): void;
  clip(a?: FillRule | RecordingPath2D, b?: FillRule): void {
    const builder = typeof a === "object" ? this.pathFrom(a) : this.path;
    const fillRule = parseFillRule(typeof a === "object" ? b : a);
    this.state.clip = [...this.state.clip, { fillRule, transform: this.state.transform, path: builder.snapshot() }];
  }

  /** Whether the point, in canvas coordinates, is inside the current path (or `path`). Clipping is ignored, as in the spec. */
  isPointInPath(x: number, y: number, fillRule?: FillRule): boolean;
  isPointInPath(path: RecordingPath2D, x: number, y: number, fillRule?: FillRule): boolean;
  isPointInPath(a: number | RecordingPath2D, b: number | FillRule | undefined, c?: number | FillRule, d?: FillRule): boolean {
    const [builder, x, y, rule] =
      typeof a === "object" ? [this.pathFrom(a), b as number, c as number, d] : [this.path, a, b as number, c as FillRule | undefined];
    if (!allFinite(x, y)) return false;
    const path = builder.snapshot();
    if (path.subpaths.length === 0) return false;
    const op: Op = { kind: "fill", ...this.probeBase(), fillRule: parseFillRule(rule), paint: "#000000", path };
    return shapeContains(buildShape(op, 0.01), { x, y }, 0);
  }

  /** Whether the point, in canvas coordinates, is on the stroke of the current path (or `path`) with the current line style. */
  isPointInStroke(x: number, y: number): boolean;
  isPointInStroke(path: RecordingPath2D, x: number, y: number): boolean;
  isPointInStroke(a: number | RecordingPath2D, b: number, c?: number): boolean {
    const [builder, x, y] = typeof a === "object" ? [this.pathFrom(a), b, c as number] : [this.path, a, b];
    if (!allFinite(x, y)) return false;
    const path = builder.snapshot();
    if (path.subpaths.length === 0) return false;
    const op: Op = { kind: "stroke", ...this.probeBase(), stroke: this.strokeStyleSnapshot(), path };
    return shapeContains(buildShape(op, 0.01), { x, y }, 0);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (!allFinite(x, y, w, h) || w === 0 || h === 0) return;
    const path = new PathBuilder();
    path.rect(this.state.transform, x, y, w, h);
    this.recordFill(path, "nonzero");
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (!allFinite(x, y, w, h) || (w === 0 && h === 0)) return;
    const path = new PathBuilder();
    if (w === 0 || h === 0) {
      // The spec strokes a degenerate rectangle as a single line.
      path.moveTo(this.state.transform, x, y);
      path.lineTo(this.state.transform, x + w, y + h);
    } else {
      path.rect(this.state.transform, x, y, w, h);
    }
    this.recordStroke(path);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    if (!allFinite(x, y, w, h)) return;
    const clip = this.state.clip;
    this.ops.push({
      kind: "clear",
      id: this.newId(),
      transform: this.state.transform,
      rect: { x, y, width: w, height: h },
      ...(clip.length > 0 ? { clip } : {}),
      ...this.groupField(),
    });
  }

  // --- Paints ---

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): RecordingGradient {
    return createLinearGradient(x0, y0, x1, y1);
  }

  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): RecordingGradient {
    return createRadialGradient(x0, y0, r0, x1, y1, r1);
  }

  createConicGradient(startAngle: number, x: number, y: number): RecordingGradient {
    return createConicGradient(startAngle, x, y);
  }

  /** A pattern of the image; null when the image has no pixels yet, as in the spec. */
  createPattern(image: unknown, repetition: string | null): RecordingPattern | null {
    const ref = this.describeImage(image);
    const rep = parseRepetition(repetition);
    return ref === null ? null : new RecordingPattern(ref, rep);
  }

  // --- Images ---

  drawImage(image: unknown, dx: number, dy: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(image: unknown, ...args: number[]): void {
    if (args.length !== 2 && args.length !== 4 && args.length !== 8) {
      throw new TypeError(`drawImage() takes 3, 5 or 9 arguments, not ${args.length + 1}.`);
    }
    const ref = this.describeImage(image);
    if (ref === null || !allFinite(...args)) return;
    let source;
    let dest;
    if (args.length === 8) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number];
      source = normalizeRect(sx, sy, sw, sh);
      dest = normalizeRect(dx, dy, dw, dh);
    } else {
      const [dx, dy, dw = ref.width, dh = ref.height] = args as [number, number, number?, number?];
      source = { x: 0, y: 0, width: ref.width, height: ref.height };
      dest = normalizeRect(dx, dy, dw, dh);
    }
    if (source.width === 0 || source.height === 0 || dest.width === 0 || dest.height === 0) return;
    this.ops.push({
      kind: "image",
      ...this.opBase(),
      image: ref,
      source,
      dest,
      smoothing: { enabled: this.state.imageSmoothingEnabled, quality: this.state.imageSmoothingQuality },
    });
  }

  // --- Text ---

  measureText(text: string): TextMeasure {
    return this.measurer(String(text), this.state.text);
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.recordText("fill", text, x, y, maxWidth);
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.recordText("stroke", text, x, y, maxWidth);
  }

  // --- Not supported ---

  getImageData(): never {
    throw new UnsupportedCanvasCallError("getImageData");
  }
  putImageData(): never {
    throw new UnsupportedCanvasCallError("putImageData");
  }
  createImageData(): never {
    throw new UnsupportedCanvasCallError("createImageData");
  }

  // --- Internals ---

  private applyTransform(m: Matrix2D): void {
    this.state.transform = multiply(this.state.transform, m);
  }

  /** The value a style property takes, or null when the assignment is ignored. */
  private style(value: unknown, property: string): StyleValue | null {
    if (value instanceof RecordingGradient || value instanceof RecordingPattern) return value;
    if (typeof value === "object" && value !== null) {
      throw new UnsupportedCanvasCallError(`${property} set to a gradient or pattern from another context`);
    }
    return canvasColor(String(value));
  }

  private paintOf(style: StyleValue): Paint {
    return typeof style === "string" ? style : style.snapshot();
  }

  private setText(change: Partial<TextStyle>): void {
    this.state.text = { ...this.state.text, ...change };
  }

  /** A Path2D's calls replayed under the current transform. */
  private pathFrom(path: RecordingPath2D): PathBuilder {
    if (!(path instanceof RecordingPath2D)) {
      throw new UnsupportedCanvasCallError("a Path2D created outside CanvasIR (use RecordingPath2D)");
    }
    const builder = new PathBuilder();
    path.applyTo(builder, this.state.transform);
    return builder;
  }

  /** Op fields for a query that records nothing: no id is used up, and clipping is left out. */
  private probeBase(): { id: string; transform: Matrix2D; compositing: Compositing } {
    return { id: "probe", transform: this.state.transform, compositing: this.compositing() };
  }

  /** The fields every painting op shares. */
  private opBase(): { id: string; transform: Matrix2D; compositing: Compositing; clip?: readonly ClipPath[]; group?: string } {
    const clip = this.state.clip;
    return {
      id: this.newId(),
      transform: this.state.transform,
      compositing: this.compositing(),
      ...(clip.length > 0 ? { clip } : {}),
      ...this.groupField(),
    };
  }

  private groupField(): { group?: string } {
    const group = this.groupStack[this.groupStack.length - 1];
    return group !== undefined ? { group } : {};
  }

  private recordText(mode: "fill" | "stroke", text: string, x: number, y: number, maxWidth?: number): void {
    if (!allFinite(x, y) || (maxWidth !== undefined && !(maxWidth > 0 && Number.isFinite(maxWidth)))) return;
    const value = String(text);
    const metrics = this.measurer(value, this.state.text);
    this.ops.push({
      kind: "text",
      ...this.opBase(),
      mode,
      text: value,
      x,
      y,
      ...(maxWidth !== undefined ? { maxWidth } : {}),
      style: this.state.text,
      paint: this.paintOf(mode === "fill" ? this.state.fillStyle : this.state.strokeStyle),
      ...(mode === "stroke" ? { stroke: this.strokeStyleSnapshot() } : {}),
      metrics,
    });
  }

  private compositing(): Compositing {
    const s = this.state;
    return {
      globalAlpha: s.globalAlpha,
      globalCompositeOperation: s.globalCompositeOperation,
      filter: s.filter,
      shadowColor: s.shadowColor,
      shadowBlur: s.shadowBlur,
      shadowOffsetX: s.shadowOffsetX,
      shadowOffsetY: s.shadowOffsetY,
    };
  }

  private strokeStyleSnapshot(): StrokeStyle {
    const s = this.state;
    return {
      paint: this.paintOf(s.strokeStyle),
      lineWidth: s.lineWidth,
      lineCap: s.lineCap,
      lineJoin: s.lineJoin,
      miterLimit: s.miterLimit,
      lineDash: [...s.lineDash],
      lineDashOffset: s.lineDashOffset,
    };
  }

  private recordFill(builder: PathBuilder, fillRule: FillRule): void {
    const path = builder.snapshot();
    if (path.subpaths.length === 0) return;
    this.ops.push({ kind: "fill", ...this.opBase(), fillRule, paint: this.paintOf(this.state.fillStyle), path });
  }

  private recordStroke(builder: PathBuilder): void {
    const path = builder.snapshot();
    if (path.subpaths.length === 0) return;
    this.ops.push({ kind: "stroke", ...this.opBase(), stroke: this.strokeStyleSnapshot(), path });
  }

  private newId(): string {
    const id = `o${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}
