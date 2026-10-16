import { IDENTITY, allFinite, multiply } from "./math";
import { PathBuilder } from "./path";
import type {
  Compositing,
  FillRule,
  IRDocument,
  LineCap,
  LineJoin,
  Matrix2D,
  Op,
  Paint,
  StrokeStyle,
} from "./types";

interface DrawingState {
  transform: Matrix2D;
  fillStyle: Paint;
  strokeStyle: Paint;
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
}

const defaultState = (): DrawingState => ({
  transform: IDENTITY,
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
});

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
}

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
  private state: DrawingState = defaultState();
  private stack: DrawingState[] = [];
  private readonly path = new PathBuilder();

  constructor(options: RecordingContextOptions = {}) {
    this.canvas = { width: options.width ?? 300, height: options.height ?? 150 };
  }

  getDocument(): IRDocument {
    return { version: 1, ops: [...this.ops] };
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
    this.state = defaultState();
    this.stack = [];
    this.path.reset();
  }

  get fillStyle(): Paint {
    return this.state.fillStyle;
  }
  set fillStyle(value: Paint) {
    this.state.fillStyle = this.paint(value, "fillStyle");
  }

  get strokeStyle(): Paint {
    return this.state.strokeStyle;
  }
  set strokeStyle(value: Paint) {
    this.state.strokeStyle = this.paint(value, "strokeStyle");
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
    this.state.shadowColor = String(value);
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

  closePath(): void {
    this.path.closePath();
  }

  // --- Drawing ---

  fill(fillRule?: FillRule): void {
    if (typeof fillRule === "object") throw new UnsupportedCanvasCallError("fill(Path2D)");
    this.recordFill(this.path, parseFillRule(fillRule));
  }

  stroke(path?: unknown): void {
    if (path !== undefined) throw new UnsupportedCanvasCallError("stroke(Path2D)");
    this.recordStroke(this.path);
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
    this.ops.push({
      kind: "clear",
      id: this.newId(),
      transform: this.state.transform,
      rect: { x, y, width: w, height: h },
    });
  }

  // --- Not yet supported ---

  clip(): never {
    throw new UnsupportedCanvasCallError("clip");
  }
  isPointInPath(): never {
    throw new UnsupportedCanvasCallError("isPointInPath");
  }
  isPointInStroke(): never {
    throw new UnsupportedCanvasCallError("isPointInStroke");
  }
  roundRect(): never {
    throw new UnsupportedCanvasCallError("roundRect");
  }
  fillText(): never {
    throw new UnsupportedCanvasCallError("fillText");
  }
  strokeText(): never {
    throw new UnsupportedCanvasCallError("strokeText");
  }
  measureText(): never {
    throw new UnsupportedCanvasCallError("measureText");
  }
  drawImage(): never {
    throw new UnsupportedCanvasCallError("drawImage");
  }
  createLinearGradient(): never {
    throw new UnsupportedCanvasCallError("createLinearGradient");
  }
  createRadialGradient(): never {
    throw new UnsupportedCanvasCallError("createRadialGradient");
  }
  createConicGradient(): never {
    throw new UnsupportedCanvasCallError("createConicGradient");
  }
  createPattern(): never {
    throw new UnsupportedCanvasCallError("createPattern");
  }
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

  private paint(value: unknown, property: string): Paint {
    if (typeof value === "string") return value;
    throw new UnsupportedCanvasCallError(`${property} set to a gradient or pattern`);
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
      paint: s.strokeStyle,
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
    this.ops.push({
      kind: "fill",
      id: this.newId(),
      transform: this.state.transform,
      compositing: this.compositing(),
      fillRule,
      paint: this.state.fillStyle,
      path,
    });
  }

  private recordStroke(builder: PathBuilder): void {
    const path = builder.snapshot();
    if (path.subpaths.length === 0) return;
    this.ops.push({
      kind: "stroke",
      id: this.newId(),
      transform: this.state.transform,
      compositing: this.compositing(),
      stroke: this.strokeStyleSnapshot(),
      path,
    });
  }

  private newId(): string {
    const id = `o${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}
