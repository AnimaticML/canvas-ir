import { formatColor, parseColor } from "./color";
import { arcSweep, ellipseFrame } from "./geometry/flatten";
import { IDENTITY, applyToPoint, invert, multiply } from "./math";
import type {
  ColorStop,
  Compositing,
  FillOp,
  GradientPaint,
  Group,
  ImageOp,
  IRDocument,
  JsonValue,
  Matrix2D,
  Op,
  Paint,
  PathGeometry,
  Point,
  Rect,
  Segment,
  StrokeOp,
  StrokeStyle,
  Subpath,
  TextOp,
} from "./types";

/**
 * Morphing from one drawing to another: ops are paired by a key (their id by
 * default), and each pair is blended. Transforms are decomposed into move,
 * turn, scale and skew, so a rotated shape turns rather than squashing through
 * zero; colors blend in OKLab, so midpoints keep their brightness; paths are
 * rewritten as cubics with matching counts. Ops with no partner fade out or in.
 */
export interface MorphOptions {
  /** Pairs ops across the drawings: ops with the same key morph into each other. Defaults to the op id; undefined leaves an op unpaired. */
  readonly key?: (op: Op, document: IRDocument) => string | undefined;
}

export interface Morph {
  /** The drawing at `t`, from 0 (the first drawing) to 1 (the second). Ease `t` as you like. */
  at(t: number): IRDocument;
  /** How many ops were paired, and how many fade out or in. */
  readonly paired: number;
  readonly removed: number;
  readonly added: number;
}

/**
 * Keys ops by a field of their group's meta and their place among that group's
 * ops, so drawings recorded separately (with different ids) pair up by name:
 * `beginGroup({ meta: { name: "head" } })` in both.
 */
export const keyByMeta =
  (field = "name") =>
  (op: Op, document: IRDocument): string | undefined => {
    if (op.group === undefined) return undefined;
    const group = document.groups?.find((g) => g.id === op.group);
    const name = group?.meta?.[field];
    if (name === undefined) return undefined;
    const siblings = document.ops.filter((o) => o.group === op.group);
    return `${JSON.stringify(name as JsonValue)}#${siblings.indexOf(op)}`;
  };

// --- Numbers, transforms and colors ---

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpPoint = (p: Point, q: Point, t: number): Point => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const lerpRect = (p: Rect, q: Rect, t: number): Rect => ({
  x: lerp(p.x, q.x, t),
  y: lerp(p.y, q.y, t),
  width: lerp(p.width, q.width, t),
  height: lerp(p.height, q.height, t),
});
const pick = <T>(a: T, b: T, t: number): T => (t < 0.5 ? a : b);

interface Decomposed {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly sx: number;
  readonly sy: number;
  readonly skew: number;
}

/** A matrix as translate · rotate · skew-x · scale, the usual CSS decomposition. */
const decompose = (m: Matrix2D): Decomposed => {
  const sx = Math.hypot(m.a, m.b);
  const angle = Math.atan2(m.b, m.a);
  const det = m.a * m.d - m.b * m.c;
  if (sx === 0) return { x: m.e, y: m.f, angle: 0, sx: 0, sy: Math.hypot(m.c, m.d), skew: 0 };
  const skew = (m.a * m.c + m.b * m.d) / (sx * sx);
  const sy = det / sx;
  return { x: m.e, y: m.f, angle, sx, sy, skew };
};

const compose = ({ x, y, angle, sx, sy, skew }: Decomposed): Matrix2D => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // rotate · [[sx, skew·sx... ]] : columns (sx, 0) and (skew·sx, sy), rotated.
  return { a: cos * sx, b: sin * sx, c: cos * skew * sx - sin * sy, d: sin * skew * sx + cos * sy, e: x, f: y };
};

const lerpMatrix = (m: Matrix2D, n: Matrix2D, t: number): Matrix2D => {
  const p = decompose(m);
  const q = decompose(n);
  // Turn the short way round.
  let turn = q.angle - p.angle;
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  return compose({
    x: lerp(p.x, q.x, t),
    y: lerp(p.y, q.y, t),
    angle: p.angle + turn * t,
    sx: lerp(p.sx, q.sx, t),
    sy: lerp(p.sy, q.sy, t),
    skew: lerp(p.skew, q.skew, t),
  });
};

