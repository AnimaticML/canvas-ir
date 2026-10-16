import { canvasColor } from "./color";
import { indexSizeError } from "./path";
import type { ColorStop, GradientPaint, ImageRef, Matrix2D, PatternPaint, PatternRepetition } from "./types";
import { IDENTITY, allFinite } from "./math";

type GradientGeometry =
  | { readonly kind: "linear"; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
  | {
      readonly kind: "radial";
      readonly x0: number;
      readonly y0: number;
      readonly r0: number;
      readonly x1: number;
      readonly y1: number;
      readonly r1: number;
    }
  | { readonly kind: "conic"; readonly startAngle: number; readonly x: number; readonly y: number };

const requireFinite = (method: string, values: readonly number[]): void => {
  if (!values.every(Number.isFinite)) {
    throw new TypeError(`Failed to execute '${method}': The provided double value is non-finite.`);
  }
};

/**
 * What `createLinearGradient` and friends return. Like `CanvasGradient`, stops
 * added after it is assigned to a style still apply to later drawing, so ops
 * snapshot it when they are recorded.
 */
export class RecordingGradient {
  private readonly stops: ColorStop[] = [];

  /** @internal Use the context's create*Gradient methods. */
  constructor(private readonly geometry: GradientGeometry) {}

  addColorStop(offset: number, color: string): void {
    requireFinite("addColorStop", [offset]);
    if (offset < 0 || offset > 1) throw indexSizeError(`The provided value (${offset}) is outside the range (0.0, 1.0).`);
    const parsed = canvasColor(String(color));
    if (parsed === null) {
      throw typeof DOMException === "function"
        ? new DOMException(`The value provided ('${String(color)}') could not be parsed as a color.`, "SyntaxError")
        : new SyntaxError(`The value provided ('${String(color)}') could not be parsed as a color.`);
    }
    this.stops.push({ offset, color: parsed });
  }

  /** @internal */
  snapshot(): GradientPaint {
    return { ...this.geometry, stops: [...this.stops] };
  }
}

export const createLinearGradient = (x0: number, y0: number, x1: number, y1: number): RecordingGradient => {
  requireFinite("createLinearGradient", [x0, y0, x1, y1]);
  return new RecordingGradient({ kind: "linear", x0, y0, x1, y1 });
};

export const createRadialGradient = (
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
): RecordingGradient => {
  requireFinite("createRadialGradient", [x0, y0, r0, x1, y1, r1]);
  if (r0 < 0 || r1 < 0) throw indexSizeError(`The ${r0 < 0 ? "r0" : "r1"} provided is less than 0.`);
  return new RecordingGradient({ kind: "radial", x0, y0, r0, x1, y1, r1 });
};

export const createConicGradient = (startAngle: number, x: number, y: number): RecordingGradient => {
  requireFinite("createConicGradient", [startAngle, x, y]);
  return new RecordingGradient({ kind: "conic", startAngle, x, y });
};

const REPETITIONS: readonly string[] = ["repeat", "repeat-x", "repeat-y", "no-repeat"];

export const parseRepetition = (value: string | null): PatternRepetition => {
  if (value === null || value === "") return "repeat";
  if (REPETITIONS.includes(value)) return value as PatternRepetition;
  throw typeof DOMException === "function"
    ? new DOMException(`The provided type ('${value}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`, "SyntaxError")
    : new SyntaxError(`The provided type ('${value}') is not a valid pattern repetition.`);
};

/** What `createPattern` returns. Its transform can be changed after it is assigned, so ops snapshot it. */
export class RecordingPattern {
  private matrix: Matrix2D = IDENTITY;

  /** @internal Use the context's createPattern. */
  constructor(
    private readonly image: ImageRef,
    private readonly repetition: PatternRepetition,
  ) {}

  setTransform(transform: Partial<Matrix2D> & { m11?: number; m12?: number; m21?: number; m22?: number; m41?: number; m42?: number } = {}): void {
    const m = {
      a: transform.a ?? transform.m11 ?? 1,
      b: transform.b ?? transform.m12 ?? 0,
      c: transform.c ?? transform.m21 ?? 0,
      d: transform.d ?? transform.m22 ?? 1,
      e: transform.e ?? transform.m41 ?? 0,
      f: transform.f ?? transform.m42 ?? 0,
    };
    if (!allFinite(m.a, m.b, m.c, m.d, m.e, m.f)) throw new TypeError("setTransform() was given a matrix with non-finite values.");
    this.matrix = m;
  }

  /** @internal */
  snapshot(): PatternPaint {
    return { kind: "pattern", image: this.image, repetition: this.repetition, transform: this.matrix };
  }
}
