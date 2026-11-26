import { describe, expect, test } from "bun:test";
import { RecordingContext, type TextMeasure, type TextStyle } from "canvas-ir";
import { fillFitted, fitText } from "../src/index";

// Each character is as wide as 0.6 of the font's size.
const measureText = (text: string, style: TextStyle): TextMeasure => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(style.font)?.[1] ?? 10);
  const w = text.length * size * 0.6;
  return {
    width: w,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: w,
    actualBoundingBoxAscent: size * 0.8,
    actualBoundingBoxDescent: size * 0.2,
    fontBoundingBoxAscent: size * 0.9,
    fontBoundingBoxDescent: size * 0.3,
  };
};
const ctx = () => new RecordingContext({ measureText });

describe("fitText", () => {
  test("a short word grows to the box's height, a long one shrinks to its width", () => {
    const c = ctx();
    // One line of "hi": 1.25 × size ≤ 100 → 80, but the default largest is 72.
    expect(fitText(c, "hi", { width: 400, height: 100 }).size).toBe(72);
    expect(fitText(c, "hi", { width: 400, height: 100 }, { max: 200 }).size).toBe(80);
    // 10 characters across 120: size ≤ 20.
    const t = fitText(c, "abcdefghij", { width: 120, height: 400 });
    expect(t.size).toBe(20);
    expect(t.lines).toEqual(["abcdefghij"]);
    expect(t.fits).toBe(true);
  });

  test("words wrap onto lines when that lets them be bigger", () => {
    const t = fitText(ctx(), "one two three four", { width: 200, height: 200 });
    expect(t.lines.length).toBeGreaterThan(1);
    // Larger than on one line, which would be 200 / (18 × 0.6) = 18.
    expect(t.size).toBeGreaterThan(18);
    expect(t.lines.length * t.lineHeight).toBeLessThanOrEqual(200);
    for (const l of t.lines) expect(l.length * t.size * 0.6).toBeLessThanOrEqual(200);
  });

  test("text that does not fit at the smallest size says so; the font is left as it was", () => {
    const c = ctx();
    c.font = "13px serif";
    const t = fitText(c, "a very long sentence indeed", { width: 20, height: 10 }, { min: 6 });
    expect(t.size).toBe(6);
    expect(t.fits).toBe(false);
    expect(c.font).toBe("13px serif");
  });

  test("without wrapping, lines stay as written", () => {
    const t = fitText(ctx(), "one two\nthree", { width: 300, height: 300 }, { wrap: false, max: 300 });
    expect(t.lines).toEqual(["one two", "three"]);
    // "one two" is 7 characters across 300: size ≤ 71.
    expect(t.size).toBe(71);
  });

  test("fillFitted draws each line, centred in the box, at the size it found", () => {
    const c = ctx();
    const t = fillFitted(c, "one two three four", { x: 10, y: 20, width: 200, height: 200 }, { font: "system-ui", weight: "600" });
    const texts = c.getDocument().ops.filter((o) => o.kind === "text");
    expect(texts.map((o) => (o as { text: string }).text)).toEqual([...t.lines]);
    for (const o of texts) expect((o as { x: number }).x).toBe(110);
    expect(t.font).toBe(`600 ${t.size}px system-ui`);
  });
});