type Lab = readonly [number, number, number, number];

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** sRGB to OKLab (Björn Ottosson's), with alpha. */
const toOklab = (color: string): Lab | null => {
  const rgba = parseColor(color);
  if (!rgba) return null;
  const r = toLinear(rgba.r);
  const g = toLinear(rgba.g);
  const b = toLinear(rgba.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    rgba.a,
  ];
};

const fromOklab = ([L, A, B, alpha]: Lab): string => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return formatColor({
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: Math.max(0, Math.min(1, alpha)),
  });
};

/** Blends two CSS colors in OKLab. A transparent end takes the other's hue, so fading doesn't pass through gray. */
export const mixColors = (from: string, to: string, t: number): string => {
  const p = toOklab(from);
  const q = toOklab(to);
  if (!p || !q) return pick(from, to, t);
  const a = p[3] === 0 ? ([q[0], q[1], q[2], 0] as const) : p;
  const b = q[3] === 0 ? ([p[0], p[1], p[2], 0] as const) : q;
  // Premultiplied, so a half-transparent color pulls the mix less.
  const alpha = lerp(a[3], b[3], t);
  if (alpha === 0) return fromOklab([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), 0]);
  const mix = (i: 0 | 1 | 2): number => lerp(a[i] * a[3], b[i] * b[3], t) / alpha;
  return fromOklab([mix(0), mix(1), mix(2), alpha]);
};

/** Gradient stops at the same offsets on both sides: the union of offsets, each side's color read off its own ramp. */
const alignStops = (p: readonly ColorStop[], q: readonly ColorStop[], t: number): ColorStop[] => {
  const colorAt = (stops: readonly ColorStop[], offset: number): string => {
    if (stops.length === 0) return "rgba(0, 0, 0, 0)";
    if (offset <= stops[0]!.offset) return stops[0]!.color;
    for (let i = 1; i < stops.length; i++) {
      const s = stops[i]!;
      const r = stops[i - 1]!;
      if (offset <= s.offset) return mixColors(r.color, s.color, s.offset === r.offset ? 1 : (offset - r.offset) / (s.offset - r.offset));
    }
    return stops[stops.length - 1]!.color;
  };
  const offsets = [...new Set([...p, ...q].map((s) => s.offset))].sort((a, b) => a - b);
  return offsets.map((offset) => ({ offset, color: mixColors(colorAt(p, offset), colorAt(q, offset), t) }));
};

const solidAs = (color: string, like: GradientPaint): GradientPaint => ({ ...like, stops: [{ offset: 0, color }, { offset: 1, color }] });

const lerpPaint = (p: Paint, q: Paint, t: number): Paint => {
  if (typeof p === "string" && typeof q === "string") return mixColors(p, q, t);
  if ((typeof p !== "string" && p.kind === "pattern") || (typeof q !== "string" && q.kind === "pattern")) return pick(p, q, t);
  // A color against a gradient blends as a flat gradient of that color.
  const a = typeof p === "string" ? solidAs(p, q as GradientPaint) : (p as GradientPaint);
  const b = typeof q === "string" ? solidAs(q, a) : (q as GradientPaint);
  if (a.kind !== b.kind) return pick(p, q, t);
  const stops = alignStops(a.stops, b.stops, t);
  if (a.kind === "linear" && b.kind === "linear") {
    return { kind: "linear", x0: lerp(a.x0, b.x0, t), y0: lerp(a.y0, b.y0, t), x1: lerp(a.x1, b.x1, t), y1: lerp(a.y1, b.y1, t), stops };
  }
  if (a.kind === "radial" && b.kind === "radial") {
    return {
      kind: "radial",
      x0: lerp(a.x0, b.x0, t),
      y0: lerp(a.y0, b.y0, t),
      r0: lerp(a.r0, b.r0, t),
      x1: lerp(a.x1, b.x1, t),
      y1: lerp(a.y1, b.y1, t),
      r1: lerp(a.r1, b.r1, t),
      stops,
    };
  }
  if (a.kind === "conic" && b.kind === "conic") {
    return { kind: "conic", startAngle: lerp(a.startAngle, b.startAngle, t), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), stops };
  }
  return pick(p, q, t);
};

