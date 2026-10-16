import {
  type PreparedRichInline,
  type RichInlineCursor,
  type RichInlineFragment,
  layoutNextRichInlineLineRange,
  materializeRichInlineLineRange,
  prepareRichInline,
} from "@chenglou/pretext/rich-inline";
import { type Interval, type Region, bandIntervals, regionTopBottom } from "./bands";
import { baseDirection, hasRtl, visualRuns } from "./bidi";
import { type TextMeasurer, canvasMeasurer } from "./measure";
import {
  type Block,
  DEFAULT_THEME,
  type Direction,
  type TextAlign,
  type TextRun,
  type RichText,
  type Theme,
  asRun,
  runFont,
} from "./model";

/** The Pretext release this layout follows; stored in every layout's fingerprint. */
export const PRETEXT_VERSION = "1.0.0";

export interface RectContainer {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** Leave out for a container that grows with its text. */
  readonly height?: number;
}

export type Container = RectContainer | Region;

export interface LayoutOptions {
  /** Where text goes: a rectangle, or any region (closed rings, e.g. from `pathRings`). */
  readonly container: Container;
  /** Regions text flows around. */
  readonly obstacles?: readonly Region[];
  readonly theme?: Partial<Theme>;
  /** Default direction of paragraphs that set none. Default "ltr". */
  readonly direction?: Direction;
  readonly measurer?: TextMeasurer;
  /** Pieces of a band narrower than this are skipped. Default twice the body font size. */
  readonly minLineWidth?: number;
  /** Names the layout engine in the fingerprint. Default: read from `navigator.userAgent`. */
  readonly engine?: string;
}

/** One paragraph's worth of text, after blocks and lists are flattened. */
export interface Paragraph {
  /** Index of the top-level block it came from. */
  readonly block: number;
  readonly kind: "paragraph" | "heading" | "list-item";
  readonly runs: readonly TextRun[];
  /** The block's own font, which sets the line's minimum height (CSS's strut). */
  readonly font: string;
  readonly size: number;
  readonly weight: number;
  readonly align: TextAlign;
  readonly direction: Direction;
  /** Inset from the start side, in px. */
  readonly indent: number;
  readonly marker?: string;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
}

export interface TextFragment {
  readonly text: string;
  /** Left edge, in layout space. */
  readonly x: number;
  readonly width: number;
  readonly font: string;
  readonly color: string;
  readonly direction: "ltr" | "rtl";
  /** Index into the paragraph's runs; -1 for a list marker. */
  readonly run: number;
  /** Where the text sits in that run's text, as UTF-16 offsets. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface TextLine {
  readonly paragraph: number;
  /** Top and height of the line box. */
  readonly top: number;
  readonly height: number;
  /** The baseline, where fragments are drawn. */
  readonly baseline: number;
  /** The piece of the band this line fills. */
  readonly left: number;
  readonly right: number;
  /** Width of the text on the line. */
  readonly width: number;
  readonly direction: "ltr" | "rtl";
  readonly fragments: readonly TextFragment[];
  readonly marker?: TextFragment;
}

export interface LayoutFingerprint {
  readonly pretext: string;
  /** The layout engine whose line-breaking rules applied: blink, webkit, gecko, or what `engine` named. */
  readonly engine: string;
  /** Every font the layout measured, sorted. */
  readonly fonts: readonly string[];
}

export interface TextLayout {
  readonly paragraphs: readonly Paragraph[];
  readonly lines: readonly TextLine[];
  /** Top of the first block and bottom of the last, spacing included. */
  readonly top: number;
  readonly bottom: number;
  /** Text was left over because the container ran out of room. */
  readonly overflow: boolean;
  readonly fingerprint: LayoutFingerprint;
}

