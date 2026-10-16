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
}

/**
 * Draws a layout as `fillText` calls, one per fragment, so a recording context
 * turns it into text ops with real positions and boxes.
 */
export const drawTextLayout = (ctx: TextTarget, layout: TextLayout): void => {
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
  for (const line of layout.lines) {
    if (line.marker) draw(line.marker, line.baseline);
    for (const f of line.fragments) draw(f, line.baseline);
  }
  ctx.restore();
};
