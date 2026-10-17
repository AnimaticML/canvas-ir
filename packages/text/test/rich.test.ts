import { beforeAll, describe, expect, test } from "bun:test";
import { RecordingContext, Scene, type TextMeasure, type TextStyle } from "canvas-ir";
import {
  type TextLayout,
  type TextMeasurer,
  LiveText,
  caretRect,
  decorationMetrics,
  drawTextLayout,
  layoutText,
  positionAtPoint,
  selectionRects,
} from "../src";
import { HALF_EM_FAMILY, halfEm, installMeasurementShim } from "./shim";

const FAMILY = HALF_EM_FAMILY;
const sizeOf = (font: string): number => Number(/([\d.]+)px/.exec(font)![1]);
const half = halfEm;
const measurer: TextMeasurer = {
  width: (font, text) => half(font, text).width,
  metrics: (font) => ({ ascent: sizeOf(font) * 0.8, descent: sizeOf(font) * 0.2 }),
};
const measureText = (text: string, style: TextStyle): TextMeasure => half(style.font, text);

beforeAll(installMeasurementShim);

const theme = { fontFamily: FAMILY, fontSize: 20, lineHeight: 1.5 };
const record = (layout: TextLayout) => {
  const ctx = new RecordingContext({ measureText });
  drawTextLayout(ctx, layout, { measurer });
  return ctx.getDocument();
};

describe("decorations", () => {
  test("metrics follow Chromium's fallbacks", () => {
    // Liberation Sans: ascent 0.905 em.
    expect(decorationMetrics(16, 14.48)).toEqual({
      underline: { offset: 1, thickness: 1 },
      strikethrough: { offset: -5, thickness: 1 },
      overline: { offset: -15, thickness: 1 },
    });
    expect(decorationMetrics(40, 36.2)).toEqual({
      underline: { offset: 2, thickness: 4 },
      strikethrough: { offset: -14, thickness: 4 },
      overline: { offset: -40, thickness: 4 },
    });
  });

  test("underlines and overlines come before their text, line-throughs after", () => {
    const layout = layoutText(
      { blocks: [{ type: "paragraph", content: ["a ", { text: "under", underline: true, overline: true }, " ", { text: "struck", strikethrough: true }] }] },
      { container: { x: 0, y: 0, width: 1000, height: 100 }, theme, measurer },
    );
    const ops = record(layout).ops;
    const kinds = ops.map((op) => (op.kind === "text" ? `text:${op.text}` : op.kind));
    const under = kinds.indexOf("text:under");
    const struck = kinds.indexOf("text:struck");
    expect(kinds.slice(under - 2, under)).toEqual(["fill", "fill"]);
    expect(kinds[struck + 1]).toBe("fill");
    const line = layout.lines[0]!;
    const fragment = line.fragments.find((f) => f.text === "under")!;
    const m = decorationMetrics(20, 16);
    const scene = new Scene(record(layout));
    const underline = scene.bounds(scene.document.ops[under - 2]!.id)!;
    expect(underline.x).toBeCloseTo(fragment.x);
    expect(underline.width).toBeCloseTo(fragment.width);
    expect(underline.y).toBeCloseTo(line.baseline + m.underline.offset);
    expect(underline.height).toBeCloseTo(m.underline.thickness);
  });
});