const lerpCompositing = (p: Compositing, q: Compositing, t: number): Compositing => ({
  globalAlpha: lerp(p.globalAlpha, q.globalAlpha, t),
  globalCompositeOperation: pick(p.globalCompositeOperation, q.globalCompositeOperation, t),
  filter: pick(p.filter, q.filter, t),
  shadowColor: mixColors(p.shadowColor, q.shadowColor, t),
  shadowBlur: lerp(p.shadowBlur, q.shadowBlur, t),
  shadowOffsetX: lerp(p.shadowOffsetX, q.shadowOffsetX, t),
  shadowOffsetY: lerp(p.shadowOffsetY, q.shadowOffsetY, t),
});

const lerpStroke = (p: StrokeStyle, q: StrokeStyle, t: number): StrokeStyle => ({
  paint: lerpPaint(p.paint, q.paint, t),
  lineWidth: lerp(p.lineWidth, q.lineWidth, t),
  lineCap: pick(p.lineCap, q.lineCap, t),
  lineJoin: pick(p.lineJoin, q.lineJoin, t),
  miterLimit: lerp(p.miterLimit, q.miterLimit, t),
  lineDash: p.lineDash.length === q.lineDash.length ? p.lineDash.map((d, i) => lerp(d, q.lineDash[i]!, t)) : pick(p.lineDash, q.lineDash, t),
  lineDashOffset: lerp(p.lineDashOffset, q.lineDashOffset, t),
});

// --- Paths as cubics ---

type Cubic = readonly [Point, Point, Point, Point];

interface Contour {
  readonly start: Point;
  readonly cubics: readonly Cubic[];
  readonly closed: boolean;
}

const line = (a: Point, b: Point): Cubic => [a, lerpPoint(a, b, 1 / 3), lerpPoint(a, b, 2 / 3), b];

/** A path's subpaths as cubics in the space `space` maps world space to. */
const toContours = (path: PathGeometry, space: Matrix2D): Contour[] => {
  const toSpace = path.matrices.map((m) => multiply(space, m));
  return path.subpaths.map((subpath: Subpath) => {
    const start = applyToPoint(toSpace[subpath.m]!, subpath.start.x, subpath.start.y);
    const cubics: Cubic[] = [];
    let at = start;
    const push = (c: Cubic): void => {
      cubics.push(c);
      at = c[3];
    };
    for (const segment of subpath.segments as Segment[]) {
      const m = toSpace[segment.m]!;
      switch (segment.kind) {
        case "line":
          push(line(at, applyToPoint(m, segment.to.x, segment.to.y)));
          break;
        case "quad": {
          const c = applyToPoint(m, segment.cp.x, segment.cp.y);
          const to = applyToPoint(m, segment.to.x, segment.to.y);
          push([at, lerpPoint(at, c, 2 / 3), lerpPoint(to, c, 2 / 3), to]);
          break;
        }
        case "cubic":
          push([at, applyToPoint(m, segment.cp1.x, segment.cp1.y), applyToPoint(m, segment.cp2.x, segment.cp2.y), applyToPoint(m, segment.to.x, segment.to.y)]);
          break;
        case "arc":
        case "ellipse": {
          const { c, u, v } = ellipseFrame(segment, m);
          const sweep = arcSweep(segment);
          const point = (a: number): Point => ({ x: c.x + u.x * Math.cos(a) + v.x * Math.sin(a), y: c.y + u.y * Math.cos(a) + v.y * Math.sin(a) });
          const tangent = (a: number): Point => ({ x: -u.x * Math.sin(a) + v.x * Math.cos(a), y: -u.y * Math.sin(a) + v.y * Math.cos(a) });
          const first = point(segment.startAngle);
          // An arc starts with a straight line from wherever the path was.
          if (Math.hypot(first.x - at.x, first.y - at.y) > 1e-9) push(line(at, first));
          const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
          const step = sweep / pieces;
          const k = (4 / 3) * Math.tan(step / 4);
          for (let i = 0; i < pieces; i++) {
            const a0 = segment.startAngle + step * i;
            const a1 = a0 + step;
            const p0 = point(a0);
            const p3 = point(a1);
            const d0 = tangent(a0);
            const d1 = tangent(a1);
            push([p0, { x: p0.x + k * d0.x, y: p0.y + k * d0.y }, { x: p3.x - k * d1.x, y: p3.y - k * d1.y }, p3]);
          }
          break;
        }
      }
    }
    // A closed subpath gets its closing edge, so both sides of a morph have it to move.
    if (subpath.closed && Math.hypot(at.x - start.x, at.y - start.y) > 1e-9) push(line(at, start));
    return { start, cubics, closed: subpath.closed };
  });
};

