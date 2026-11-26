// Connectors: arrows that hold on to what they join. Each end is attached to something on the board (a note, a
// drawing, content, a window, an icon) or left loose at a point; when what an end holds moves, the arrow is drawn
// again from edge to edge, keeping its bow, its color and its hand-drawn wobble. A ring is a connector with one end:
// a loop drawn around what it holds, to point it out.
//
// Beside the hand-drawn look there is a clean one, for diagrams: an even line, straight, curved or in right angles, dashed
// or not, with a head (and a tail) open, filled or a dot, and its word as a label on the line.
//
// A connector keeps all it needs in its group's meta, so it is saved, exported and restored like any other drawing.
import type { JsonValue, Point, RecordingContext, Rect } from "canvas-ir";


/**
 * One end: what it holds, by a key the board resolves to a box ("icon:map", "content:Badge", "window:table",
 * "board:<group id>"), and where it was last drawn, which is where a loose end stays and where an end whose thing is
 * gone is left.
 */
export interface End {
  readonly key?: string;
  readonly x: number;
  readonly y: number;
}

/** What an arrow ends in. */
export type ArrowEnd = "open" | "filled" | "dot" | "none";

export interface ConnectorStyle {
  /** Hand-drawn, wobbling and thick (the default), or clean: even and thin, for diagrams. */
  readonly look?: "hand" | "clean";
  /** A bowed curve (the default), a straight line, or right angles with rounded corners. */
  readonly path?: "curve" | "straight" | "elbow";
  /** Line width; 7 by hand, 2 clean. */
  readonly width?: number;
  /** Dashes and gaps, as for `setLineDash`. */
  readonly dash?: readonly number[];
  /** What the arrow ends in at `to`: open by default. */
  readonly head?: ArrowEnd;
  /** What it ends in at `from`: nothing by default. */
  readonly tail?: ArrowEnd;
  /** How far from a held thing's edge an end stops; 16 by hand, 6 clean. */
  readonly gap?: number;
  /** The word's size in pixels; 34 by hand, 13 clean. */
  readonly labelSize?: number;
  readonly labelColor?: string;
  /** Behind a clean label, which sits on the line: white by default. */
  readonly labelBackground?: string;
}

export interface Connector {
  readonly kind: "arrow" | "ring";
  readonly from: End;
  /** The arrow's head; a ring has none. */
  readonly to?: End;
  /** How far the arrow bows to its left, as a share of its length; negative bows it right. */
  readonly bend: number;
  readonly color: string;
  /** A word written on the bow. */
  readonly word?: string;
  /** Seeds the wobble, so an arrow is drawn the same way each time. */
  readonly seed: number;
  /** How it looks; omitted, hand-drawn. */
  readonly style?: ConnectorStyle;
}

const clean = (c: { style?: ConnectorStyle }): boolean => c.style?.look === "clean";
const gapOf = (c: { style?: ConnectorStyle }): number => c.style?.gap ?? (clean(c) ? 6 : GAP);

/** How far from an attached thing's edge an end stops. */
const GAP = 16;

/** Where a line from inside a box toward `toward` leaves the box, `gap` past its edge. */
export const edgePoint = (box: Rect, toward: Point, gap = GAP): Point => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // The share of the way to `toward` at which the line crosses the nearer of the box's sides.
  const tx = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  const length = Math.hypot(dx, dy);
  return { x: cx + dx * t + (dx / length) * gap, y: cy + dy * t + (dy / length) * gap };
};

const center = (b: Rect): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * Where an arrow's ends are drawn: each attached end on its thing's edge, facing the other end along the bow, and a
 * loose one where it is. `boxOf` gives an attached thing's box, or null when it isn't on the board now.
 */
