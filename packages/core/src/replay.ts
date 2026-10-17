import { IDENTITY, multiply, sameMatrix } from "./math";
import type {
  Group,
  JsonValue,
  ClipPath,
  Compositing,
  FillRule,
  IRDocument,
  Matrix2D,
  Op,
  Paint,
  PathGeometry,
  Segment,
  StrokeStyle,
  TextStyle,
} from "./types";

interface GradientLike {
  addColorStop(offset: number, color: string): void;
}

interface PatternLike {
  setTransform(transform?: { a: number; b: number; c: number; d: number; e: number; f: number }): void;
}

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
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
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
  clip(fillRule?: FillRule): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GradientLike;
  createConicGradient(startAngle: number, x: number, y: number): GradientLike;
  // The image types differ between a browser context and RecordingContext, so they stay loose here.
  createPattern(image: never, repetition: string | null): PatternLike | null;
  drawImage(image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  font: string;
  textAlign: string;
  textBaseline: string;
  direction: string;
}

export interface ReplayOptions {
  /** Applied on top of every recorded transform, e.g. a viewport's pan and zoom. */
  readonly view?: Matrix2D;
  /**
   * Resolves an image reference (`ImageRef.src`) to something the target can
   * draw. Image ops and pattern paints whose image doesn't resolve are skipped.
   */
  readonly images?: (src: string) => unknown;
}

const setMatrix = (target: ReplayTarget, m: Matrix2D): void => {
  target.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
};

const applyCompositing = (target: ReplayTarget, compositing: Compositing): void => {
  target.globalAlpha = compositing.globalAlpha;
  target.globalCompositeOperation = compositing.globalCompositeOperation;
  // Chromium composites differently once `filter` has been assigned, even "none".
  if (target.filter !== compositing.filter) target.filter = compositing.filter;
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
    case "arc":
      target.arc(
        segment.center.x,
        segment.center.y,
        segment.radius,
        segment.startAngle,
        segment.endAngle,
        segment.counterclockwise,
      );
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

/**
 * Rebuilds the path, switching the transform only where the recorded matrix
 * changes, then sets the paint transform. Returns nothing; the target is left
 * with `paintMatrix` as its transform.
 *
 * The paint transform is set only if it differs from the last path matrix:
 * Chromium rasterizes a path differently once the transform has changed after
 * the path was built, even back to an equal matrix, so a redundant
 * `setTransform` would break pixel equality with direct drawing.
 */
const replayPath = (target: ReplayTarget, path: PathGeometry, paintMatrix: Matrix2D, view: Matrix2D): void => {
  const world = path.matrices.map((m) => multiply(view, m));
  let active: Matrix2D | null = null;
  const use = (m: Matrix2D): void => {
    if (active !== null && sameMatrix(active, m)) return;
    setMatrix(target, m);
    active = m;
  };
  // Set the first matrix before beginPath, as direct drawing usually does.
  use(world[path.subpaths[0]!.m]!);
  target.beginPath();
  for (const subpath of path.subpaths) {
    const first = subpath.segments[0]?.kind;
    if (!(subpath.startImplied && (first === "arc" || first === "ellipse"))) {
      use(world[subpath.m]!);
      target.moveTo(subpath.start.x, subpath.start.y);
    }
    for (const segment of subpath.segments) {
      use(world[segment.m]!);
      replaySegment(target, segment);
    }
    if (subpath.closed) target.closePath();
  }
  use(paintMatrix);
};

/** The target's paint for a recorded paint, or null when its image can't be resolved. */
const toPaint = (target: ReplayTarget, paint: Paint, options: ReplayOptions): unknown => {
  if (typeof paint === "string") return paint;
  if (paint.kind === "pattern") {
    const image = options.images?.(paint.image.src);
    if (image === undefined || image === null) return null;
    const pattern = target.createPattern(image as never, paint.repetition);
    if (pattern === null) return null;
    pattern.setTransform({ ...paint.transform });
    return pattern;
  }
  const gradient =
    paint.kind === "linear"
      ? target.createLinearGradient(paint.x0, paint.y0, paint.x1, paint.y1)
      : paint.kind === "radial"
        ? target.createRadialGradient(paint.x0, paint.y0, paint.r0, paint.x1, paint.y1, paint.r1)
        : target.createConicGradient(paint.startAngle, paint.x, paint.y);
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
};

const applyStroke = (target: ReplayTarget, stroke: StrokeStyle): void => {
  target.lineWidth = stroke.lineWidth;
  target.lineCap = stroke.lineCap;
  target.lineJoin = stroke.lineJoin;
  target.miterLimit = stroke.miterLimit;
  target.setLineDash([...stroke.lineDash]);
  target.lineDashOffset = stroke.lineDashOffset;
};

/** Sets only the text properties that differ, and only those the target has. */
const applyText = (target: ReplayTarget, style: TextStyle): void => {
  const t = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(style)) {
    if (key in t && t[key] !== value) t[key] = value;
  }
};