const splitCubic = ([p0, p1, p2, p3]: Cubic): [Cubic, Cubic] => {
  const a = lerpPoint(p0, p1, 0.5);
  const b = lerpPoint(p1, p2, 0.5);
  const c = lerpPoint(p2, p3, 0.5);
  const d = lerpPoint(a, b, 0.5);
  const e = lerpPoint(b, c, 0.5);
  const m = lerpPoint(d, e, 0.5);
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
};

const chord = (c: Cubic): number => Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) + Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[3].x - c[2].x, c[3].y - c[2].y);

/** Splits the longest pieces in half until there are `count`. */
const resample = (cubics: readonly Cubic[], count: number): Cubic[] => {
  const out = [...cubics];
  while (out.length < count) {
    let longest = 0;
    for (let i = 1; i < out.length; i++) if (chord(out[i]!) > chord(out[longest]!)) longest = i;
    out.splice(longest, 1, ...splitCubic(out[longest]!));
  }
  return out;
};

const centroid = (c: Contour): Point => {
  const points = [c.start, ...c.cubics.map((k) => k[3])];
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
};

/** A contour shrunk to a point, with `count` pieces: what an unpaired contour grows from or shrinks to. */
const collapsed = (at: Point, count: number, closed: boolean): Contour => ({ start: at, cubics: Array.from({ length: count }, () => [at, at, at, at] as const), closed });

const reverse = (c: Contour): Contour => {
  const cubics = [...c.cubics].reverse().map(([a, b, d, e]) => [e, d, b, a] as const);
  return { start: cubics[0]?.[0] ?? c.start, cubics, closed: c.closed };
};

const rotate = (c: Contour, by: number): Contour => {
  const cubics = [...c.cubics.slice(by), ...c.cubics.slice(0, by)];
  return { start: cubics[0]?.[0] ?? c.start, cubics, closed: c.closed };
};

const distance = (p: Contour, q: Contour): number => {
  let sum = 0;
  for (let i = 0; i < p.cubics.length; i++) {
    const a = p.cubics[i]![0];
    const b = q.cubics[i]![0];
    sum += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }
  return sum;
};

/** Pairs contours one to one, with equal piece counts; a closed pair starts and runs where the two line up best. */
const alignContours = (from: Contour[], to: Contour[]): [Contour[], Contour[]] => {
  const a: Contour[] = [];
  const b: Contour[] = [];
  for (let i = 0; i < Math.max(from.length, to.length); i++) {
    let p = from[i];
    let q = to[i];
    if (!p) p = collapsed(centroid(q!), q!.cubics.length, q!.closed);
    if (!q) q = collapsed(centroid(p), p.cubics.length, p.closed);
    const count = Math.max(p.cubics.length, q.cubics.length, 1);
    p = { ...p, cubics: p.cubics.length === 0 ? collapsed(p.start, count, p.closed).cubics : resample(p.cubics, count) };
    q = { ...q, cubics: q.cubics.length === 0 ? collapsed(q.start, count, q.closed).cubics : resample(q.cubics, count) };
    if (p.closed && q.closed && count > 1) {
      let best = q;
      let bestDistance = distance(p, q);
      for (const candidate of [q, reverse(q)]) {
        for (let r = 0; r < count; r++) {
          const turned = rotate(candidate, r);
          const d = distance(p, turned);
          if (d < bestDistance) {
            best = turned;
            bestDistance = d;
          }
        }
      }
      q = best;
    }
    a.push(p);
    b.push(q);
  }
  return [a, b];
};