export const route = (c: Connector, boxOf: (key: string) => Rect | null): { from: Point; to: Point; across?: boolean } => {
  const a = c.from.key ? boxOf(c.from.key) : null;
  const b = c.to?.key ? boxOf(c.to.key) : null;
  const from0 = a ? center(a) : c.from;
  const to0 = b ? center(b) : (c.to ?? c.from);
  const gap = gapOf(c);
  const path = c.style?.path ?? "curve";
  if (path === "elbow") {
    // Each end leaves the middle of the side facing the other, along whichever axis they are further apart on.
    const across = Math.abs(to0.x - from0.x) >= Math.abs(to0.y - from0.y);
    const side = (box: Rect, toward: Point): Point => {
      const c = center(box);
      return across
        ? { x: toward.x > c.x ? box.x + box.width + gap : box.x - gap, y: c.y }
        : { x: c.x, y: toward.y > c.y ? box.y + box.height + gap : box.y - gap };
    };
    return { from: a ? side(a, to0) : from0, to: b ? side(b, from0) : to0, across };
  }
  // The bow's control point, from the middles: each end leaves its box toward it, so the curve meets the edge square on.
  const control = bow(from0, to0, path === "straight" ? 0 : c.bend);
  return { from: a ? edgePoint(a, control, gap) : from0, to: b ? edgePoint(b, control, gap) : to0 };
};

/**
 * The corners of a right-angled path from `from` to `to`, leaving across (horizontally) or down, and turning halfway.
 * Unsaid, along the axis they are further apart on.
 */
const elbow = (from: Point, to: Point, across = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)): Point[] => {
  if (across) {
    const mx = (from.x + to.x) / 2;
    return [from, { x: mx, y: from.y }, { x: mx, y: to.y }, to];
  }
  const my = (from.y + to.y) / 2;
  return [from, { x: from.x, y: my }, { x: to.x, y: my }, to];
};

/**
 * The line an arrow is drawn along: a quadratic curve through `k`, or a polyline. With where its word goes, and the
 * direction it arrives at each end.
 */
export const arrowPath = (
  from: Point,
  to: Point,
  c: Pick<Connector, "bend" | "style">,
  across?: boolean,
): { curve: Point | null; points: Point[]; middle: Point; headAngle: number; tailAngle: number } => {
  const path = c.style?.path ?? "curve";
  if (path === "elbow") {
    const points = elbow(from, to, across);
    const [p0, p1, p2, p3] = points as [Point, Point, Point, Point];
    // Degenerate legs (ends level with each other) fall back to the next point that differs.
    const last = p2.x === p3.x && p2.y === p3.y ? p1 : p2;
    const first = p1.x === p0.x && p1.y === p0.y ? p2 : p1;
    return {
      curve: null,
      points,
      middle: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      headAngle: Math.atan2(p3.y - last.y, p3.x - last.x),
      tailAngle: Math.atan2(p0.y - first.y, p0.x - first.x),
    };
  }
  if (path === "straight") {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    return { curve: null, points: [from, to], middle: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, headAngle: a, tailAngle: a + Math.PI };
  }
  const k = bow(from, to, c.bend);
  return {
    curve: k,
    points: [from, to],
    middle: { x: (from.x + 2 * k.x + to.x) / 4, y: (from.y + 2 * k.y + to.y) / 4 },
    headAngle: Math.atan2(to.y - k.y, to.x - k.x),
    tailAngle: Math.atan2(from.y - k.y, from.x - k.x),
  };
};

/** Draws what an arrow ends in at `at`, arriving at `angle`. */
const drawEnd = (ctx: RecordingContext, kind: ArrowEnd, at: Point, angle: number, size: number, color: string): void => {
  if (kind === "none") return;
  ctx.setLineDash([]);
  if (kind === "dot") {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(at.x, at.y, size / 2.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const spread = kind === "filled" ? 0.4 : 0.45;
  ctx.beginPath();
  ctx.moveTo(at.x - size * Math.cos(angle - spread), at.y - size * Math.sin(angle - spread));
  ctx.lineTo(at.x, at.y);
  ctx.lineTo(at.x - size * Math.cos(angle + spread), at.y - size * Math.sin(angle + spread));
  if (kind === "filled") {
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  } else ctx.stroke();
};

/** The control point that bows a line from `a` to `b` to its left by `bend` of its length. */
const bow = (a: Point, b: Point, bend: number): Point => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: a.x + dx / 2 - (dy / length) * bend * length, y: a.y + dy / 2 + (dx / length) * bend * length };
};

