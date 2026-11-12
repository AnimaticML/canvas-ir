// Connectors: arrows that hold on to what they join. Each end is attached to something on the board (a note, a
// drawing, content, a window, an icon) or left loose at a point; when what an end holds moves, the arrow is drawn
// again from edge to edge, keeping its bow, its color and its hand-drawn wobble. A ring is a connector with one end:
// a loop drawn around what it holds, to point it out.
//
// A connector keeps all it needs in its group's meta, so it is saved, exported and restored like any other drawing.
import type { JsonValue, RecordingContext } from "canvas-ir";

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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
}

/** How far from an attached thing's edge an end stops. */
const GAP = 16;

/** Where a line from inside a box toward `toward` leaves the box, `gap` past its edge. */
export const edgePoint = (box: Box, toward: Point, gap = GAP): Point => {
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

const center = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * Where an arrow's ends are drawn: each attached end on its thing's edge, facing the other end along the bow, and a
 * loose one where it is. `boxOf` gives an attached thing's box, or null when it isn't on the board now.
 */
export const route = (c: Connector, boxOf: (key: string) => Box | null): { from: Point; to: Point } => {
  const a = c.from.key ? boxOf(c.from.key) : null;
  const b = c.to?.key ? boxOf(c.to.key) : null;
  const from0 = a ? center(a) : c.from;
  const to0 = b ? center(b) : (c.to ?? c.from);
  // The bow's control point, from the middles: each end leaves its box toward it, so the curve meets the edge square on.
  const control = bow(from0, to0, c.bend);
  return { from: a ? edgePoint(a, control) : from0, to: b ? edgePoint(b, control) : to0 };
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

/** Draws an arrow from `from` to `to`, bowed, with its head and its word. */
export const drawArrow = (ctx: RecordingContext, from: Point, to: Point, c: Pick<Connector, "bend" | "color" | "word" | "seed">): void => {
  const r = wobble(c.seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const k = bow(from, to, c.bend);
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Wobble scales down on short arrows, so they don't look shaky.
  const w = Math.min(1, length / 300);
  ctx.moveTo(from.x + r() * 6 * w, from.y + r() * 6 * w);
  ctx.quadraticCurveTo(k.x + r() * 20 * w, k.y + r() * 20 * w, to.x, to.y);
  ctx.stroke();
  const angle = Math.atan2(to.y - k.y, to.x - k.x);
  const head = Math.min(34, length / 3);
  ctx.beginPath();
  ctx.moveTo(to.x - head * Math.cos(angle - 0.45), to.y - head * Math.sin(angle - 0.45));
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle + 0.45), to.y - head * Math.sin(angle + 0.45));
  ctx.stroke();
  if (c.word) {
    // The word sits on the bow, beside the line.
    const mx = (from.x + 2 * k.x + to.x) / 4;
    const my = (from.y + 2 * k.y + to.y) / 4;
    const side = c.bend < 0 ? -1 : 1;
    ctx.font = `700 italic 34px ${FONT}`;
    // Off the line on the bow's outer side, far enough that the word's box clears it whichever way the line runs.
    const nx = (-dy / length) * side;
    const ny = (dx / length) * side;
    const half = ctx.measureText(c.word).width / 2;
    const off = 14 + Math.abs(nx) * half + Math.abs(ny) * 20;
    ctx.fillStyle = c.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.word, mx + nx * off, my + ny * off);
    ctx.textAlign = "start";
  }
};

/** Draws a loose loop around a box. */
export const drawRing = (ctx: RecordingContext, box: Box, c: Pick<Connector, "color" | "seed">): void => {
  const r = wobble(c.seed);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + 40;
  const ry = box.height / 2 + 40;
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
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
