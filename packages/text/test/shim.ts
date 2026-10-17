import { type MeasurementTable, measurementKey } from "./fixtures";
import captured from "./captured.json";

/** Fonts in this family measure every character as half an em, for tests that need any string measured. */
export const HALF_EM_FAMILY = "Half Em Test";

const sizeOf = (font: string): number => Number(/([\d.]+)px/.exec(font)![1]);

/** A measurement where each character is half an em wide. */
export const halfEm = (font: string, text: string) => {
  const size = sizeOf(font);
  const width = [...text].length * size * 0.5;
  return {
    width,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: width,
    actualBoundingBoxAscent: size * 0.7,
    actualBoundingBoxDescent: size * 0.2,
    fontBoundingBoxAscent: size * 0.8,
    fontBoundingBoxDescent: size * 0.2,
  };
};

/**
 * Answers canvas measurement from the table captured in Chromium, as Pretext and
 * our measurer both ask it, and half-em fonts by rule. Pretext keeps the first
 * context it gets, so every test file installs this same shim.
 */
export const installMeasurementShim = (): void => {
  const table = captured.measurements as MeasurementTable;
  class ShimContext {
    font = "10px sans-serif";
    letterSpacing = "0px";
    wordSpacing = "0px";
    fontKerning = "auto";
    measureText(text: string): Record<string, number> {
      if (this.font.includes(HALF_EM_FAMILY)) return halfEm(this.font, text);
      const m = table[measurementKey(this, text)];
      if (!m) throw new Error(`no captured measurement for ${JSON.stringify(text)} in ${this.font}; run capture-text`);
      return m;
    }
  }
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    getContext(): ShimContext {
      return new ShimContext();
    }
  };
};