/** Flattens blocks into paragraphs: headings and list items get their fonts, indents, markers and spacing. */
export const flattenBlocks = (text: RichText, theme: Theme = DEFAULT_THEME, direction: Direction = "ltr"): Paragraph[] => {
  const out: Paragraph[] = [];
  const body = { size: theme.fontSize, weight: 400 };
  const font = (b: { size: number; weight: number }): string => runFont({ text: "" }, b, theme);
  const visit = (block: Block, index: number, indent: number, depth: number, marker: string | undefined, last: boolean): void => {
    switch (block.type) {
      case "paragraph":
      case "heading": {
        const style = block.type === "heading" ? { size: theme.headingSizes[block.level - 1]!, weight: theme.headingWeight } : body;
        const inList = depth > 0;
        out.push({
          block: index,
          kind: inList ? "list-item" : block.type,
          runs: block.content.map(asRun),
          font: font(style),
          size: style.size,
          weight: style.weight,
          align: block.align ?? "start",
          direction: block.direction ?? direction,
          indent,
          ...(marker !== undefined ? { marker } : {}),
          spaceBefore: block.type === "heading" ? theme.headingSpacingBefore : 0,
          spaceAfter:
            block.type === "heading" ? theme.headingSpacingAfter : inList && !last ? theme.paragraphSpacing / 3 : theme.paragraphSpacing,
        });
        return;
      }
      case "list": {
        const first = block.start ?? 1;
        block.items.forEach((item, i) => {
          const mark = block.ordered ? `${first + i}.` : theme.bullets[depth % theme.bullets.length]!;
          item.forEach((child, j) =>
            visit(
              child,
              index,
              indent + theme.listIndent,
              depth + 1,
              j === 0 ? mark : undefined,
              last && i === block.items.length - 1 && j === item.length - 1,
            ),
          );
        });
        return;
      }
    }
  };
  text.blocks.forEach((block, i) => visit(block, i, 0, 0, undefined, true));
  return out;
};

