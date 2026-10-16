import { arcSweep, ellipseFrame } from "./geometry/flatten";
import { buildUnclipped } from "./geometry/shape";
import { IDENTITY, applyToPoint, invert, multiply } from "./math";
import type {
  ClipPath,
  Compositing,
  ConicGradientPaint,
  Group,
  IRDocument,
  ImageOp,
  Matrix2D,
  Op,
  Paint,
  PathGeometry,
  Point,
  StrokeStyle,
  TextOp,
} from "./types";

export interface SvgOptions {
  /** Size of the SVG viewport, in world units. Default 300 by 150, a canvas's default. */
  readonly width?: number;
  readonly height?: number;
  /** The href for an image reference; default its `src`. Images inside an SVG shown with `<img>` must be data URLs. */
  readonly images?: (src: string) => string;
}

const num = (n: number): string => (Object.is(n, -0) ? "0" : String(n));

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const matrixAttr = (m: Matrix2D): string =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
    ? ""
    : ` transform="matrix(${num(m.a)} ${num(m.b)} ${num(m.c)} ${num(m.d)} ${num(m.e)} ${num(m.f)})"`;

/**
 * An ellipse given as `c + u cos t + v sin t` as SVG arc radii and rotation:
 * the singular values and left singular vector of the matrix [u v].
 */
export const ellipseAxes = (u: Point, v: Point): { rx: number; ry: number; rotation: number } => {
  const e = (u.x + v.y) / 2;
  const f = (u.x - v.y) / 2;
  const g = (u.y + v.x) / 2;
  const h = (u.y - v.x) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  const a1 = Math.atan2(g, f);
  const a2 = Math.atan2(h, e);
  return { rx: q + r, ry: Math.abs(q - r), rotation: (a2 + a1) / 2 };
};

/** Path data in the space `space` maps world space to, with arcs kept as elliptical arcs. */
export const svgPathData = (path: PathGeometry, space: Matrix2D = IDENTITY): string => {
  const toSpace = path.matrices.map((m) => multiply(space, m));
  const out: string[] = [];
  let current = "";
  const pt = (m: number, p: Point): string => {
    const q = applyToPoint(toSpace[m]!, p.x, p.y);
    return (current = `${num(q.x)} ${num(q.y)}`);
  };
  const xy = (p: Point): string => (current = `${num(p.x)} ${num(p.y)}`);
  for (const subpath of path.subpaths) {
    out.push(`M${pt(subpath.m, subpath.start)}`);
    for (const s of subpath.segments) {
      switch (s.kind) {
        case "line":
          out.push(`L${pt(s.m, s.to)}`);
          break;
        case "quad":
          out.push(`Q${pt(s.m, s.cp)} ${pt(s.m, s.to)}`);
          break;
        case "cubic":
          out.push(`C${pt(s.m, s.cp1)} ${pt(s.m, s.cp2)} ${pt(s.m, s.to)}`);
          break;
        case "arc":
        case "ellipse": {
          const { c, u, v } = ellipseFrame(s, toSpace[s.m]!);
          const at = (t: number): Point => ({ x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) });
          const start = at(s.startAngle);
          // Canvas draws a line from the current point to the arc's start.
          const before = current;
          const startXY = xy(start);
          if (startXY !== before) out.push(`L${startXY}`);
          const sweep = arcSweep(s);
          const { rx, ry, rotation } = ellipseAxes(u, v);
          if (rx === 0 || ry === 0 || sweep === 0) {
            const end = at(s.startAngle + sweep);
            out.push(`L${xy(end)}`);
            break;
          }
          const orientation = u.x * v.y - u.y * v.x > 0;
          const flag = orientation === sweep > 0 ? 1 : 0;
          const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
          const degrees = (rotation * 180) / Math.PI;
          for (let i = 1; i <= pieces; i++) {
            const end = at(s.startAngle + (sweep * i) / pieces);
            out.push(`A${num(rx)} ${num(ry)} ${num(degrees)} 0 ${flag} ${xy(end)}`);
          }
          break;
        }
      }
    }
    if (subpath.closed) out.push("Z");
  }
  return out.join("");
};

