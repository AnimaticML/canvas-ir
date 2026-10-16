// Text layout checks, bundled into the browser page with page.ts.
import { DEFAULT_THEME, type Paragraph, type TextLayout, type Theme, layoutText, runFont } from "@canvas-ir/text";
import { setLocale } from "@chenglou/pretext";
import {
  type MeasurementTable,
  type TextFixture,
  fixtureOptions,
  layoutSnapshot,
  measurementKey,
  textFixtures,
} from "../../text/test/fixtures";

export interface TextLineComparison {
  /** The line's text with whitespace removed, as laid out and as the DOM wrapped it. */
  readonly ours: string;
  readonly dom: string;
  /** Top of the line's glyph boxes, ours and the DOM's. */
  readonly oursTop: number;
  readonly domTop: number;
  /** Left and right ends of the line's ink run, ours and the DOM's. */
  readonly oursLeft: number;
  readonly oursRight: number;
  readonly domLeft: number;
  readonly domRight: number;
}

export interface TextResult {
  readonly name: string;
  readonly lines: readonly TextLineComparison[];
  /** Height of the whole layout, ours and the DOM's. */
  readonly height: number;
  readonly domHeight: number;
  readonly error?: string;
}

const compact = (s: string): string => s.replace(/\s+/g, "");

/** The same paragraphs as DOM: one div per paragraph with the layout's fonts, spacing and indents. */
const buildDom = (layout: TextLayout, fixture: TextFixture, theme: Theme): HTMLDivElement => {
  const root = document.createElement("div");
  root.style.cssText = `position: absolute; left: 0; top: 0; width: ${fixture.width}px; margin: 0; padding: 0;`;
  layout.paragraphs.forEach((p: Paragraph) => {
    const div = document.createElement("div");
    const dir = p.direction === "auto" ? "auto" : p.direction;
    div.dir = dir;
    div.style.cssText = [
      "margin: 0",
      `font: ${p.font}`,
      `line-height: ${theme.lineHeight}`,
      `padding: ${p.spaceBefore}px 0 ${p.spaceAfter}px 0`,
      `padding-inline-start: ${p.indent}px`,
      `text-align: ${p.align}`,
      "overflow-wrap: break-word",
      "white-space: normal",
    ].join("; ");
    for (const run of p.runs) {
      const span = document.createElement("span");
      span.style.font = runFont(run, p, theme);
      // The font shorthand resets line-height; inherit the paragraph's unitless one.
      span.style.lineHeight = "inherit";
      if (run.color) span.style.color = run.color;
      span.textContent = run.text;
      div.appendChild(span);
    }
    if (p.runs.every((r) => r.text.length === 0)) div.appendChild(document.createElement("br"));
    root.appendChild(div);
  });
  document.body.appendChild(root);
  return root;
};

/** Lines as the browser wrapped them: characters grouped by line box, in logical order. */
const domLines = (div: HTMLElement): { text: string; top: number; left: number; right: number }[] => {
  const lines: { text: string; top: number; bottom: number; left: number; right: number }[] = [];
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + len);
      const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 || r.height > 0);
      const ch = text.slice(i, i + len);
      i += len;
      if (!rect) continue;
      if (/\s/.test(ch)) continue;
      const mid = (rect.top + rect.bottom) / 2;
      let line = lines.find((l) => mid >= l.top && mid <= l.bottom);
      if (!line) {
        line = { text: "", top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        lines.push(line);
      }
      line.text += ch;
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    }
  }
  return lines.sort((a, b) => a.top - b.top);
};