const applyClip = (target: ReplayTarget, clip: readonly ClipPath[] | undefined, view: Matrix2D): void => {
  for (const region of clip ?? []) {
    replayPath(target, region.path, multiply(view, region.transform), view);
    target.clip(region.fillRule);
  }
};

export const replayOp = (target: ReplayTarget, op: Op, options: ReplayOptions = {}): void => {
  const view = options.view ?? IDENTITY;
  const transform = multiply(view, op.transform);
  // Resolve image-backed paints first, so an op that can't be drawn changes nothing.
  let paint: unknown = null;
  if (op.kind === "fill" || op.kind === "text") paint = toPaint(target, op.paint, options);
  if (op.kind === "stroke") paint = toPaint(target, op.stroke.paint, options);
  if (op.kind !== "clear" && op.kind !== "embed" && op.kind !== "image" && paint === null) return;
  const image = op.kind === "image" ? options.images?.(op.image.src) : undefined;
  if (op.kind === "image" && (image === undefined || image === null)) return;

  target.save();
  applyClip(target, op.clip, view);
  switch (op.kind) {
    case "clear":
      setMatrix(target, transform);
      target.clearRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
      break;
    case "embed":
      setMatrix(target, transform);
      // A recorder records the embed itself; a canvas gets the hole the element shows through.
      if (hasEmbeds(target)) target.embed(op.rect.x, op.rect.y, op.rect.width, op.rect.height, op.content as { [key: string]: JsonValue });
      else target.clearRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
      break;
    case "fill":
      applyCompositing(target, op.compositing);
      target.fillStyle = paint;
      replayPath(target, op.path, transform, view);
      target.fill(op.fillRule);
      break;
    case "stroke":
      applyCompositing(target, op.compositing);
      target.strokeStyle = paint;
      applyStroke(target, op.stroke);
      replayPath(target, op.path, transform, view);
      target.stroke();
      break;
    case "image": {
      applyCompositing(target, op.compositing);
      target.imageSmoothingEnabled = op.smoothing.enabled;
      target.imageSmoothingQuality = op.smoothing.quality;
      setMatrix(target, transform);
      const { source: s, dest: d } = op;
      target.drawImage(image as never, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
      break;
    }
    case "text":
      applyCompositing(target, op.compositing);
      applyText(target, op.style);
      setMatrix(target, transform);
      if (op.mode === "fill") {
        target.fillStyle = paint;
        if (op.maxWidth === undefined) target.fillText(op.text, op.x, op.y);
        else target.fillText(op.text, op.x, op.y, op.maxWidth);
      } else {
        target.strokeStyle = paint;
        applyStroke(target, op.stroke!);
        if (op.maxWidth === undefined) target.strokeText(op.text, op.x, op.y);
        else target.strokeText(op.text, op.x, op.y, op.maxWidth);
      }
      break;
  }
  target.restore();
};

const hasEmbeds = (target: unknown): target is { embed(x: number, y: number, w: number, h: number, content: { [key: string]: JsonValue }): string } =>
  typeof (target as { embed?: unknown }).embed === "function";

interface GroupTarget {
  beginGroup(options: { id?: string; meta?: { [key: string]: JsonValue } }): string;
  endGroup(): void;
}

const hasGroups = (target: unknown): target is GroupTarget =>
  typeof (target as Partial<GroupTarget>).beginGroup === "function" && typeof (target as Partial<GroupTarget>).endGroup === "function";

/**
 * Replays every op in order. A target that records groups (a `RecordingContext`)
 * gets them too, each opened before its first op; groups with no ops are dropped.
 */
export const replayDocument = (target: ReplayTarget, document: IRDocument, options: ReplayOptions = {}): void => {
  const groups = new Map((document.groups ?? []).map((g) => [g.id, g]));
  const chain = (id: string | undefined): Group[] => {
    const out: Group[] = [];
    for (let g = id === undefined ? undefined : groups.get(id); g; g = g.parent === undefined ? undefined : groups.get(g.parent)) out.unshift(g);
    return out;
  };
  const open: string[] = [];
  const opened = new Set<string>();
  const grouped = hasGroups(target) && groups.size > 0;
  for (const op of document.ops) {
    if (grouped) {
      const want = chain(op.group);
      let keep = 0;
      while (keep < open.length && keep < want.length && open[keep] === want[keep]!.id) keep++;
      while (open.length > keep) {
        target.endGroup();
        open.pop();
      }
      for (const g of want.slice(keep)) {
        // Meta goes with the first opening only; later ones add to the same group.
        target.beginGroup({ id: g.id, ...(g.meta && !opened.has(g.id) ? { meta: g.meta } : {}) });
        opened.add(g.id);
        open.push(g.id);
      }
    }
    replayOp(target, op, options);
  }
  if (grouped) for (let i = 0; i < open.length; i++) target.endGroup();
};
