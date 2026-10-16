import { IDENTITY, multiply } from "./math";
import type { Compositing, FillRule, IRDocument, Matrix2D, Op, PathGeometry, Segment } from "./types";

/**
 * The Canvas calls replay makes. A browser `CanvasRenderingContext2D` or
 * `OffscreenCanvasRenderingContext2D` satisfies it as is, and so does
 * `RecordingContext`.
 */
export interface ReplayTarget {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  lineDashOffset: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: number[]): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  closePath(): void;
  fill(fillRule?: FillRule): void;
  stroke(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface ReplayOptions {
  /** Applied on top of every recorded transform, e.g. a viewport's pan and zoom. */
  readonly view?: Matrix2D;
}

const setMatrix = (target: ReplayTarget, m: Matrix2D): void => {
  target.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
};

const applyCompositing = (target: ReplayTarget, compositing: Compositing): void => {
  target.globalAlpha = compositing.globalAlpha;
  target.globalCompositeOperation = compositing.globalCompositeOperation;
  target.filter = compositing.filter;
  target.shadowColor = compositing.shadowColor;
  target.shadowBlur = compositing.shadowBlur;
  target.shadowOffsetX = compositing.shadowOffsetX;
  target.shadowOffsetY = compositing.shadowOffsetY;
};

const replaySegment = (target: ReplayTarget, segment: Segment): void => {
  switch (segment.kind) {
    case "line":
      target.lineTo(segment.to.x, segment.to.y);
      return;
    case "quad":
      target.quadraticCurveTo(segment.cp.x, segment.cp.y, segment.to.x, segment.to.y);
      return;
    case "cubic":
      target.bezierCurveTo(segment.cp1.x, segment.cp1.y, segment.cp2.x, segment.cp2.y, segment.to.x, segment.to.y);
      return;
    case "ellipse":
      target.ellipse(
        segment.center.x,
        segment.center.y,
        segment.rx,
        segment.ry,
        segment.rotation,
        segment.startAngle,
        segment.endAngle,
        segment.counterclockwise,
      );
      return;
  }
};

/** Rebuilds the path, switching the transform only where the recorded matrix changes. */
const replayPath = (target: ReplayTarget, path: PathGeometry, view: Matrix2D): void => {
  const world = path.matrices.map((m) => multiply(view, m));
  let active = -1;
  const use = (m: number): void => {
    if (m === active) return;
    setMatrix(target, world[m]!);
    active = m;
  };
  target.beginPath();
  for (const subpath of path.subpaths) {
    use(subpath.m);
    target.moveTo(subpath.start.x, subpath.start.y);
    for (const segment of subpath.segments) {
      use(segment.m);
      replaySegment(target, segment);
    }
    if (subpath.closed) target.closePath();
  }
};

export const replayOp = (target: ReplayTarget, op: Op, options: ReplayOptions = {}): void => {
  const view = options.view ?? IDENTITY;
  target.save();
  switch (op.kind) {
    case "clear":
      setMatrix(target, multiply(view, op.transform));
      target.clearRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
      break;
    case "fill":
      applyCompositing(target, op.compositing);
      target.fillStyle = op.paint;
      replayPath(target, op.path, view);
      setMatrix(target, multiply(view, op.transform));
      target.fill(op.fillRule);
      break;
    case "stroke": {
      applyCompositing(target, op.compositing);
      const stroke = op.stroke;
      target.strokeStyle = stroke.paint;
      target.lineWidth = stroke.lineWidth;
      target.lineCap = stroke.lineCap;
      target.lineJoin = stroke.lineJoin;
      target.miterLimit = stroke.miterLimit;
      target.setLineDash([...stroke.lineDash]);
      target.lineDashOffset = stroke.lineDashOffset;
      replayPath(target, op.path, view);
      setMatrix(target, multiply(view, op.transform));
      target.stroke();
      break;
    }
  }
  target.restore();
};

export const replayDocument = (target: ReplayTarget, document: IRDocument, options: ReplayOptions = {}): void => {
  for (const op of document.ops) replayOp(target, op, options);
};
