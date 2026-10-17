import { beforeAll, describe, expect, test } from "bun:test";
import { setLocale } from "@chenglou/pretext";
import { RecordingContext, RecordingPath2D, Scene, pathRings } from "canvas-ir";
import {
  PRETEXT_VERSION,
  type Region,
  bandIntervals,
  drawTextLayout,
  flattenBlocks,
  layoutText,
  visualRuns,
} from "../src";
import captured from "./captured.json";
import { type MeasurementTable, fixtureOptions, layoutSnapshot, measurementKey, textFixtures } from "./fixtures";

/** Answers canvas measurement from the table captured in Chromium, as Pretext and our measurer both ask it. */
const installMeasurementShim = (table: MeasurementTable): void => {
  class ShimContext {
    font = "10px sans-serif";
    letterSpacing = "0px";
    wordSpacing = "0px";
    fontKerning = "auto";
    measureText(text: string): Record<string, number> {
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

beforeAll(() => {
  installMeasurementShim(captured.measurements as MeasurementTable);
  setLocale("en");
});

/** Deep equality with numbers compared to 1e-6, since Chromium and Bun may differ in the last bit of Math.cos. */
const expectClose = (actual: unknown, expected: unknown, path = "$"): void => {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(actual - expected) > 1e-6) throw new Error(`${path}: ${actual} is not ${expected}`);
    return;
  }
  if (Array.isArray(expected) || (expected && typeof expected === "object")) {
    expect(typeof actual).toBe("object");
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
    for (const k of keys) expectClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  expect(actual).toEqual(expected);
};

describe("layouts captured in Chromium", () => {
  test.each(textFixtures.map((f) => [f.name, f] as const))("%s lays out the same in Bun", (name, fixture) => {
    const layout = layoutText(fixture.text, fixtureOptions(fixture));
    expectClose(JSON.parse(JSON.stringify(layoutSnapshot(layout))), (captured.layouts as Record<string, unknown>)[name]);
  });

  test("the fingerprint names Pretext's version and every font measured", () => {
    const pkg = require("@chenglou/pretext/package.json") as { version: string };
    expect(PRETEXT_VERSION).toBe(pkg.version);
    const fixture = textFixtures.find((f) => f.name === "marks and mixed sizes")!;
    const { fingerprint } = layoutText(fixture.text, fixtureOptions(fixture));
    expect(fingerprint.engine).toBe("blink");
    expect(fingerprint.fonts).toContain('700 16px "Liberation Sans", sans-serif');
    expect(fingerprint.fonts).toContain('16px "DejaVu Sans Mono", monospace');
  });
});

describe("containers and obstacles", () => {
  const square: Region = { rings: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]] };

  test("a band through a rectangle is one interval", () => {
    expect(bandIntervals(square, [], 10, 30)).toEqual([[0, 100]]);
  });

  test("a band keeps only what is inside for its whole height", () => {
    const triangle: Region = { rings: [[{ x: 50, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]] };
    // At y = 40 the triangle spans 30..70 and at y = 60, 20..80: the band gets the narrower one.
    const [[l, r]] = bandIntervals(triangle, [], 40, 60) as [[number, number]];
    expect(l).toBeCloseTo(30, 9);
    expect(r).toBeCloseTo(70, 9);
  });

  test("a concave shape gives a band several intervals", () => {
    const u: Region = {
      rings: [[{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]],
    };
    expect(bandIntervals(u, [], 10, 20)).toEqual([[0, 30], [70, 100]]);
    // A band reaching below the notch's bottom loses the notch's span only where it's outside.
    expect(bandIntervals(u, [], 50, 70)).toEqual([[0, 30], [70, 100]]);
    expect(bandIntervals(u, [], 65, 80)).toEqual([[0, 100]]);
  });

  test("holes follow the fill rule", () => {
    const ring: Region = {
      rings: [square.rings[0]!, [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }]],
      fillRule: "evenodd",
    };
    expect(bandIntervals(ring, [], 45, 55)).toEqual([[0, 40], [60, 100]]);
    expect(bandIntervals({ ...ring, fillRule: "nonzero" }, [], 45, 55)).toEqual([[0, 100]]);
  });

  test("obstacles are cut out wherever they touch the band", () => {
    const obstacle: Region = { rings: [[{ x: 40, y: 50 }, { x: 60, y: 30 }, { x: 70, y: 50 }]] };
    // Its left edge is at x = 50 at the band's top and 45 at its bottom, its right edge at 65 and 67.5.
    expect(bandIntervals(square, [obstacle], 40, 45)).toEqual([[0, 45], [67.5, 100]]);
  });

  test("text fills a path container and stays inside it", () => {
    const path = new RecordingPath2D();
    path.ellipse(150, 100, 140, 90, 0, 0, Math.PI * 2);
    const ctx = new RecordingContext();
    ctx.fill(path);
    const op = ctx.getDocument().ops[0]!;
    const region: Region = { rings: pathRings((op as { path: Parameters<typeof pathRings>[0] }).path, 0.05) };
    const fixture = textFixtures.find((f) => f.name === "circle container")!;
    const layout = layoutText(fixture.text, { ...fixtureOptions(fixture), container: region });
    expect(layout.lines.length).toBeGreaterThan(5);
    const scene = new Scene(ctx.getDocument());
    for (const line of layout.lines) {
      for (const [x, y] of [
        [line.left, line.top],
        [line.right, line.top + line.height],
      ] as const) {
        expect(scene.hitTest({ x, y }, { tolerance: 0.1 })).toHaveLength(1);
      }
    }
  });

  test("obstacle margins keep text away from obstacles, and padding away from the outline", () => {
    const fixture = textFixtures.find((f) => f.name === "rectangle around a circular obstacle")!;
    const layout = layoutText(fixture.text, { ...fixtureOptions(fixture), obstacleMargin: 12, padding: 10 });
    expect(layout.lines.length).toBeGreaterThan(5);
    for (const line of layout.lines) {
      expect(line.top).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(line.top + line.height).toBeLessThanOrEqual(390 + 1e-9);
      for (const f of line.fragments) {
        expect(f.x).toBeGreaterThanOrEqual(10 - 1e-6);
        expect(f.x + f.width).toBeLessThanOrEqual(350 + 1e-6);
        // The fragment's box stays 12 from the circle of radius 60 at (180, 120), within the band tolerance.
        const dx = Math.max(f.x - 180, 0, 180 - (f.x + f.width));
        const dy = Math.max(line.top - 120, 0, 120 - (line.top + line.height));
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(72 - 0.5);
      }
    }
    // Without a margin, some line comes closer than that.
    const plain = layoutText(fixture.text, fixtureOptions(fixture));
    const closest = Math.min(
      ...plain.lines.flatMap((line) =>
        line.fragments.map((f) => Math.hypot(Math.max(f.x - 180, 0, 180 - (f.x + f.width)), Math.max(line.top - 120, 0, 120 - (line.top + line.height)))),
      ),
    );
    expect(closest).toBeLessThan(72 - 0.5);
  });

  test("text that doesn't fit is reported as overflow", () => {
    const fixture = textFixtures.find((f) => f.name === "triangle that runs out of room")!;
    expect(layoutText(fixture.text, fixtureOptions(fixture)).overflow).toBe(true);
    const roomy = textFixtures.find((f) => f.name === "plain paragraph")!;
    expect(layoutText(roomy.text, fixtureOptions(roomy)).overflow).toBe(false);
  });
});

describe("bidi", () => {
  test("runs are ordered visually", () => {
    // "abc " then Hebrew "אבג" then " def": in a left-to-right line the Hebrew stays in place, drawn right to left.
    const runs = visualRuns(["abc אבג def"], "ltr");
    expect(runs.map((r) => [r.start, r.end, r.rtl])).toEqual([
      [0, 4, false],
      [4, 7, true],
      [7, 11, false],
    ]);
    // In a right-to-left line "abc" reads first, so it is rightmost, and "def" leftmost.
    const rtl = visualRuns(["abc אבג def"], "rtl");
    expect(rtl.map((r) => [r.start, r.end, r.rtl])).toEqual([
      [8, 11, false],
      [3, 8, true],
      [0, 3, false],
    ]);
  });

  test("numbers inside right-to-left text keep their order", () => {
    const runs = visualRuns(["שנת 1998 היא"], "rtl");
    const text = "שנת 1998 היא";
    // Visually: "היא" leftmost, then 1998 left to right, then "שנת".
    expect(runs.map((r) => text.slice(r.start, r.end).trim()).filter(Boolean)).toEqual(["היא", "1998", "שנת"]);
    expect(runs.find((r) => text.slice(r.start, r.end) === "1998")!.rtl).toBe(false);
  });
});

describe("blocks", () => {
  test("lists flatten to indented paragraphs with markers", () => {
    const paragraphs = flattenBlocks({
      blocks: [
        {
          type: "list",
          items: [
            [{ type: "paragraph", content: ["one"] }, { type: "list", ordered: true, start: 3, items: [[{ type: "paragraph", content: ["nested"] }]] }],
            [{ type: "paragraph", content: ["two"] }],
          ],
        },
      ],
    });
    expect(paragraphs.map((p) => [p.runs[0]!.text, p.indent, p.marker])).toEqual([
      ["one", 28, "•"],
      ["nested", 56, "3."],
      ["two", 28, "•"],
    ]);
  });
});

describe("drawing", () => {
  test("a layout records as one text op per fragment, which hit-tests by line", () => {
    const fixture = textFixtures.find((f) => f.name === "headings, paragraphs and lists")!;
    const layout = layoutText(fixture.text, fixtureOptions(fixture));
    const ctx = new RecordingContext({
      // Whole fragments aren't in the table, since Pretext measures words: a rough em-based box does here.
      measureText: (text, style) => {
        const size = Number(/(\d+)px/.exec(style.font)![1]);
        const width = text.length * size * 0.5;
        return {
          width,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: width,
          actualBoundingBoxAscent: size * 0.7,
          actualBoundingBoxDescent: size * 0.2,
          fontBoundingBoxAscent: size * 0.8,
          fontBoundingBoxDescent: size * 0.2,
        };
      },
    });
    drawTextLayout(ctx, layout);
    const ops = ctx.getDocument().ops;
    const fragments = layout.lines.flatMap((l) => [...(l.marker ? [l.marker] : []), ...l.fragments]);
    expect(ops).toHaveLength(fragments.length);
    expect(ops.every((op) => op.kind === "text")).toBe(true);
    const first = layout.lines[0]!;
    const hits = new Scene(ctx.getDocument()).hitTest({ x: first.fragments[0]!.x + 2, y: first.baseline - 4 });
    expect(hits.map((h) => (h.op as { text: string }).text)).toEqual([first.fragments[0]!.text]);
    // The hit names its line's group, inside the block's group, whose meta has the fingerprint.
    const doc = ctx.getDocument();
    const [lineGroup, blockGroup] = hits[0]!.groups.map((id) => doc.groups!.find((g) => g.id === id)!);
    expect(lineGroup!.meta).toEqual({ type: "text-line", line: 0, paragraph: 0 });
    expect(blockGroup!.meta!.type).toBe("text-block");
    expect(blockGroup!.meta!.fingerprint).toEqual({ ...layout.fingerprint, fonts: [...layout.fingerprint.fonts] });
  });
});