describe("links and run data", () => {
  const text = {
    blocks: [
      {
        type: "paragraph" as const,
        content: ["Read ", { text: "the long linked phrase here", href: "https://example.com/a" }, " or ", { text: "this", data: { card: 7 } }, "."],
      },
    ],
  };

  test("a link is colored, underlined and grouped once per line it spans", () => {
    const layout = layoutText(text, { container: { x: 0, y: 0, width: 200, height: 400 }, theme, measurer });
    const doc = record(layout);
    const runs = (doc.groups ?? []).filter((g) => g.meta?.type === "text-run");
    const linkGroups = runs.filter((g) => g.meta?.href === "https://example.com/a");
    const linkLines = new Set(layout.lines.filter((l) => l.fragments.some((f) => f.run === 1)).map((l) => l.paragraph + ":" + l.top));
    expect(linkLines.size).toBeGreaterThan(1);
    expect(linkGroups).toHaveLength(linkLines.size);
    expect(linkGroups.every((g) => g.meta?.run === 1 && g.meta?.paragraph === 0)).toBe(true);
    expect(runs.find((g) => g.meta?.run === 3)?.meta?.data).toEqual({ card: 7 });
    // Link groups sit inside line groups.
    for (const g of linkGroups) expect(doc.groups!.find((p) => p.id === g.parent)?.meta?.type).toBe("text-line");
    const linkFragments = layout.lines.flatMap((l) => l.fragments).filter((f) => f.run === 1);
    expect(linkFragments.every((f) => f.color === "#0b57d0")).toBe(true);
    // A hit on the link reports its group.
    const scene = new Scene(doc);
    const f = linkFragments[0]!;
    const line = layout.lines.find((l) => l.fragments.includes(f))!;
    const hit = scene.hitTest({ x: f.x + 3, y: line.baseline - 5 })[0]!;
    expect(hit.groups.some((id) => linkGroups.some((g) => g.id === id))).toBe(true);
  });

  test("links follow the theme", () => {
    const layout = layoutText(text, {
      container: { x: 0, y: 0, width: 2000, height: 400 },
      theme: { ...theme, linkColor: "red", linkUnderline: false },
      measurer,
    });
    expect(layout.lines[0]!.fragments.find((f) => f.run === 1)!.color).toBe("red");
    const ctx = new RecordingContext({ measureText });
    drawTextLayout(ctx, layout, { theme: { linkUnderline: false }, measurer });
    expect(ctx.getDocument().ops.some((op) => op.kind === "fill")).toBe(false);
  });
});

describe("caret and selection", () => {
  // 20px half-em: each character is 10px wide.
  const layout = () =>
    layoutText(
      { blocks: [{ type: "paragraph", content: ["abc ", { text: "defgh", bold: true }, " ijklmnop qrstu"] }, { type: "paragraph", content: ["xyz"] }] },
      { container: { x: 5, y: 0, width: 100, height: 400 }, theme, measurer },
    );

  test("a point maps to the nearest grapheme boundary on the nearest line", () => {
    const l = layout();
    const first = l.lines[0]!;
    expect(positionAtPoint(l, { x: 5 + 14, y: first.top + 2 }, measurer)).toEqual({ paragraph: 0, run: 0, offset: 1, line: 0 });
    expect(positionAtPoint(l, { x: 5 + 16, y: first.top + 2 }, measurer)).toMatchObject({ run: 0, offset: 2 });
    expect(positionAtPoint(l, { x: 5 + 42, y: first.top - 50 }, measurer)).toMatchObject({ run: 1, offset: 0, line: 0 });
    const last = l.lines[l.lines.length - 1]!;
    expect(positionAtPoint(l, { x: 1000, y: 10_000 }, measurer)).toMatchObject({ paragraph: 1, run: 0, offset: 3, line: l.lines.indexOf(last) });
  });

  test("caret rects sit at offsets and round-trip through positionAtPoint", () => {
    const l = layout();
    for (const [line, index] of l.lines.map((line, i) => [line, i] as const)) {
      for (const f of line.fragments) {
        for (let k = 0; k <= f.text.length; k++) {
          const p = { paragraph: line.paragraph, run: f.run, offset: f.sourceStart + k };
          const caret = caretRect(l, p, measurer)!;
          // A boundary shared with the next line's first fragment shows there.
          const next = l.lines.flatMap((x) => x.fragments).find((g) => g !== f && g.run === f.run && g.sourceStart === p.offset && f.sourceEnd === p.offset);
          if (next) {
            expect(caret.x).toBeCloseTo(next.x);
            continue;
          }
          expect(caret.x).toBeCloseTo(f.x + Math.min(k, f.text.trimEnd().length) * 10);
          if (k > 0 && k < f.text.length) {
            expect(caret.line).toBe(index);
            expect(positionAtPoint(l, { x: caret.x + 1, y: caret.top + 1 }, measurer)).toMatchObject(p);
          }
        }
      }
    }
  });

  test("a grapheme is never split", () => {
    const l = layoutText({ blocks: [{ type: "paragraph", content: ["aéb"] }] }, { container: { x: 0, y: 0, width: 500, height: 100 }, theme, measurer });
    const f = l.lines[0]!.fragments[0]!;
    // "e" + combining acute: offsets 1 and 3 are boundaries, 2 isn't.
    const offsets = Array.from({ length: 30 }, (_, i) => positionAtPoint(l, { x: f.x + i * (f.width / 30), y: 5 }, measurer)!.offset);
    expect(new Set(offsets)).toEqual(new Set([0, 1, 3, 4]));
  });

  test("selections give one rect per line, spanning collapsed spaces", () => {
    const l = layout();
    const a = { paragraph: 0, run: 0, offset: 1 };
    const b = { paragraph: 1, run: 0, offset: 2 };
    const rects = selectionRects(l, b, a, measurer);
    expect(rects.map((r) => r.line)).toEqual(l.lines.map((_, i) => i));
    expect(rects[0]!.x).toBeCloseTo(5 + 10);
    const lastLine = l.lines[l.lines.length - 1]!;
    expect(rects[rects.length - 1]!.width).toBeCloseTo(20);
    expect(rects[rects.length - 1]!.y).toBe(lastLine.top);
    expect(selectionRects(l, a, a, measurer)).toEqual([]);
  });

  test("right-to-left fragments run from their right edge", () => {
    const l = layoutText({ blocks: [{ type: "paragraph", direction: "rtl", content: ["אבג"] }] }, { container: { x: 0, y: 0, width: 300, height: 100 }, theme, measurer });
    const f = l.lines[0]!.fragments[0]!;
    expect(f.direction).toBe("rtl");
    expect(caretRect(l, { paragraph: 0, run: 0, offset: 0 }, measurer)!.x).toBeCloseTo(f.x + f.width);
    expect(caretRect(l, { paragraph: 0, run: 0, offset: 1 }, measurer)!.x).toBeCloseTo(f.x + f.width - 10);
  });
});

