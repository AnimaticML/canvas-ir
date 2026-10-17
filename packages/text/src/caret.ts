import type { TextFragment, TextLayout, TextLine } from "./layout";
import { type TextMeasurer, canvasMeasurer } from "./measure";

/** A place in the source text: a paragraph (as `layout.paragraphs` lists them), a run in it, and a UTF-16 offset in that run's text. */
export interface TextPosition {
  readonly paragraph: number;
  readonly run: number;
  readonly offset: number;
}

export interface CaretRect {
  readonly x: number;
  readonly top: number;
  readonly height: number;
  /** Index of the line in `layout.lines`. */
  readonly line: number;
}

export interface SelectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly line: number;
}

/** Orders positions as the source reads: by paragraph, then run, then offset. */
export const comparePositions = (a: TextPosition, b: TextPosition): number =>
  a.paragraph - b.paragraph || a.run - b.run || a.offset - b.offset;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Offsets in `text` a caret may sit at: grapheme cluster boundaries, so it never splits an emoji or a combining mark. */
const boundaries = (text: string): number[] => {
  if (!segmenter) return Array.from({ length: text.length + 1 }, (_, i) => i);
  const out = [0];
  for (const s of segmenter.segment(text)) out.push(s.index + s.segment.length);
  return out;
};

/**
 * The x of a caret `k` code units into a fragment. Prefix widths come from the
 * measurer and are scaled so the fragment's ends land exactly on its laid-out
 * edges. Trailing spaces hang past the line's end with no width, as in CSS, so
 * carets in them sit at the fragment's end. Right-to-left fragments run from
 * their right edge.
 */
const caretX = (f: TextFragment, k: number, measurer: TextMeasurer): number => {
  const visible = f.text.trimEnd().length;
  const full = measurer.width(f.font, f.text.slice(0, visible));
  const part = k <= 0 ? 0 : k >= visible ? full : measurer.width(f.font, f.text.slice(0, k));
  const advance = full > 0 ? (part / full) * f.width : 0;
  return f.direction === "rtl" ? f.x + f.width - advance : f.x + advance;
};

/** The fragment text offset for a source offset, clamped to the fragment. */
const local = (f: TextFragment, offset: number): number => Math.max(0, Math.min(f.text.length, offset - f.sourceStart));

const lineAt = (layout: TextLayout, y: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  layout.lines.forEach((line, i) => {
    const d = y < line.top ? line.top - y : y > line.top + line.height ? y - (line.top + line.height) : 0;
    if (d < bestDistance) [best, bestDistance] = [i, d];
  });
  return best;
};

/**
 * The text position nearest a point in layout space, as a click in an editor
 * would place the caret: the line whose box is nearest vertically, the fragment
 * nearest horizontally, then the nearest grapheme boundary. Null when there is
 * no text.
 */
export const positionAtPoint = (
  layout: TextLayout,
  point: { x: number; y: number },
  measurer: TextMeasurer = canvasMeasurer(),
): (TextPosition & { line: number }) | null => {
  if (layout.lines.length === 0) return null;
  const index = lineAt(layout, point.y);
  const line = layout.lines[index]!;
  let fragment: TextFragment | undefined;
  let gap = Infinity;
  for (const f of line.fragments) {
    const d = point.x < f.x ? f.x - point.x : point.x > f.x + f.width ? point.x - (f.x + f.width) : 0;
    if (d < gap) [fragment, gap] = [f, d];
  }
  if (!fragment) return null;
  let bestK = 0;
  let bestD = Infinity;
  for (const k of boundaries(fragment.text)) {
    const d = Math.abs(caretX(fragment, k, measurer) - point.x);
    if (d < bestD) [bestK, bestD] = [k, d];
  }
  return { paragraph: line.paragraph, run: fragment.run, offset: fragment.sourceStart + bestK, line: index };
};

/** Fragments holding a position, as [line index, line, fragment]; the one where the position starts text is first. */
const holders = (layout: TextLayout, p: TextPosition): [number, TextLine, TextFragment][] => {
  const found: [number, TextLine, TextFragment][] = [];
  layout.lines.forEach((line, i) => {
    if (line.paragraph !== p.paragraph) return;
    for (const f of line.fragments) if (f.run === p.run && f.sourceStart <= p.offset && p.offset <= f.sourceEnd) found.push([i, line, f]);
  });
  return found.sort((a, b) => Number(b[2].sourceStart === p.offset) - Number(a[2].sourceStart === p.offset) || Number(a[2].sourceEnd === p.offset) - Number(b[2].sourceEnd === p.offset));
};

/**
 * Where to draw the caret for a position: its x and its line's box. A position
 * at a line break shows at the start of the next line. A position in collapsed
 * space between fragments shows at the end of the fragment before it.
 */
export const caretRect = (layout: TextLayout, p: TextPosition, measurer: TextMeasurer = canvasMeasurer()): CaretRect | null => {
  let [hit] = holders(layout, p);
  if (!hit) {
    // In collapsed space: the nearest fragment of the run ending before the offset.
    let best: [number, TextLine, TextFragment] | undefined;
    layout.lines.forEach((line, i) => {
      if (line.paragraph !== p.paragraph) return;
      for (const f of line.fragments) if (f.run === p.run && f.sourceEnd <= p.offset && (!best || f.sourceEnd >= best[2].sourceEnd)) best = [i, line, f];
    });
    hit = best;
  }
  if (!hit) return null;
  const [index, line, f] = hit;
  return { x: caretX(f, local(f, p.offset), measurer), top: line.top, height: line.height, line: index };
};

/**
 * The rects that highlight the text between two positions, in either order: one
 * per line, spanning its selected fragments (and the gaps between them, which
 * are collapsed spaces), or several on a line where bidi reordering splits the
 * selection visually.
 */
export const selectionRects = (
  layout: TextLayout,
  a: TextPosition,
  b: TextPosition,
  measurer: TextMeasurer = canvasMeasurer(),
): SelectionRect[] => {
  const [from, to] = comparePositions(a, b) <= 0 ? [a, b] : [b, a];
  const out: SelectionRect[] = [];
  layout.lines.forEach((line, index) => {
    const spans: [number, number][] = [];
    for (const f of line.fragments) {
      const start = { paragraph: line.paragraph, run: f.run, offset: f.sourceStart };
      const end = { paragraph: line.paragraph, run: f.run, offset: f.sourceEnd };
      if (comparePositions(end, from) <= 0 || comparePositions(start, to) >= 0) continue;
      const k0 = comparePositions(from, start) > 0 ? local(f, from.offset) : 0;
      const k1 = comparePositions(to, end) < 0 ? local(f, to.offset) : f.text.length;
      if (k1 <= k0) continue;
      const x0 = caretX(f, k0, measurer);
      const x1 = caretX(f, k1, measurer);
      spans.push([Math.min(x0, x1), Math.max(x0, x1)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    // Close the gaps of collapsed spaces between selected fragments.
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] - last[1] <= line.height / 2) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    for (const [x0, x1] of merged) out.push({ x: x0, y: line.top, width: x1 - x0, height: line.height, line: index });
  });
  return out;
};
