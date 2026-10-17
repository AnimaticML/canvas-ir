// Pixel test, run in headless Chromium. For every fixture and every SVG in the
// corpus, replaying the recorded document must paint exactly what direct drawing
// paints, plainly or with transform calls applied as one `setTransform` of the same
// matrix, and may differ from plain direct drawing only in anti-aliased edge pixels
// (see withComposedTransforms in page.ts). Hit tests must agree with Chromium's.
// Each drawing's SVG export, rendered by Chromium, must match its replay away
// from edges. SVG_DEBUG=<name> writes that drawing's export and both renderings
// to SVG_DEBUG_DIR. Text layouts must break and place lines as the DOM does, and
// text decorations must land within a pixel of the DOM's. Traced image
// outlines must hit-test like the painted alpha away from their edges. Partial
// redraws must match a full replay away from anti-aliased edges, lifted layers
// within rounding, and a drag on a 10,000-op board must stay under a 16 ms frame.
import { chromium } from "playwright-core";
import { readdir } from "node:fs/promises";
import type { Comparison, CorpusResult, FixtureResult, GeometryResult, SvgResult } from "./page";
import { checkDecorations } from "./decorations";
import type { OutlineResult } from "./outline-page";
import type { DragBench, RenderCheck } from "./render-page";
import type { VectorizeReport } from "./vectorize-page";
import { vectorizeSources } from "./vectorize-sources";
import type { TextResult } from "./text-page";

const describe = (c: Comparison): string =>
  c.differentPixels === 0
    ? "equal"
    : `${c.differentPixels} edge pixels differ by up to ${c.maxChannelDelta}` +
      (c.interiorPixels > 0 ? `, ${c.interiorPixels} interior pixels differ` : "");

const build = await Bun.build({ entrypoints: [new URL("./page.ts", import.meta.url).pathname], target: "browser" });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}
const bundle = await build.outputs[0]!.text();

