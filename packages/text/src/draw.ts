import type { JsonValue } from "canvas-ir";
import { decorationMetrics } from "./decoration";
import type { TextFragment, TextLayout } from "./layout";
import { type TextMeasurer, canvasMeasurer } from "./measure";
import { DEFAULT_THEME, type Theme } from "./model";

/** The part of a 2D context drawing text needs; a `RecordingContext` or any real context will do. */
export interface TextTarget {
  font: string;
  fillStyle: unknown;
  direction: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  /** Present on a `RecordingContext`; used to group the block and its lines. */
  beginGroup?(options: { id?: string; meta?: { [key: string]: JsonValue } }): string;
  endGroup?(): void;
}

export interface DrawTextOptions {
  /** Id for the block's group, on a context that records groups. */
  readonly id?: string;
  /** Extra meta for the block's group, such as the source document's id. */
  readonly meta?: { [key: string]: JsonValue };
  /** The theme the layout was made with, for whether links are underlined. Default `DEFAULT_THEME`'s setting. */
  readonly theme?: Partial<Theme>;
  /** Font ascents for placing overlines and line-throughs; the layout's measurer. Default: a canvas. Asked only when a run is decorated. */
  readonly measurer?: TextMeasurer;
}

/**
 * Draws a layout as `fillText` calls, one per fragment, so a recording context
 * turns it into text ops with real positions and boxes. Underlines and overlines
 * are drawn before their text and line-throughs after it, as browsers do, as
 * filled rects. On a context that records groups, the block becomes a group
 * (with the layout's fingerprint in its meta) holding a group per line, and a
 * run with an `href` or `data` gets a group of its own inside its line, with
 * `{ type: "text-run", paragraph, run, href, data }` as meta, so a hit reports
 * the link.
 */
export const drawTextLayout = (ctx: TextTarget, layout: TextLayout, options: DrawTextOptions = {}): void => {
  const grouped = typeof ctx.beginGroup === "function" && typeof ctx.endGroup === "function";
  const linkUnderline = options.theme?.linkUnderline ?? DEFAULT_THEME.linkUnderline;
  if (grouped) {
    const { pretext, engine, fonts } = layout.fingerprint;
    ctx.beginGroup!({
      ...(options.id !== undefined ? { id: options.id } : {}),
      meta: { ...options.meta, type: "text-block", fingerprint: { pretext, engine, fonts: [...fonts] } },
    });
  }
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let measurer = options.measurer;
  const decorate = (f: TextFragment, baseline: number, size: number, lines: readonly ("underline" | "strikethrough" | "overline")[]): void => {
    if (lines.length === 0 || f.width <= 0) return;
    measurer ??= canvasMeasurer();
    const metrics = decorationMetrics(size, measurer.metrics(f.font).ascent);
    ctx.fillStyle = f.color;
    for (const kind of lines) ctx.fillRect(f.x, baseline + metrics[kind].offset, f.width, metrics[kind].thickness);
  };
  const draw = (f: TextFragment, baseline: number, paragraph: number): void => {
    if (f.text.length === 0) return;
    const p = layout.paragraphs[paragraph];
    const run = f.run >= 0 ? p?.runs[f.run] : undefined;
    const size = run?.size ?? p?.size ?? 16;
    const underline = run !== undefined && (run.underline === true || (run.href !== undefined && linkUnderline && run.underline !== false));
    decorate(f, baseline, size, [...(underline ? ["underline" as const] : []), ...(run?.overline ? ["overline" as const] : [])]);
    if (ctx.font !== f.font) ctx.font = f.font;
    ctx.fillStyle = f.color;
    ctx.direction = f.direction;
    ctx.fillText(f.text, f.x, baseline);
    if (run?.strikethrough) decorate(f, baseline, size, ["strikethrough"]);
  };
  layout.lines.forEach((line, index) => {
    if (grouped) ctx.beginGroup!({ meta: { type: "text-line", line: index, paragraph: line.paragraph } });
    if (line.marker) draw(line.marker, line.baseline, line.paragraph);
    // Consecutive fragments of a run with a link or data share one group.
    let open: number | null = null;
    for (const f of line.fragments) {
      const run = layout.paragraphs[line.paragraph]?.runs[f.run];
      const wanted = grouped && run && (run.href !== undefined || run.data !== undefined) ? f.run : null;
      if (open !== null && open !== wanted) {
        ctx.endGroup!();
        open = null;
      }
      if (wanted !== null && open === null) {
        ctx.beginGroup!({
          meta: {
            type: "text-run",
            paragraph: line.paragraph,
            run: wanted,
            ...(run!.href !== undefined ? { href: run!.href } : {}),
            ...(run!.data !== undefined ? { data: run!.data } : {}),
          },
        });
        open = wanted;
      }
      draw(f, line.baseline, line.paragraph);
    }
    if (open !== null) ctx.endGroup!();
    if (grouped) ctx.endGroup!();
  });
  ctx.restore();
  if (grouped) ctx.endGroup!();
};