describe("live text", () => {
  const board = () => {
    const ctx = new RecordingContext({ measureText });
    ctx.beginGroup({ id: "column" });
    ctx.strokeRect(0, 0, 300, 300);
    ctx.endGroup();
    ctx.beginGroup({ id: "blob" });
    ctx.fillStyle = "purple";
    ctx.fillRect(100, 0, 60, 60);
    ctx.endGroup();
    ctx.fillRect(500, 500, 10, 10);
    return new Scene(ctx.getDocument());
  };
  const prose = "word ".repeat(80).trim();

  test("lays text out around obstacles and swaps its group in place", () => {
    const scene = board();
    const live = new LiveText(scene, {
      id: "column-text",
      parent: "column",
      text: { blocks: [{ type: "paragraph", content: [prose] }] },
      container: { x: 0, y: 0, width: 300, height: 300 },
      obstacles: ["blob"],
      obstacleMargin: 4,
      theme,
      measurer,
    });
    const first = live.update();
    const overlaps = (layout: TextLayout, x0: number, x1: number, y1: number) =>
      layout.lines.some((l) => l.top < y1 && l.fragments.some((f) => f.x < x1 && f.x + f.width > x0));
    expect(overlaps(first, 96, 164, 64)).toBe(false);
    const ids = scene.groupOps("column-text");
    expect(ids.length).toBeGreaterThan(0);
    expect(scene.groupChain(ids[0]!)).toContain("column");
    // The text is drawn before the later ops, after the column's outline.
    const order = scene.document.ops.map((op) => op.id);
    expect(order.indexOf(ids[0]!)).toBeGreaterThan(order.indexOf(scene.groupOps("column")[0]!));
    expect(live.dependsOn("blob")).toBe(true);
    expect(live.dependsOn(scene.groupOps("blob")[0]!)).toBe(true);
    expect(live.dependsOn("column")).toBe(false);

    scene.transform("blob", { a: 1, b: 0, c: 0, d: 1, e: 0, f: 150 });
    const second = live.update();
    expect(overlaps(second, 96, 164, 64)).toBe(true);
    const band = (layout: TextLayout) => layout.lines.filter((l) => l.top + l.height > 146 && l.top < 214);
    expect(band(second).some((l) => l.fragments.some((f) => f.x < 164 && f.x + f.width > 96))).toBe(false);
    // Swapped, not added: one block group, and the old ops are gone.
    expect((scene.document.groups ?? []).filter((g) => g.id === "column-text")).toHaveLength(1);
    expect(ids.some((id) => scene.get(id) !== undefined && !scene.groupOps("column-text").includes(id))).toBe(false);
    expect(scene.document.ops.filter((op) => op.kind === "text").length).toBe(second.lines.reduce((n, l) => n + l.fragments.length, 0));
  });
});