const contoursAt = (p: readonly Contour[], q: readonly Contour[], t: number, matrix: Matrix2D): PathGeometry => ({
  matrices: [matrix],
  subpaths: p.map((c, i) => {
    const d = q[i]!;
    return {
      m: 0,
      start: lerpPoint(c.start, d.start, t),
      segments: c.cubics.map((k, j) => {
        const l = d.cubics[j]!;
        return { kind: "cubic", m: 0, cp1: lerpPoint(k[1], l[1], t), cp2: lerpPoint(k[2], l[2], t), to: lerpPoint(k[3], l[3], t) } as const;
      }),
      closed: c.closed && d.closed,
    };
  }),
});

// --- Pairing and blending ops ---

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const fontSize = (font: string): { size: number; rest: string } | null => {
  const m = /(\d*\.?\d+)px/.exec(font);
  return m ? { size: Number(m[1]), rest: font.replace(m[0], "{}") } : null;
};

const faded = (op: Op, alpha: number): Op =>
  op.kind === "clear" || op.kind === "embed" ? op : { ...op, compositing: { ...op.compositing, globalAlpha: op.compositing.globalAlpha * alpha } };

/** How a pair of ops blends: a function of t, or null when they can only cross-fade. */
const blender = (p: Op, q: Op): ((t: number) => Op) | null => {
  if (p.kind === "embed" && q.kind === "embed") {
    // An element keeps its content and moves with its place.
    return (t) => ({ ...q, transform: lerpMatrix(p.transform, q.transform, t), rect: lerpRect(p.rect, q.rect, t) });
  }
  if (p.kind !== q.kind || p.kind === "clear" || q.kind === "clear" || p.kind === "embed" || q.kind === "embed") return null;
  const clipAt = (t: number) => {
    const clip = sameJson(p.clip, q.clip) ? p.clip : pick(p.clip, q.clip, t);
    return clip ? { clip } : {};
  };
  const base = (t: number) => ({
    id: q.id,
    transform: lerpMatrix(p.transform, q.transform, t),
    compositing: lerpCompositing(p.compositing, q.compositing, t),
    ...clipAt(t),
    ...(q.group !== undefined ? { group: q.group } : {}),
  });
  if (p.kind === "fill" || p.kind === "stroke") {
    const a = p as FillOp | StrokeOp;
    const b = q as FillOp | StrokeOp;
    // Paths morph in each op's own drawing space, carried by the blended transform; a flat transform falls back to world space.
    const backA = invert(a.transform);
    const backB = invert(b.transform);
    const local = backA !== null && backB !== null;
    const [ca, cb] = alignContours(toContours(a.path, local ? backA : IDENTITY), toContours(b.path, local ? backB : IDENTITY));
    return (t) => {
      const shared = base(t);
      const path = contoursAt(ca, cb, t, local ? shared.transform : IDENTITY);
      if (a.kind === "fill" && b.kind === "fill") return { kind: "fill", ...shared, fillRule: pick(a.fillRule, b.fillRule, t), paint: lerpPaint(a.paint, b.paint, t), path };
      return { kind: "stroke", ...shared, stroke: lerpStroke((a as StrokeOp).stroke, (b as StrokeOp).stroke, t), path };
    };
  }
  if (p.kind === "image") {
    const a = p;
    const b = q as ImageOp;
    if (a.image.src !== b.image.src) return null;
    return (t) => ({ ...b, ...base(t), source: lerpRect(a.source, b.source, t), dest: lerpRect(a.dest, b.dest, t) });
  }
  const a = p as TextOp;
  const b = q as TextOp;
  const fa = fontSize(a.style.font);
  const fb = fontSize(b.style.font);
  if (a.text !== b.text || a.mode !== b.mode || !fa || !fb || fa.rest !== fb.rest) return null;
  return (t) => {
    const size = lerp(fa.size, fb.size, t);
    const scale = fb.size === 0 ? 1 : size / fb.size;
    return {
      ...b,
      ...base(t),
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      style: { ...pick(a.style, b.style, t), font: fa.rest.replace("{}", `${size}px`) },
      paint: lerpPaint(a.paint, b.paint, t),
      ...(a.stroke && b.stroke ? { stroke: lerpStroke(a.stroke, b.stroke, t) } : {}),
      // Metrics scale with the size, near enough for bounds while the text is in motion.
      metrics: Object.fromEntries(Object.entries(b.metrics).map(([k, v]) => [k, v * scale])) as unknown as TextOp["metrics"],
    };
  };
};

