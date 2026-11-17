import { createMeasurementSession, type MeasurementContextFactory, type MeasurementSession } from '@chenglou/pretext/rich-inline';

/**
 * Text measurement, injected so layout runs anywhere: the default asks a real
 * canvas, tests answer from a table captured in a browser.
 */
export interface FontMetrics {
  /** Ascent and descent of the font's em box as browsers use them for line layout, in px. */
  readonly ascent: number;
  readonly descent: number;
}

export interface TextMeasurer {
  /** Provider-scoped Pretext preparation; absent for the ambient Canvas backend. */
  readonly measurement?: MeasurementSession;
  width(font: string, text: string): number;
  metrics(font: string): FontMetrics;
}

type MeasureContext = { font: string; measureText(text: string): TextMetrics };

/**
 * Measures with an `OffscreenCanvas`, the same global Pretext measures with, so
 * a test shim installed for Pretext answers both.
 */
export const canvasMeasurer = (): TextMeasurer => {
  let ctx: MeasureContext | null = null;
  const context = (): MeasureContext => {
    if (ctx) return ctx;
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("No OffscreenCanvas to measure text with: pass a measurer, or install a measuring shim.");
    }
    ctx = new OffscreenCanvas(1, 1).getContext("2d") as unknown as MeasureContext;
    return ctx;
  };
  const metrics = new Map<string, FontMetrics>();
  return {
    width: (font, text) => {
      const c = context();
      c.font = font;
      return c.measureText(text).width;
    },
    metrics: (font) => {
      let m = metrics.get(font);
      if (!m) {
        const c = context();
        c.font = font;
        const t = c.measureText("");
        // Browsers lay out lines with the font's ascent and descent rounded to whole pixels.
        m = { ascent: Math.round(t.fontBoundingBoxAscent), descent: Math.round(t.fontBoundingBoxDescent) };
        metrics.set(font, m);
      }
      return m;
    },
  };
};

/** Uses one backend for line breaking, widths and caller-supplied font metrics. */
export const createTextMeasurer = (
  factory: MeasurementContextFactory,
  metrics: (font: string) => FontMetrics,
  options?: { language?: string | null },
): TextMeasurer => {
  const language = options?.language || null;
  let ctx: ReturnType<MeasurementContextFactory> | undefined;
  return {
    measurement: createMeasurementSession(factory, { language }),
    width(font, text) {
      ctx ??= factory(language);
      ctx.font = font;
      return ctx.measureText(text).width;
    },
    metrics,
  };
};