const BLEND_MODES = new Set([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

/**
 * Exports a document as SVG: paths with their arcs and curves, gradients,
 * patterns, clip paths, images and text, with ops grouped as recorded.
 *
 * Where SVG has no equal, the closest thing is used: a conic gradient is a CSS
 * `conic-gradient` in a `foreignObject` masked by the shape, `clearRect` masks
 * out what was drawn before it, and shadows are `feDropShadow`. Canvas
 * composite operations other than source-over and the blend modes are left out.
 */
export const toSVG = (document: IRDocument, options: SvgOptions = {}): string => {
  const width = options.width ?? 300;
  const height = options.height ?? 150;
  const href = options.images ?? ((src: string) => src);
  const defs: string[] = [];
  let nextDef = 0;
  const defId = (prefix: string): string => `${prefix}${nextDef++}`;
  const groups = new Map((document.groups ?? []).map((g) => [g.id, g]));
  const chainOf = (id: string | undefined): Group[] => {
    const out: Group[] = [];
    for (let g = id === undefined ? undefined : groups.get(id); g; g = g.parent === undefined ? undefined : groups.get(g.parent)) out.unshift(g);
    return out;
  };

  const imageHref = (src: string): string => escapeXml(href(src));

  const paintRef = (paint: Paint, op: Op): string => {
    if (typeof paint === "string") return escapeXml(paint);
    const stops = (list: readonly { offset: number; color: string }[]) =>
      list.map((s) => `<stop offset="${num(s.offset)}" stop-color="${escapeXml(s.color)}"/>`).join("");
    switch (paint.kind) {
      case "linear": {
        const id = defId("p");
        defs.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(paint.x0)}" y1="${num(paint.y0)}" x2="${num(paint.x1)}" y2="${num(paint.y1)}">${stops(paint.stops)}</linearGradient>`,
        );
        return `url(#${id})`;
      }
      case "radial": {
        const id = defId("p");
        defs.push(
          `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(paint.x1)}" cy="${num(paint.y1)}" r="${num(paint.r1)}" fx="${num(paint.x0)}" fy="${num(paint.y0)}" fr="${num(paint.r0)}">${stops(paint.stops)}</radialGradient>`,
        );
        return `url(#${id})`;
      }
      case "conic":
        // Painted separately, through a mask the shape is drawn into in white.
        return "#fff";
      case "pattern": {
        const id = defId("p");
        const { image, repetition } = paint;
        // A non-repeating direction gets a tile just larger than the drawing, so no second copy shows.
        // (Chromium renders a pattern with a huge tile at too low a resolution, or not at all.)
        const box = buildUnclipped(op, 1).paintBox;
        const toPattern = invert(multiply(op.transform, paint.transform)) ?? IDENTITY;
        const corners = [
          applyToPoint(toPattern, box.minX, box.minY),
          applyToPoint(toPattern, box.maxX, box.minY),
          applyToPoint(toPattern, box.maxX, box.maxY),
          applyToPoint(toPattern, box.minX, box.maxY),
        ];
        const span = (size: number, values: number[]): number => Math.ceil(Math.max(size, Math.max(...values), size - Math.min(...values))) + 1;
        const w = repetition === "repeat" || repetition === "repeat-x" ? image.width : span(image.width, corners.map((p) => p.x));
        const h = repetition === "repeat" || repetition === "repeat-y" ? image.height : span(image.height, corners.map((p) => p.y));
        defs.push(
          `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${num(w)}" height="${num(h)}"${matrixAttr(paint.transform).replace("transform=", "patternTransform=")}><image width="${num(image.width)}" height="${num(image.height)}" href="${imageHref(image.src)}" preserveAspectRatio="none"/></pattern>`,
        );
        return `url(#${id})`;
      }
    }
  };

  const strokeAttrs = (stroke: StrokeStyle, paint: string): string =>
    ` fill="none" stroke="${paint}" stroke-width="${num(stroke.lineWidth)}" stroke-linecap="${stroke.lineCap}" stroke-linejoin="${stroke.lineJoin}" stroke-miterlimit="${num(stroke.miterLimit)}"` +
    (stroke.lineDash.length > 0
      ? ` stroke-dasharray="${stroke.lineDash.map(num).join(" ")}" stroke-dashoffset="${num(stroke.lineDashOffset)}"`
      : "");

  const clipRef = (clip: ClipPath): string => {
    const id = defId("c");
    defs.push(
      `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path${matrixAttr(clip.transform)} d="${svgPathData(clip.path, invert(clip.transform) ?? IDENTITY)}" clip-rule="${clip.fillRule}"/></clipPath>`,
    );
    return id;
  };

  /** The element for an op, painted with `paint` (a fill or stroke value), in the op's own space. */
  const element = (op: Op, paint: string): string => {
    const t = op.transform;
    const local = invert(t) ?? IDENTITY;
    const tag = ` data-op="${escapeXml(op.id)}"`;
    switch (op.kind) {
      case "fill":
        return `<path${tag}${matrixAttr(t)} d="${svgPathData(op.path, local)}" fill="${paint}" fill-rule="${op.fillRule}"/>`;
      case "stroke":
        return `<path${tag}${matrixAttr(t)} d="${svgPathData(op.path, local)}"${strokeAttrs(op.stroke, paint)}/>`;
      case "image":
        return imageElement(op, tag);
      case "text":
        return textElement(op, paint, tag);
      case "clear":
        return "";
    }
  };

  const imageElement = (op: ImageOp, tag: string): string => {
    const { source: s, dest: d, image } = op;
    const rendering = op.smoothing.enabled ? "" : ` style="image-rendering: pixelated"`;
    return (
      `<g${tag}${matrixAttr(op.transform)}><svg x="${num(d.x)}" y="${num(d.y)}" width="${num(d.width)}" height="${num(d.height)}" viewBox="${num(s.x)} ${num(s.y)} ${num(s.width)} ${num(s.height)}" preserveAspectRatio="none" overflow="hidden">` +
      `<image width="${num(image.width)}" height="${num(image.height)}" href="${imageHref(image.src)}" preserveAspectRatio="none"${rendering}/></svg></g>`
    );
  };

  const textElement = (op: TextOp, paint: string, tag: string): string => {
    const { style } = op;
    const rtl = style.direction === "rtl";
    const anchor = {
      start: "start",
      end: "end",
      center: "middle",
      left: rtl ? "end" : "start",
      right: rtl ? "start" : "end",
    }[style.textAlign];
    const baseline = {
      alphabetic: "alphabetic",
      top: "text-before-edge",
      hanging: "hanging",
      middle: "central",
      ideographic: "ideographic",
      bottom: "text-after-edge",
    }[style.textBaseline];
    const css = [
      `font: ${style.font}`,
      "white-space: pre",
      style.letterSpacing !== "0px" ? `letter-spacing: ${style.letterSpacing}` : "",
      style.wordSpacing !== "0px" ? `word-spacing: ${style.wordSpacing}` : "",
      style.fontKerning !== "auto" ? `font-kerning: ${style.fontKerning}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    const squeeze =
      op.maxWidth !== undefined && op.metrics.width > op.maxWidth
        ? ` textLength="${num(op.maxWidth)}" lengthAdjust="spacingAndGlyphs"`
        : "";
    const painted = op.mode === "stroke" && op.stroke ? strokeAttrs(op.stroke, paint) : ` fill="${paint}"`;
    return (
      `<text${tag}${matrixAttr(op.transform)} x="${num(op.x)}" y="${num(op.y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" direction="${rtl ? "rtl" : "ltr"}"${squeeze}${painted} style="${escapeXml(css)}">` +
      `${escapeXml(op.text.replace(/[\t\n\f\r]/g, " "))}</text>`
    );
  };

  /** A conic gradient as CSS in a foreignObject over the op's paint box, masked by the op drawn in white. */
  const conicElement = (op: Op, paint: ConicGradientPaint, shape: string): string => {
    const box = buildUnclipped(op, 1).paintBox;
    const local = invert(op.transform) ?? IDENTITY;
    const corners = [
      applyToPoint(local, box.minX, box.minY),
      applyToPoint(local, box.maxX, box.minY),
      applyToPoint(local, box.maxX, box.maxY),
      applyToPoint(local, box.minX, box.maxY),
    ];
    const x0 = Math.min(...corners.map((p) => p.x)) - 1;
    const y0 = Math.min(...corners.map((p) => p.y)) - 1;
    const x1 = Math.max(...corners.map((p) => p.x)) + 1;
    const y1 = Math.max(...corners.map((p) => p.y)) + 1;
    const mask = defId("m");
    defs.push(`<mask id="${mask}" maskUnits="userSpaceOnUse" x="-1e7" y="-1e7" width="2e7" height="2e7">${shape}</mask>`);
    // Canvas angles start at 3 o'clock; CSS conic gradients at 12.
    const from = (paint.startAngle * 180) / Math.PI + 90;
    const stops = paint.stops.map((s) => `${s.color} ${num(s.offset * 100)}%`).join(", ");
    const css = `width: ${num(x1 - x0)}px; height: ${num(y1 - y0)}px; background: conic-gradient(from ${num(from)}deg at ${num(paint.x - x0)}px ${num(paint.y - y0)}px, ${stops})`;
    return `<g mask="url(#${mask})"><foreignObject${matrixAttr(op.transform)} x="${num(x0)}" y="${num(y0)}" width="${num(x1 - x0)}" height="${num(y1 - y0)}"><div xmlns="http://www.w3.org/1999/xhtml" style="${escapeXml(css)}"></div></foreignObject></g>`;
  };

  /**
   * Canvas order: filter the drawing; draw its shadow, then the drawing, each
   * clipped and composited on its own with globalAlpha and the blend mode. Clip
   * paths isolate their contents, so the blend mode sits outside them.
   */
  const composite = (drawn: string, c: Compositing, clip: readonly ClipPath[] | undefined): string => {
    const filtered = c.filter !== "none" ? `<g style="${escapeXml(`filter: ${c.filter}`)}">${drawn}</g>` : drawn;
    const layers = [filtered];
    // Canvas shadows are in device space, unaffected by the transform: a filter on an untransformed group.
    const shadowVisible = !/^rgba\(.*,\s*0\)$/.test(c.shadowColor) && c.shadowColor !== "transparent";
    if (shadowVisible && (c.shadowBlur > 0 || c.shadowOffsetX !== 0 || c.shadowOffsetY !== 0)) {
      const id = defId("f");
      defs.push(
        `<filter id="${id}" filterUnits="userSpaceOnUse" x="-1e7" y="-1e7" width="2e7" height="2e7" color-interpolation-filters="sRGB">` +
          `<feFlood flood-color="${escapeXml(c.shadowColor)}"/><feComposite in2="SourceAlpha" operator="in"/>` +
          (c.shadowBlur > 0 ? `<feGaussianBlur stdDeviation="${num(c.shadowBlur / 2)}"/>` : "") +
          `<feOffset dx="${num(c.shadowOffsetX)}" dy="${num(c.shadowOffsetY)}"/></filter>`,
      );
      layers.unshift(`<g filter="url(#${id})">${filtered}</g>`);
    }
    const blend = BLEND_MODES.has(c.globalCompositeOperation) ? ` style="mix-blend-mode: ${c.globalCompositeOperation}"` : "";
    const alpha = c.globalAlpha !== 1 ? ` opacity="${num(c.globalAlpha)}"` : "";
    return layers
      .map((layer) => {
        const clipped = (clip ?? []).reduceRight((acc, cp) => `<g clip-path="url(#${clipRef(cp)})">${acc}</g>`, layer);
        return alpha || blend ? `<g${alpha}${blend}>${clipped}</g>` : clipped;
      })
      .join("");
  };

  // Body: a stack of open group elements; a clear wraps everything drawn so far in a mask.
  let body = "";
  let open: string[] = [];
  const closeGroups = (keep: number): void => {
    while (open.length > keep) {
      body += "</g>";
      open.pop();
    }
  };
  for (const op of document.ops) {
    if (op.kind === "clear") {
      closeGroups(0);
      const { x, y, width: w, height: h } = op.rect;
      if (w === 0 || h === 0) continue;
      const id = defId("m");
      const hole = (op.clip ?? []).reduceRight((acc, cp) => `<g clip-path="url(#${clipRef(cp)})">${acc}</g>`, `<rect${matrixAttr(op.transform)} x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="#000"/>`);
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-1e7" y="-1e7" width="2e7" height="2e7"><rect x="-1e7" y="-1e7" width="2e7" height="2e7" fill="#fff"/>${hole}</mask>`);
      body = `<g mask="url(#${id})">${body}</g>`;
      continue;
    }
    const chain = chainOf(op.group);
    let keep = 0;
    while (keep < open.length && keep < chain.length && open[keep] === chain[keep]!.id) keep++;
    closeGroups(keep);
    for (const g of chain.slice(keep)) {
      const meta = g.meta ? ` data-meta="${escapeXml(JSON.stringify(g.meta))}"` : "";
      body += `<g data-group="${escapeXml(g.id)}"${meta}>`;
      open = [...open, g.id];
    }
    const paint = op.kind === "fill" || op.kind === "text" ? op.paint : op.kind === "stroke" ? op.stroke.paint : null;
    const drawn =
      paint !== null && typeof paint !== "string" && paint.kind === "conic"
        ? conicElement(op, paint, element(op, "#fff"))
        : element(op, paint === null ? "none" : paintRef(paint, op));
    body += composite(drawn, op.compositing, op.clip);
  }
  closeGroups(0);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">` +
    (defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "") +
    body +
    "</svg>"
  );
};