const detectEngine = (): string => {
  const ua = typeof navigator === "undefined" ? "" : (navigator as { userAgent?: string }).userAgent ?? "";
  if (ua.includes("Firefox/")) return "gecko";
  if (ua.includes("AppleWebKit/537.36") && /Chrom(e|ium)\//.test(ua)) return "blink";
  if (ua.includes("AppleWebKit/") && !ua.includes("AppleWebKit/537.36")) return "webkit";
  // Pretext falls back to Blink's rules for engines it doesn't recognize.
  return "blink";
};

const isRect = (c: Container): c is RectContainer => "width" in c;

const rectRegion = (c: RectContainer): Region => {
  const bottom = c.height === undefined ? Number.MAX_SAFE_INTEGER : c.y + c.height;
  return {
    rings: [
      [
        { x: c.x, y: c.y },
        { x: c.x + c.width, y: c.y },
        { x: c.x + c.width, y: bottom },
        { x: c.x, y: bottom },
      ],
    ],
  };
};

interface Box {
  readonly top: number;
  readonly bottom: number;
}

/**
 * Lays out rich text in a container. Lines are found with Pretext, band by
 * band: each band is cut by the container's outline (and any obstacles) into
 * intervals that are inside for its whole height, filled left to right.
 */
export const layoutText = (text: RichText, options: LayoutOptions): TextLayout => {
  const theme: Theme = { ...DEFAULT_THEME, ...options.theme };
  const measurer = options.measurer ?? canvasMeasurer();
  const paragraphs = flattenBlocks(text, theme, options.direction ?? "ltr");
  const container = options.container;
  const region = isRect(container) ? rectRegion(container) : container;
  const { top: regionTop, bottom: regionBottom } = regionTopBottom(region);
  const obstacles = options.obstacles ?? [];
  const minWidth = options.minLineWidth ?? theme.fontSize * 2;
  const fonts = new Set<string>();

  // The box a font of `size` takes on a line with unitless line height: its ascent and descent
  // plus half the leading on each side, relative to the baseline (CSS 2.1, 10.8.1).
  const inlineBox = (font: string, size: number): Box => {
    fonts.add(font);
    const { ascent, descent } = measurer.metrics(font);
    const leading = theme.lineHeight * size - (ascent + descent);
    return { top: -(ascent + leading / 2), bottom: descent + leading / 2 };
  };

  const lines: TextLine[] = [];
  let y = isRect(container) ? container.y : regionTop;
  const top = y;
  let overflow = false;

  paragraphs.forEach((paragraph, index) => {
    if (overflow) return;
    y += paragraph.spaceBefore;
    const fontsOf = paragraph.runs.map((run) => runFont(run, paragraph, theme));
    const sizesOf = paragraph.runs.map((run) => run.size ?? paragraph.size);
    // Pretext needs at least one item; empty runs are dropped and mapped back by index.
    const kept = paragraph.runs.map((run, i) => i).filter((i) => paragraph.runs[i]!.text.length > 0);
    const prepared: PreparedRichInline | null =
      kept.length > 0 ? prepareRichInline(kept.map((i) => ({ text: paragraph.runs[i]!.text, font: fontsOf[i]! }))) : null;
    const strut = inlineBox(paragraph.font, paragraph.size);
    const strutHeight = strut.bottom - strut.top;
    const allText = paragraph.runs.map((r) => r.text).join("");
    const direction = baseDirection(allText, paragraph.direction);
    const startIsLeft = direction === "ltr";

    const usable = (y0: number, y1: number): Interval[] =>
      bandIntervals(region, obstacles, y0, y1)
        .map(([l, r]): Interval => (startIsLeft ? [l + paragraph.indent, r] : [l, r - paragraph.indent]))
        .filter(([l, r]) => r - l >= minWidth);

    let cursor: RichInlineCursor | undefined;
    let first = true;
    while (prepared !== null || first) {
      let bandHeight = strutHeight;
      let placed: { interval: Interval; fragments: RichInlineFragment[]; width: number }[] = [];
      let next: RichInlineCursor | undefined = cursor;
      let box: Box = strut;
      let fits = true;
      let intervalCount = 0;
      // A band is laid out again, taller, when its text turns out taller than the band.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (y + bandHeight > regionBottom) {
          fits = false;
          break;
        }
        const intervals = usable(y, y + bandHeight);
        intervalCount = intervals.length;
        placed = [];
        next = cursor;
        if (prepared === null) {
          if (intervals.length > 0) placed.push({ interval: intervals[0]!, fragments: [], width: 0 });
        } else {
          for (const interval of intervals) {
            const range = layoutNextRichInlineLineRange(prepared, interval[1] - interval[0], next);
            if (range === null) break;
            const line = materializeRichInlineLineRange(prepared, range);
            placed.push({ interval, fragments: line.fragments, width: line.width });
            next = line.end;
          }
        }
        box = placed
          .flatMap((p) => p.fragments)
          .reduce((b, f) => {
            const run = kept[f.itemIndex]!;
            const own = inlineBox(fontsOf[run]!, sizesOf[run]!);
            return { top: Math.min(b.top, own.top), bottom: Math.max(b.bottom, own.bottom) };
          }, strut);
        const height = box.bottom - box.top;
        if (height <= bandHeight + 1e-9 || isRect(container)) break;
        bandHeight = height;
      }
      if (!fits) {
        overflow = prepared === null || cursor === undefined || layoutNextRichInlineLineRange(prepared, 1e9, cursor) !== null;
        break;
      }
      if (placed.length === 0) {
        // Every interval was there but the text has run out: the paragraph is done.
        if (intervalCount > 0) break;
        // No room in this band: try a little lower.
        y += Math.max(1, bandHeight / 4);
        continue;
      }
      const height = box.bottom - box.top;
      const baseline = y - box.top;
      placed.forEach(({ interval, fragments, width }, piece) => {
        const line = placeLine(fragments, width, interval, direction, paragraph, kept, fontsOf, theme, measurer);
        const marker =
          first && piece === 0 && paragraph.marker !== undefined
            ? markerFragment(paragraph, interval, direction, theme, measurer)
            : undefined;
        lines.push({
          paragraph: index,
          top: y,
          height,
          baseline,
          left: interval[0],
          right: interval[1],
          width: line.width,
          direction,
          fragments: line.fragments,
          ...(marker ? { marker } : {}),
        });
      });
      first = false;
      y += height;
      cursor = next;
    }
    y += paragraph.spaceAfter;
  });

  return {
    paragraphs,
    lines,
    top,
    bottom: y,
    overflow,
    fingerprint: { pretext: PRETEXT_VERSION, engine: options.engine ?? detectEngine(), fonts: [...fonts].sort() },
  };
};