const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate(() =>
    (globalThis as unknown as { runFixtures: () => FixtureResult[] }).runFixtures(),
  );

  let failed = 0;
  const reportFixture = (r: FixtureResult): void => {
    // Equal to either reference is exact: the composed one can itself be off by float noise
    // (a matrix composed in double that lands next to the identity, where Chromium's float math hits it).
    const equal = r.exact?.differentPixels === 0 || r.direct?.differentPixels === 0;
    const exactEnough = r.engineDeviation ? r.exact?.interiorPixels === 0 : equal;
    const ok = exactEnough && r.direct?.interiorPixels === 0;
    if (!ok) failed++;
    const detail =
      r.error ??
      `exact: ${describe(r.exact!)}; direct drawing: ${describe(r.direct!)}`;
    console.log(`${ok ? "pass" : "FAIL"}  ${r.name}  (${detail})`);
    if (r.engineDeviation && r.exact?.differentPixels) console.log(`      known deviation: ${r.engineDeviation}`);
  };
  results.forEach(reportFixture);
  console.log(`\n${results.length - failed} of ${results.length} fixtures replay pixel-equal\n`);

  // Hit tests must agree with Chromium's isPointInPath / isPointInStroke away from edges.
  const geometry = await page.evaluate(() =>
    (globalThis as unknown as { runGeometry: () => GeometryResult[] }).runGeometry(),
  );
  let geometryFailed = 0;
  const reportGeometry = (r: GeometryResult): void => {
    // A known engine deviation may disagree on up to 1% of points.
    const ok = r.engineDeviation ? r.mismatchCount <= r.compared * 0.01 : r.mismatchCount === 0;
    if (!ok) geometryFailed++;
    const detail = r.mismatchCount > 0 ? `, ${r.mismatchCount} disagree` : "";
    console.log(`${ok ? "pass" : "FAIL"}  hit test: ${r.name}  (${r.compared} points${detail})`);
    if (!ok) for (const m of r.mismatches) console.log(`      ${m}`);
    if (r.engineDeviation && r.mismatchCount > 0) console.log(`      known deviation: ${r.engineDeviation}`);
  };
  geometry.forEach(reportGeometry);
  console.log(`\n${geometry.length - geometryFailed} of ${geometry.length} fixtures hit-test like Chromium\n`);
  failed += geometryFailed;

  // The corpus: SVG files drawn by canvg, an SVG renderer that targets Canvas 2D.
  const corpusDir = new URL("../corpus/", import.meta.url).pathname;
  const files = await Promise.all(
    (await readdir(corpusDir))
      .filter((f) => f.endsWith(".svg") && (!process.env.CORPUS || f.startsWith(process.env.CORPUS)))
      .sort()
      .map(async (f) => {
        const svg = await Bun.file(corpusDir + f).text();
        // A file can declare a known engine deviation in a comment, like the fixtures do.
        const deviation = /<!--\s*engine-deviation:\s*([\s\S]*?)\s*-->/.exec(svg)?.[1];
        const svgDeviation = /<!--\s*svg-deviation:\s*([\s\S]*?)\s*-->/.exec(svg)?.[1];
        return {
          name: f,
          svg,
          ...(deviation ? { engineDeviation: deviation.replace(/\s+/g, " ") } : {}),
          ...(svgDeviation ? { svgDeviation: svgDeviation.replace(/\s+/g, " ") } : {}),
        };
      }),
  );
  const corpus = await page.evaluate(
    (f) => (globalThis as unknown as { runCorpus: (f: unknown) => Promise<CorpusResult[]> }).runCorpus(f),
    files,
  );
  const failedBefore = failed;
  geometryFailed = 0;
  for (const r of corpus) {
    reportFixture(r.fixture);
    if (r.geometry) reportGeometry(r.geometry);
    if (r.ops) console.log(`      ops: ${Object.entries(r.ops).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }
  failed += geometryFailed;
  const corpusFailed = failed - failedBefore;
  console.log(`\n${corpus.length} corpus files, ${corpusFailed === 0 ? "all replay pixel-equal and hit-test like Chromium" : `${corpusFailed} checks failed`}\n`);

  // SVG export: Chromium's rendering of the export must match the replay but for anti-aliasing.
  const svgs = await page.evaluate(
    (f) => (globalThis as unknown as { runSvg: (f: unknown) => Promise<SvgResult[]> }).runSvg(f),
    files,
  );
  if (process.env.SVG_DEBUG) {
    await page.evaluate((n) => ((globalThis as { svgDebug?: string }).svgDebug = n), process.env.SVG_DEBUG);
    await page.evaluate((f) => (globalThis as unknown as { runSvg: (f: unknown) => Promise<SvgResult[]> }).runSvg(f), files);
    const out = (await page.evaluate(() => (globalThis as { svgDebugOut?: unknown }).svgDebugOut)) as { svg: string; replay: number[]; exported: number[] };
    const dir = process.env.SVG_DEBUG_DIR ?? ".";
    await Bun.write(`${dir}/export.svg`, out.svg);
    await Bun.write(`${dir}/replay.png`, new Uint8Array(out.replay));
    await Bun.write(`${dir}/exported.png`, new Uint8Array(out.exported));
  }
  let svgFailed = 0;
  for (const r of svgs) {
    const ok = !r.error && (r.engineDeviation !== undefined || r.far === 0);
    if (!ok) svgFailed++;
    const detail = r.error ?? `${describe(r.comparison!)}; ${r.far} away from edges`;
    console.log(`${ok ? "pass" : "FAIL"}  svg: ${r.name}  (${detail})`);
    if (r.engineDeviation && r.far) console.log(`      known deviation: ${r.engineDeviation}`);
  }
  console.log(`\n${svgs.length - svgFailed} of ${svgs.length} SVG exports render like the replay\n`);
  failed += svgFailed;

  // Text layout: lines must break where the browser's DOM layout breaks them, at the same heights.
  const texts = await page.evaluate(() =>
    (globalThis as unknown as { runTextLayouts: () => Promise<TextResult[]> }).runTextLayouts(),
  );
  let textFailed = 0;
  for (const r of texts) {
    const wrapsDiffer = r.lines.filter((l) => l.ours !== l.dom);
    const offset = r.lines.filter((l) => !(Math.abs(l.oursTop - l.domTop) <= 1));
    const shifted = r.lines.filter((l) => !(Math.abs(l.oursLeft - l.domLeft) <= 1 && Math.abs(l.oursRight - l.domRight) <= 1));
    const heightOff = Math.abs(r.height - r.domHeight) > 1;
    const ok = !r.error && r.lines.length > 0 && wrapsDiffer.length === 0 && offset.length === 0 && shifted.length === 0 && !heightOff;
    if (!ok) textFailed++;
    const detail = r.error ?? `${r.lines.length} lines, height ${r.height.toFixed(2)} vs DOM ${r.domHeight.toFixed(2)}`;
    console.log(`${ok ? "pass" : "FAIL"}  text: ${r.name}  (${detail})`);
    for (const l of wrapsDiffer.slice(0, 4)) console.log(`      wraps differ: ours "${l.ours}"\n                    DOM  "${l.dom}"`);
    for (const l of offset.slice(0, 3)) console.log(`      line top ${l.oursTop.toFixed(2)}, DOM ${l.domTop.toFixed(2)}: "${l.dom.slice(0, 30)}"`);
    for (const l of shifted.slice(0, 3)) {
      const span = (a: number, b: number): string => `${a.toFixed(2)}..${b.toFixed(2)}`;
      console.log(`      line spans ${span(l.oursLeft, l.oursRight)}, DOM ${span(l.domLeft, l.domRight)}: "${l.dom.slice(0, 30)}"`);
    }
  }
  console.log(`\n${texts.length - textFailed} of ${texts.length} text layouts match the DOM`);
  failed += textFailed;

  // Image outlines: hit tests on traced silhouettes agree with the painted alpha away from the outline.
  const outlines = await page.evaluate(() => (globalThis as unknown as { runOutlines: () => OutlineResult[] }).runOutlines());
  let outlinesFailed = 0;
  for (const r of outlines) {
    const ok = !r.error && r.disagree === 0 && r.checked > 0;
    if (!ok) outlinesFailed++;
    const detail = r.error ?? `${r.rings} rings, ${r.points} points; ${r.checked} pixels checked, ${r.disagree} disagree`;
    console.log(`${ok ? "pass" : "FAIL"}  outline: ${r.name}  (${detail})`);
  }
  console.log(`\n${outlines.length - outlinesFailed} of ${outlines.length} image outlines hit-test like the painted alpha\n`);
  failed += outlinesFailed;

  // The renderer: partial redraws and layers against full replays, and a drag on a big board.
  const renders = await page.evaluate(() => (globalThis as unknown as { runRender: () => Promise<RenderCheck[]> }).runRender());
  let rendersFailed = 0;
  for (const r of renders) {
    const ok = !r.error && r.mismatched === 0 && r.frames > 0;
    if (!ok) rendersFailed++;
    const modes = Object.entries(r.modes)
      .map(([mode, n]) => `${n} ${mode}`)
      .join(", ");
    const pans = r.panned ? `; after ${r.panned.frames} pans, ${r.panned.edgePixels} edge pixels, by up to ${r.panned.maxDelta}` : "";
    const detail = `${r.frames} frames: ${modes}; ${r.edgePixels} edge pixels differed, by up to ${r.maxDelta}${pans}${r.mismatched ? `; ${r.mismatched} frames differ away from edges` : ""}`;
    console.log(`${ok ? "pass" : "FAIL"}  render: ${r.name}  (${detail})`);
    if (r.error) console.log(`      ${r.error}`);
  }
  const drags = await page.evaluate(() => (globalThis as unknown as { runDragBench: () => DragBench[] }).runDragBench());
  for (const d of drags) {
    // Full replay is the baseline, not gated.
    const gated = !d.mode.endsWith("full replay") && !(d.mode.startsWith("a panel") && d.mode.endsWith("partial"));
    const ok = !gated || d.p99 < 16;
    if (!ok) rendersFailed++;
    console.log(
      `${gated ? (ok ? "pass" : "FAIL") : "info"}  drag on 10,000 ops: ${d.mode}  (median ${d.median.toFixed(1)} ms, p99 ${d.p99.toFixed(1)} ms, ${Math.round(d.opsPerFrame)} ops a frame)`,
    );
  }
  console.log(`\n${renders.length + drags.length - rendersFailed} of ${renders.length + drags.length} render checks pass\n`);
  failed += rendersFailed;

  // Decorations: underline, line-through and overline land within a pixel of the DOM's.
  const decorations = await checkDecorations(browser);
  const decorationsOff = decorations.filter((d) => !d.dom || Math.abs(d.dom.top - d.ours.top) > 1 || Math.abs(d.dom.thickness - d.ours.thickness) > 1);
  for (const d of decorationsOff) {
    const dom = d.dom ? `top ${d.dom.top}, thickness ${d.dom.thickness}` : "nothing";
    console.log(`FAIL  decoration: ${d.kind} at ${d.size}px ${d.family}: DOM ${dom}, ours top ${d.ours.top}, thickness ${d.ours.thickness}`);
  }
  const families = new Set(decorations.map((d) => d.family)).size;
  console.log(`\n${decorations.length - decorationsOff.length} of ${decorations.length} decorations (${families} families) land within 1px of the DOM's`);
  failed += decorationsOff.length;

  // The vectorizer experiment: tracked, not gated. A crash still fails.
  const reports = await page.evaluate(
    (sources) => (globalThis as unknown as { runVectorize: (s: unknown) => Promise<VectorizeReport[]> }).runVectorize(sources),
    await vectorizeSources(browser, new Map(files.map((f) => [f.name, f.svg]))),
  );
  console.log("");
  for (const r of reports) {
    if (r.error) {
      failed++;
      console.log(`FAIL  vectorize: ${r.name}  (${r.error})`);
      continue;
    }
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    console.log(
      `info  vectorize: ${r.name}  (${r.colors} colors, ${r.rings} rings, ${r.points} points; mean difference ${r.meanDelta.toFixed(2)}, ${pct(r.off)} of pixels off by over 32; SVG ${(r.svgBytes / 1024).toFixed(1)} KB)`,
    );
  }

  if (failed > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
