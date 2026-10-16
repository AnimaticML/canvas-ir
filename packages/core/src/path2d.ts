import { multiply } from "./math";
import { type PathBuilder, indexSizeError } from "./path";
import type { Matrix2D, Point } from "./types";

type Command = (builder: PathBuilder, ctm: Matrix2D) => void;

export interface DOMPointInitLike {
  readonly x?: number;
  readonly y?: number;
}

/** Validates `roundRect` radii as the spec does: null to ignore the call, or four corner radii. */
export const normalizeRadii = (radii: number | DOMPointInitLike | readonly (number | DOMPointInitLike)[]): Point[] | null => {
  const list = Array.isArray(radii) ? radii : [radii];
  if (list.length < 1 || list.length > 4) {
    throw new RangeError(`${list.length} radii provided. Between one and four radii are necessary.`);
  }
  const points: Point[] = [];
  for (const r of list as (number | DOMPointInitLike)[]) {
    const p = typeof r === "number" ? { x: r, y: r } : { x: r.x ?? 0, y: r.y ?? 0 };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < 0 || p.y < 0) throw new RangeError("Radius value is negative.");
    points.push(p);
  }
  const [a, b = a, c = a] = points as [Point, Point?, Point?];
  switch (points.length) {
    case 1:
      return [a, a, a, a];
    case 2:
      return [a, b!, a, b!];
    case 3:
      return [a, b!, c!, b!];
    default:
      return points;
  }
};

/**
 * A recording `Path2D`. It keeps the calls made on it and replays them into the
 * context's path when filled, stroked or clipped, under the transform in effect
 * then, as Canvas does. Use it where drawing code constructs `Path2D` objects
 * (for instance by installing it as `globalThis.Path2D` while recording).
 */
export class RecordingPath2D {
  private readonly commands: Command[] = [];

  constructor(path?: RecordingPath2D | string) {
    if (path instanceof RecordingPath2D) this.commands.push(...path.commands);
    else if (typeof path === "string") parseSvgPath(path, this);
  }

  /** @internal Replays the calls into `builder` under `ctm`. */
  applyTo(builder: PathBuilder, ctm: Matrix2D): void {
    for (const command of this.commands) command(builder, ctm);
  }

  addPath(path: RecordingPath2D, transform?: Partial<Matrix2D>): void {
    if (!(path instanceof RecordingPath2D)) throw new TypeError("addPath() needs a Path2D from CanvasIR.");
    const m: Matrix2D = {
      a: transform?.a ?? 1,
      b: transform?.b ?? 0,
      c: transform?.c ?? 0,
      d: transform?.d ?? 1,
      e: transform?.e ?? 0,
      f: transform?.f ?? 0,
    };
    if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) return;
    const commands = [...path.commands];
    this.commands.push((builder, ctm) => {
      const inner = multiply(ctm, m);
      for (const command of commands) command(builder, inner);
    });
  }

  moveTo(x: number, y: number): void {
    this.commands.push((b, m) => b.moveTo(m, x, y));
  }
  lineTo(x: number, y: number): void {
    this.commands.push((b, m) => b.lineTo(m, x, y));
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.commands.push((b, m) => b.quadraticCurveTo(m, cpx, cpy, x, y));
  }
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.commands.push((b, m) => b.bezierCurveTo(m, cp1x, cp1y, cp2x, cp2y, x, y));
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    if ([x, y, radius, startAngle, endAngle].every(Number.isFinite) && radius < 0) {
      throw indexSizeError(`The radius provided (${radius}) is negative.`);
    }
    this.commands.push((b, m) => b.arc(m, x, y, radius, startAngle, endAngle, counterclockwise));
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if ([x1, y1, x2, y2, radius].every(Number.isFinite) && radius < 0) {
      throw indexSizeError(`The radius provided (${radius}) is negative.`);
    }
    this.commands.push((b, m) => b.arcTo(m, x1, y1, x2, y2, radius));
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
    if ([x, y, radiusX, radiusY, rotation, startAngle, endAngle].every(Number.isFinite) && (radiusX < 0 || radiusY < 0)) {
      throw indexSizeError("The radius provided is negative.");
    }
    this.commands.push((b, m) => b.ellipse(m, x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise));
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.commands.push((b, m) => b.rect(m, x, y, w, h));
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | DOMPointInitLike | readonly (number | DOMPointInitLike)[] = 0,
  ): void {
    if (![x, y, w, h].every(Number.isFinite)) return;
    const corners = normalizeRadii(radii);
    if (corners) this.commands.push((b, m) => b.roundRect(m, x, y, w, h, corners));
  }
  closePath(): void {
    this.commands.push((b) => b.closePath());
  }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Parses SVG path data into calls on `path`, as `new Path2D(d)` does. Arcs are
 * converted from SVG's endpoint form to `ellipse` calls. Parsing stops at the
 * first error, keeping what came before, which is how SVG renders bad data.
 */