const runText = (fixture: TextFixture): TextResult => {
  const theme: Theme = { ...DEFAULT_THEME, ...fixture.theme };
  const layout = layoutText(fixture.text, fixtureOptions(fixture));
  const root = buildDom(layout, fixture, theme);
  try {
    const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
    const ascent = (font: string): number => {
      measure.font = font;
      return Math.round(measure.measureText("").fontBoundingBoxAscent);
    };
    const lines: TextLineComparison[] = [];
    layout.paragraphs.forEach((_, index) => {
      const ours = layout.lines.filter((l) => l.paragraph === index);
      const dom = domLines(root.children[index] as HTMLElement);
      for (let i = 0; i < Math.max(ours.length, dom.length); i++) {
        const line = ours[i];
        const logical = line ? [...line.fragments].sort((a, b) => a.run - b.run || a.sourceStart - b.sourceStart) : [];
        lines.push({
          ours: compact(logical.map((f) => f.text).join("")),
          dom: dom[i]?.text ?? "",
          oursTop: line ? Math.min(...line.fragments.map((f) => line.baseline - ascent(f.font)), Infinity) : NaN,
          domTop: dom[i]?.top ?? NaN,
          oursLeft: line ? Math.min(...line.fragments.map((f) => f.x)) : NaN,
          oursRight: line ? Math.max(...line.fragments.map((f) => f.x + f.width)) : NaN,
          domLeft: dom[i]?.left ?? NaN,
          domRight: dom[i]?.right ?? NaN,
        });
      }
    });
    return { name: fixture.name, lines, height: layout.bottom - layout.top, domHeight: root.getBoundingClientRect().height };
  } finally {
    root.remove();
  }
};

export const runTextLayouts = async (): Promise<TextResult[]> => {
  document.documentElement.lang = "en";
  setLocale("en");
  await document.fonts.ready;
  return textFixtures.filter((f) => f.width !== undefined).map((f) => {
    try {
      return runText(f);
    } catch (error) {
      return { name: f.name, lines: [], height: 0, domHeight: 0, error: String(error) };
    }
  });
};

/**
 * Lays out every fixture with canvas measurement logged, and returns what was
 * measured and what came out, for the Bun tests to replay without a browser.
 */
export const captureText = async (): Promise<{ measurements: MeasurementTable; layouts: Record<string, unknown> }> => {
  document.documentElement.lang = "en";
  setLocale("en");
  await document.fonts.ready;
  const measurements: MeasurementTable = {};
  const protos = [OffscreenCanvasRenderingContext2D.prototype, CanvasRenderingContext2D.prototype];
  const originals = protos.map((p) => p.measureText);
  const fontDescriptors = protos.map((p) => Object.getOwnPropertyDescriptor(p, "font")!);
  // Keyed by the font string as it was assigned: the getter serializes it differently ("700" reads back as "bold").
  const assigned = new WeakMap<object, string>();
  protos.forEach((proto, i) => {
    const original = originals[i]!;
    const descriptor = fontDescriptors[i]!;
    Object.defineProperty(proto, "font", {
      ...descriptor,
      set(this: CanvasRenderingContext2D, value: string) {
        assigned.set(this, value);
        descriptor.set!.call(this, value);
      },
    });
    proto.measureText = function (this: CanvasRenderingContext2D, text: string) {
      const m = original.call(this, text);
      const state = {
        font: assigned.get(this) ?? "10px sans-serif",
        letterSpacing: this.letterSpacing,
        wordSpacing: this.wordSpacing,
        fontKerning: this.fontKerning,
      };
      measurements[measurementKey(state, text)] = {
        width: m.width,
        actualBoundingBoxLeft: m.actualBoundingBoxLeft,
        actualBoundingBoxRight: m.actualBoundingBoxRight,
        actualBoundingBoxAscent: m.actualBoundingBoxAscent,
        actualBoundingBoxDescent: m.actualBoundingBoxDescent,
        fontBoundingBoxAscent: m.fontBoundingBoxAscent,
        fontBoundingBoxDescent: m.fontBoundingBoxDescent,
      };
      return m;
    };
  });
  try {
    const layouts: Record<string, unknown> = {};
    for (const f of textFixtures) layouts[f.name] = layoutSnapshot(layoutText(f.text, fixtureOptions(f)));
    return { measurements, layouts };
  } finally {
    protos.forEach((proto, i) => {
      proto.measureText = originals[i]!;
      Object.defineProperty(proto, "font", fontDescriptors[i]!);
    });
  }
};

(globalThis as { runTextLayouts?: typeof runTextLayouts }).runTextLayouts = runTextLayouts;
(globalThis as { captureText?: typeof captureText }).captureText = captureText;