/** Prepares a morph from `from` to `to`; `at(t)` then builds each frame. */
export const morph = (from: IRDocument, to: IRDocument, options: MorphOptions = {}): Morph => {
  const key = options.key ?? ((op: Op) => op.id);
  const toByKey = new Map<string, Op>();
  for (const op of to.ops) {
    const k = key(op, to);
    if (k !== undefined && !toByKey.has(k)) toByKey.set(k, op);
  }
  const partner = new Map<Op, Op>();
  const taken = new Set<Op>();
  for (const op of from.ops) {
    const k = key(op, from);
    const other = k === undefined ? undefined : toByKey.get(k);
    if (other && !taken.has(other)) {
      partner.set(op, other);
      taken.add(other);
    }
  }
  const toIds = new Set(to.ops.map((op) => op.id));
  // Ops of the first drawing that stay in frames keep their id unless the second uses it.
  const oldId = (op: Op): string => (toIds.has(op.id) ? `from:${op.id}` : op.id);

  type Frame = (t: number) => Op[];
  const frames: Frame[] = [];
  // Each op of the first drawing with no partner leaves from just after the paired op it followed.
  const leavingAfter = new Map<Op | null, Op[]>();
  let previous: Op | null = null;
  for (const op of from.ops) {
    const other = partner.get(op);
    if (other) previous = other;
    else leavingAfter.set(previous, [...(leavingAfter.get(previous) ?? []), op]);
  }
  const leave = (ops: readonly Op[] | undefined): void => {
    for (const op of ops ?? []) {
      const renamed = { ...op, id: oldId(op) } as Op;
      frames.push((t) => [faded(renamed, 1 - t)]);
    }
  };
  leave(leavingAfter.get(null));
  const fromOf = new Map([...partner].map(([a, b]) => [b, a]));
  let paired = 0;
  for (const op of to.ops) {
    const source = fromOf.get(op);
    if (!source) {
      frames.push((t) => [faded(op, t)]);
    } else {
      paired++;
      const blend = blender(source, op);
      if (blend) frames.push((t) => [blend(t)]);
      else {
        // Ops that can't blend cross-fade: the old one under the new.
        const old = { ...source, id: oldId(source) } as Op;
        frames.push((t) => [faded(old, 1 - t), faded(op, t)]);
      }
      leave(leavingAfter.get(op));
    }
  }
  const groups = new Map<string, Group>();
  for (const g of from.groups ?? []) groups.set(g.id, g);
  for (const g of to.groups ?? []) groups.set(g.id, g);
  const groupList = [...groups.values()];
  return {
    paired,
    removed: from.ops.length - paired,
    added: to.ops.length - paired,
    at(t: number): IRDocument {
      if (t <= 0) return from;
      if (t >= 1) return to;
      const ops = frames.flatMap((frame) => frame(t)).filter((op) => op.kind === "clear" || op.kind === "embed" || op.compositing.globalAlpha > 0);
      return groupList.length > 0 ? { version: 1, ops, groups: groupList } : { version: 1, ops };
    },
  };
};