export const parseSvgPath = (d: string, path: RecordingPath2D): void => {
  let i = 0;
  const skip = (): void => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const number = (): number | null => {
    skip();
    const m = NUMBER.exec(d.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): boolean | null => {
    skip();
    const c = d[i];
    if (c !== "0" && c !== "1") return null;
    i++;
    return c === "1";
  };
  const hasNumber = (): boolean => {
    skip();
    return NUMBER.test(d.slice(i));
  };

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // The previous segment's control point, for the smooth S and T commands.
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let command = "";

  while (true) {
    skip();
    if (i >= d.length) return;
    const c = d[i]!;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      command = c;
      i++;
    } else if (!command || command === "Z" || command === "z" || !hasNumber()) {
      return;
    } else if (command === "M") {
      command = "L";
    } else if (command === "m") {
      command = "l";
    }
    const rel = command === command.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const read = (count: number): number[] | null => {
      const values: number[] = [];
      for (let k = 0; k < count; k++) {
        const v = number();
        if (v === null) return null;
        values.push(v);
      }
      return values;
    };
    let cubic: Point | null = null;
    let quad: Point | null = null;
    switch (command.toUpperCase()) {
      case "Z":
        path.closePath();
        cx = startX;
        cy = startY;
        break;
      case "M": {
        const v = read(2);
        if (!v) return;
        cx = ox + v[0]!;
        cy = oy + v[1]!;
        startX = cx;
        startY = cy;
        path.moveTo(cx, cy);
        break;
      }
      case "L": {
        const v = read(2);
        if (!v) return;
        cx = ox + v[0]!;
        cy = oy + v[1]!;
        path.lineTo(cx, cy);
        break;
      }
      case "H": {
        const v = read(1);
        if (!v) return;
        cx = ox + v[0]!;
        path.lineTo(cx, cy);
        break;
      }
      case "V": {
        const v = read(1);
        if (!v) return;
        cy = oy + v[0]!;
        path.lineTo(cx, cy);
        break;
      }
      case "C": {
        const v = read(6);
        if (!v) return;
        cubic = { x: ox + v[2]!, y: oy + v[3]! };
        path.bezierCurveTo(ox + v[0]!, oy + v[1]!, cubic.x, cubic.y, ox + v[4]!, oy + v[5]!);
        cx = ox + v[4]!;
        cy = oy + v[5]!;
        break;
      }
      case "S": {
        const v = read(4);
        if (!v) return;
        const c1 = lastCubic ? { x: 2 * cx - lastCubic.x, y: 2 * cy - lastCubic.y } : { x: cx, y: cy };
        cubic = { x: ox + v[0]!, y: oy + v[1]! };
        path.bezierCurveTo(c1.x, c1.y, cubic.x, cubic.y, ox + v[2]!, oy + v[3]!);
        cx = ox + v[2]!;
        cy = oy + v[3]!;
        break;
      }
      case "Q": {
        const v = read(4);
        if (!v) return;
        quad = { x: ox + v[0]!, y: oy + v[1]! };
        path.quadraticCurveTo(quad.x, quad.y, ox + v[2]!, oy + v[3]!);
        cx = ox + v[2]!;
        cy = oy + v[3]!;
        break;
      }
      case "T": {
        const v = read(2);
        if (!v) return;
        quad = lastQuad ? { x: 2 * cx - lastQuad.x, y: 2 * cy - lastQuad.y } : { x: cx, y: cy };
        path.quadraticCurveTo(quad.x, quad.y, ox + v[0]!, oy + v[1]!);
        cx = ox + v[0]!;
        cy = oy + v[1]!;
        break;
      }
      case "A": {
        const radii = read(3);
        if (!radii) return;
        const large = flag();
        const sweep = flag();
        const end = read(2);
        if (large === null || sweep === null || !end) return;
        const x = ox + end[0]!;
        const y = oy + end[1]!;
        svgArc(path, cx, cy, radii[0]!, radii[1]!, radii[2]!, large, sweep, x, y);
        cx = x;
        cy = y;
        break;
      }
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
};

/** SVG's endpoint arc as an `ellipse` call, following the SVG implementation notes (F.6.5, F.6.6). */
const svgArc = (
  path: RecordingPath2D,
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void => {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    path.lineTo(x2, y2);
    return;
  }
  const phi = ((angleDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const centerX = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const centerY = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  path.ellipse(centerX, centerY, rx, ry, phi, theta1, theta1 + delta, !sweep);
};
