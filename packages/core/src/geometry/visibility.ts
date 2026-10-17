import { parseColor } from "../color";
import type { Op, Paint } from "../types";

/** Whether a paint lays down no color at all: a fully transparent color, or a gradient whose every stop is one. */
export const paintIsTransparent = (paint: Paint): boolean => {
  if (typeof paint === "string") return parseColor(paint)?.a === 0;
  if (paint.kind === "pattern") return false;
  return paint.stops.length === 0 || paint.stops.every((s) => parseColor(s.color)?.a === 0);
};

/**
 * Whether an op paints nothing visible: drawn with `globalAlpha` 0, or with a
 * transparent paint (whose shadow is transparent too). `copy` is the exception:
 * it clears what is under a transparent paint, so it counts as visible.
 */
export const opIsInvisible = (op: Op): boolean => {
  if (op.kind === "clear" || op.kind === "embed") return false;
  if (op.compositing.globalAlpha === 0) return true;
  if (op.compositing.globalCompositeOperation === "copy") return false;
  switch (op.kind) {
    case "fill":
    case "text":
      return paintIsTransparent(op.paint);
    case "stroke":
      return paintIsTransparent(op.stroke.paint);
    case "image":
      return false;
  }
};