/** A small random but repeatable wobble, so lines look drawn by hand. */
export const wobble = (seed: number) => {
  let s = Math.max(1, Math.floor(seed)) % 2147483647;
  return (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
};

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * Draws an arrow from `from` to `to`, along its path, with its head, its tail and its word. `across` is `route`'s, so a
 * right-angled arrow leaves its ends the way they face.
 */
export const drawArrow = (
  ctx: RecordingContext,
  from: Point,
  to: Point,
  c: Pick<Connector, "bend" | "color" | "word" | "seed" | "style">,
  across?: boolean,
): void => {
  const style = c.style ?? {};
  const isClean = clean(c);
  const r = wobble(c.seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const path = arrowPath(from, to, c, across);
  const width = style.width ?? (isClean ? 2 : 7);
  ctx.strokeStyle = c.color;
  ctx.lineWidth = width;
  ctx.lineCap = isClean ? "butt" : "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(style.dash ? [...style.dash] : []);
  ctx.beginPath();
  if (path.curve) {
    // Wobble scales down on short arrows, so they don't look shaky; a clean arrow has none.
    const w = isClean ? 0 : Math.min(1, length / 300);
    ctx.moveTo(from.x + r() * 6 * w, from.y + r() * 6 * w);
    ctx.quadraticCurveTo(path.curve.x + r() * 20 * w, path.curve.y + r() * 20 * w, to.x, to.y);
  } else {
    const [first, ...rest] = path.points as [Point, ...Point[]];
    ctx.moveTo(first.x, first.y);
    // Corners rounded, no more than half the shorter leg beside them.
    for (let i = 0; i < rest.length - 1; i++) {
      const p = rest[i]!;
      const prev = path.points[i]!;
      const next = rest[i + 1]!;
      const radius = Math.min(isClean ? 10 : 18, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
      if (radius > 0.5) ctx.arcTo(p.x, p.y, next.x, next.y, radius);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
  const size = isClean ? Math.min(Math.max(10, width * 5), length / 3) : Math.min(34, length / 3);
  drawEnd(ctx, style.head ?? "open", to, path.headAngle, size, c.color);
  drawEnd(ctx, style.tail ?? "none", from, path.tailAngle, size, c.color);
  if (c.word) {
    const color = style.labelColor ?? c.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (isClean) {
      // On the line, over a pill that hides it.
      const px = style.labelSize ?? 13;
      ctx.font = `500 ${px}px ${FONT}`;
      const tw = ctx.measureText(c.word).width;
      ctx.fillStyle = style.labelBackground ?? "#ffffff";
      ctx.beginPath();
      ctx.roundRect(path.middle.x - tw / 2 - 6, path.middle.y - px / 2 - 4, tw + 12, px + 8, (px + 8) / 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(c.word, path.middle.x, path.middle.y);
    } else {
      // The word sits on the bow, beside the line, off it on the bow's outer side, far enough that the word's box clears it whichever way the line runs.
      const side = c.bend < 0 ? -1 : 1;
      ctx.font = `700 italic ${style.labelSize ?? 34}px ${FONT}`;
      const nx = (-dy / length) * side;
      const ny = (dx / length) * side;
      const half = ctx.measureText(c.word).width / 2;
      const off = 14 + Math.abs(nx) * half + Math.abs(ny) * 20;
      ctx.fillStyle = color;
      ctx.fillText(c.word, path.middle.x + nx * off, path.middle.y + ny * off);
    }
    ctx.textAlign = "start";
  }
};

/** Draws a loose loop around a box. */
export const drawRing = (ctx: RecordingContext, box: Rect, c: Pick<Connector, "color" | "seed" | "style">): void => {
  const r = wobble(c.seed);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + 40;
  const ry = box.height / 2 + 40;
  ctx.strokeStyle = c.color;
  ctx.lineWidth = c.style?.width ?? 6;
  ctx.lineCap = "round";
  ctx.setLineDash(c.style?.dash ? [...c.style.dash] : []);
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * 1.12 * Math.PI * 2 - 2.2;
    const k = 1 + r() * 0.03 + i * 0.0015;
    ctx.lineTo(cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k);
  }
  ctx.stroke();
};

/** A connector as group meta, and back. */
export const toMeta = (c: Connector): JsonValue => JSON.parse(JSON.stringify(c)) as JsonValue;
export const fromMeta = (meta: { readonly [key: string]: JsonValue } | undefined): Connector | null => {
  const c = meta?.connector as unknown as Connector | undefined;
  return c && (c.kind === "arrow" || c.kind === "ring") && typeof c.from?.x === "number" ? c : null;
};
