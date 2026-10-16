import type { JsonValue } from "canvas-ir";
import type { TextFragment, TextLayout } from "./layout";

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
  /** Present on a `RecordingContext`; used to group the block and its lines. */
  beginGroup?(options: { id?: string; meta?: { [key: string]: JsonValue } }): string;
  endGroup?(): void;
}

export interface DrawTextOptions {
  /** Id for the block's group, on a context that records groups. */
  readonly id?: string;
  /** Extra meta for the block's group, such as the source document's id. */
  readonly meta?: { [key: string]: JsonValue };
}

/**
 * Draws a layout as `fillText` calls, one per fragment, so a recording context
 * turns it into text ops with real positions and boxes. On a context that
 * records groups, the block becomes a group (with the layout's fingerprint in
 * its meta) holding a group per line, so a hit reports the line.
 */
export const drawTextLayout = (ctx: TextTarget, layout: TextLayout, options: DrawTextOptions = {}): void => {
  const grouped = typeof ctx.beginGroup === "function" && typeof ctx.endGroup === "function";
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
  const draw = (f: TextFragment, baseline: number): void => {
    if (f.text.length === 0) return;
    if (ctx.font !== f.font) ctx.font = f.font;
    ctx.fillStyle = f.color;
    ctx.direction = f.direction;
    ctx.fillText(f.text, f.x, baseline);
  };
  layout.lines.forEach((line, index) => {
    if (grouped) ctx.beginGroup!({ meta: { type: "text-line", line: index, paragraph: line.paragraph } });
    if (line.marker) draw(line.marker, line.baseline);
    for (const f of line.fragments) draw(f, line.baseline);
    if (grouped) ctx.endGroup!();
  });
  ctx.restore();
  if (grouped) ctx.endGroup!();
};
