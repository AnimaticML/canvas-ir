import { expect, test } from "bun:test";
import { createTextMeasurer, layoutText } from "../src/index";

const text = { blocks: [{ type: "paragraph" as const, content: ["AVML text measurement"] }] };
const theme = { fontFamily: "sans-serif", fontSize: 20, lineHeight: 1.2, paragraphSpacing: 0 };

const backend = (advance: number) => {
  let calls = 0;
  let metrics = 0;
  const measurer = createTextMeasurer(() => ({
    font: "20px sans-serif",
    measureText(value) {
      calls++;
      const width = [...value].length * advance;
      return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width };
    },
  }), () => {
    metrics++;
    return { ascent: 16, descent: 4 };
  }, { language: null });
  return { measurer, calls: () => calls, metrics: () => metrics };
};

test("supplied measurement reaches both Pretext preparation and font metrics", () => {
  const source = backend(10);
  const layout = layoutText(text, {
    container: { x: 0, y: 0, width: 240, height: 100 }, theme, measurer: source.measurer,
  });
  expect(layout.overflow).toBe(false);
  expect(layout.lines).toHaveLength(1);
  expect(layout.lines[0]?.width).toBe(210);
  expect(source.calls()).toBeGreaterThan(0);
  expect(source.metrics()).toBeGreaterThan(0);
  expect(layout.lines.every(line => Number.isFinite(line.baseline))).toBe(true);
});

test("interleaved same-font providers keep separate wrapping and cached widths", () => {
  const narrow = backend(5);
  const wide = backend(15);
  const options = { container: { x: 0, y: 0, width: 240, height: 200 }, theme };
  const narrowLayout = layoutText(text, { ...options, measurer: narrow.measurer });
  const wideLayout = layoutText(text, { ...options, measurer: wide.measurer });
  const count = narrow.calls();
  expect(narrowLayout.lines).toHaveLength(1);
  expect(wideLayout.lines.length).toBeGreaterThan(narrowLayout.lines.length);
  expect(layoutText(text, { ...options, measurer: narrow.measurer })).toEqual(narrowLayout);
  expect(narrow.calls()).toBe(count);
});

test("backend layout never replaces or reads the page canvas globals", () => {
  const module = new URL("../src/index.ts", import.meta.url).href;
  const source = `
    for (const key of ['OffscreenCanvas', 'document']) {
      Object.defineProperty(globalThis, key, { get() { throw new Error('unexpected global: ' + key) } })
    }
    const { createTextMeasurer, layoutText } = await import(${JSON.stringify(module)})
    const measurer = createTextMeasurer(() => ({
      font: '20px sans-serif',
      measureText(text) { const width = [...text].length * 30; return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width } },
    }), () => ({ ascent: 16, descent: 4 }))
    const layout = layoutText({ blocks: [{ type: 'paragraph', content: ['hello 😀'] }] }, {
      container: { x: 0, y: 0, width: 500, height: 100 }, measurer,
    })
    if (layout.lines.length === 0) throw new Error('no lines')
    console.log('no globals used')
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", source]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("no globals used");
});
