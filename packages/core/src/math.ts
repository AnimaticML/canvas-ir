import type { Matrix2D, Point } from "./types";

export const IDENTITY: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Returns `m * n`: `n` is applied first, then `m`, as Canvas composes transforms. */
export const multiply = (m: Matrix2D, n: Matrix2D): Matrix2D => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

export const applyToPoint = (m: Matrix2D, x: number, y: number): Point => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
});

export const sameMatrix = (m: Matrix2D, n: Matrix2D): boolean =>
  m.a === n.a && m.b === n.b && m.c === n.c && m.d === n.d && m.e === n.e && m.f === n.f;

export const allFinite = (...values: number[]): boolean => {
  // A loop rather than `every`: this runs for every point drawn.
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
};

export const invert = (m: Matrix2D): Matrix2D | null => {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
};

/** The point at `angle` on an ellipse, in the ellipse's own (pre-transform) coordinates. */
export const ellipsePoint = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  angle: number,
): Point => {
  const px = rx * Math.cos(angle);
  const py = ry * Math.sin(angle);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
};