const alignFactor = (align: TextAlign, direction: "ltr" | "rtl"): number => {
  switch (align) {
    case "left":
      return 0;
    case "right":
      return 1;
    case "center":
      return 0.5;
    case "start":
      return direction === "ltr" ? 0 : 1;
    case "end":
      return direction === "ltr" ? 1 : 0;
  }
};

/** Positions a line's fragments in its interval: as Pretext measured them, or reordered when bidi applies. */
const placeLine = (
  fragments: readonly RichInlineFragment[],
  pretextWidth: number,
  interval: Interval,
  direction: "ltr" | "rtl",
  paragraph: Paragraph,
  kept: readonly number[],
  fontsOf: readonly string[],
  theme: Theme,
  measurer: TextMeasurer,
): { fragments: TextFragment[]; width: number } => {
  const colorOf = (run: number): string => paragraph.runs[run]!.color ?? theme.color;
  const available = interval[1] - interval[0];
  const needsBidi = direction === "rtl" || fragments.some((f) => hasRtl(f.text));
  if (!needsBidi) {
    let x = interval[0] + (available - pretextWidth) * alignFactor(paragraph.align, direction);
    return {
      width: pretextWidth,
      fragments: fragments.map((f) => {
        const run = kept[f.itemIndex]!;
        x += f.gapBefore;
        const fragment: TextFragment = {
          text: f.text,
          x,
          width: f.occupiedWidth,
          font: fontsOf[run]!,
          color: colorOf(run),
          direction: "ltr",
          run,
          sourceStart: f.sourceStart,
          sourceEnd: f.sourceEnd,
        };
        x += f.occupiedWidth;
        return fragment;
      }),
    };
  }
  // Logical pieces: each fragment, with the collapsed space before it as a piece of its own.
  const pieces: { text: string; run: number; sourceStart: number }[] = [];
  for (const f of fragments) {
    if (f.gapBefore > 0) pieces.push({ text: " ", run: kept[f.gapItemIndex] ?? kept[f.itemIndex]!, sourceStart: -1 });
    pieces.push({ text: f.text, run: kept[f.itemIndex]!, sourceStart: f.sourceStart });
  }
  // Spaces at the line's end hang past it and take no room, as Pretext's line width says.
  for (let last = pieces.length - 1; last >= 0; last--) {
    const trimmed = pieces[last]!.text.replace(/\s+$/u, "");
    pieces[last] = { ...pieces[last]!, text: trimmed };
    if (trimmed.length > 0) break;
  }
  const runs = visualRuns(
    pieces.map((p) => p.text),
    direction,
  );
  const measured = runs.map((r) => {
    const piece = pieces[r.piece]!;
    const text = piece.text.slice(r.start, r.end);
    return { r, piece, text, width: measurer.width(fontsOf[piece.run]!, text) };
  });
  const width = measured.reduce((sum, m) => sum + m.width, 0);
  let x = interval[0] + (available - width) * alignFactor(paragraph.align, direction);
  const out: TextFragment[] = [];
  for (const { r, piece, text, width: w } of measured) {
    if (piece.sourceStart >= 0) {
      out.push({
        text,
        x,
        width: w,
        font: fontsOf[piece.run]!,
        color: colorOf(piece.run),
        direction: r.rtl ? "rtl" : "ltr",
        run: piece.run,
        sourceStart: piece.sourceStart + r.start,
        sourceEnd: piece.sourceStart + r.end,
      });
    }
    x += w;
  }
  return { fragments: out, width };
};

const markerFragment = (
  paragraph: Paragraph,
  interval: Interval,
  direction: "ltr" | "rtl",
  theme: Theme,
  measurer: TextMeasurer,
): TextFragment => {
  const text = paragraph.marker!;
  const width = measurer.width(paragraph.font, text);
  const x = direction === "ltr" ? interval[0] - theme.listMarkerGap - width : interval[1] + theme.listMarkerGap;
  return { text, x, width, font: paragraph.font, color: theme.color, direction, run: -1, sourceStart: 0, sourceEnd: text.length };
};
