/**
 * CSS color parsing for the cases Canvas cares about: deciding whether an
 * assignment is valid (invalid colors are ignored) and serializing it the way
 * browsers do, so `ctx.fillStyle = "red"` reads back as "#ff0000".
 */

export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1. */
  readonly a: number;
}

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff,
  beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff,
  blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00,
  chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9,
  darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000,
  darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493,
  deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222,
  floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000,
  greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
  lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff,
  maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6,
  olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
  papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd,
  powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
  seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
  slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4,
  tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0,
  violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00,
  yellowgreen: 0x9acd32,
};

/** Color functions we don't convert but browsers accept; they are kept as written. */
const OPAQUE_FUNCTIONS = /^(lab|lch|oklab|oklch|color|color-mix|light-dark|hwb|device-cmyk)\(/;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A number or percentage; percentages scale to `percentOf`. */
const component = (token: string, percentOf: number): number | null => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? (n / 100) * percentOf : n;
};

const hue = (token: string): number | null => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "deg").toLowerCase()) {
    case "rad":
      return (n * 180) / Math.PI;
    case "grad":
      return n * 0.9;
    case "turn":
      return n * 360;
    default:
      return n;
  }
};

/** Splits "a, b, c" or "a b c / d" into components plus optional alpha. */
const args = (body: string): { parts: string[]; alpha: string | null } | null => {
  const trimmed = body.trim();
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.some((p) => p === "")) return null;
    if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3]! };
    return parts.length === 3 ? { parts, alpha: null } : null;
  }
  const [main, alpha, extra] = trimmed.split("/").map((p) => p.trim());
  if (extra !== undefined || main === undefined) return null;
  const parts = main.split(/\s+/);
  return parts.length === 3 ? { parts, alpha: alpha ?? null } : null;
};

const alphaOf = (token: string | null): number | null => {
  if (token === null) return 1;
  const a = component(token, 1);
  return a === null ? null : clamp(a, 0, 1);
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};

/** Parses hex, named, `rgb[a]()` and `hsl[a]()` colors; null for anything else. */
export const parseColor = (input: string): RGBA | null => {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[s];
  if (named !== undefined) return { r: named >> 16, g: (named >> 8) & 255, b: named & 255, a: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a = "f"] = h.split("").map((c) => c);
      return {
        r: parseInt(r! + r!, 16),
        g: parseInt(g! + g!, 16),
        b: parseInt(b! + b!, 16),
        a: parseInt(a + a, 16) / 255,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const parsed = args(fn[2]!);
  if (!parsed) return null;
  const a = alphaOf(parsed.alpha);
  if (a === null) return null;
  if (fn[1]!.startsWith("rgb")) {
    const [r, g, b] = parsed.parts.map((p) => component(p, 255));
    if (r == null || g == null || b == null) return null;
    return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255), a };
  }
  const h = hue(parsed.parts[0]!);
  const sat = component(parsed.parts[1]!, 1);
  const light = component(parsed.parts[2]!, 1);
  if (h === null || sat === null || light === null || !parsed.parts[1]!.endsWith("%") || !parsed.parts[2]!.endsWith("%")) {
    return null;
  }
  const [r, g, b] = hslToRgb(h, clamp(sat, 0, 1), clamp(light, 0, 1));
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
};

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/** Formats like browsers serialize canvas colors: `#rrggbb` when opaque, `rgba(r, g, b, a)` otherwise. */
export const formatColor = ({ r, g, b, a }: RGBA): string => {
  // Browsers keep alpha in 8 bits and print the shortest decimal that round-trips it.
  const alpha8 = Math.round(a * 255);
  if (alpha8 === 255) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  let digits = 1;
  let text = (alpha8 / 255).toFixed(digits);
  while (Math.round(Number(text) * 255) !== alpha8 && digits < 6) text = (alpha8 / 255).toFixed(++digits);
  return `rgba(${r}, ${g}, ${b}, ${Number(text)})`;
};

/**
 * What a canvas color property becomes when assigned `value`: the normalized
 * color, the string as written for color syntaxes kept opaque, or null when
 * browsers would ignore the assignment.
 */
export const canvasColor = (value: string): string | null => {
  const parsed = parseColor(value);
  if (parsed) return formatColor(parsed);
  const s = value.trim().toLowerCase();
  // A canvas with no element to inherit from (OffscreenCanvas, or this recorder) resolves currentcolor to black.
  if (s === "currentcolor") return "#000000";
  if (OPAQUE_FUNCTIONS.test(s) && s.endsWith(")")) return value.trim();
  return null;
};
