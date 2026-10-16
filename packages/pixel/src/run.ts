// Pixel test, run in headless Chromium. For every fixture and every SVG in the
// corpus, replaying the recorded document must paint exactly what direct drawing
// paints, plainly or with transform calls applied as one `setTransform` of the same
// matrix, and may differ from plain direct drawing only in anti-aliased edge pixels
// (see withComposedTransforms in page.ts). Hit tests must agree with Chromium's.
import { chromium } from "playwright-core";
import { readdir } from "node:fs/promises";
import type { Comparison, CorpusResult, FixtureResult, GeometryResult } from "./page";

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
        return { name: f, svg, ...(deviation ? { engineDeviation: deviation.replace(/\s+/g, " ") } : {}) };
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
  console.log(`\n${corpus.length} corpus files, ${corpusFailed === 0 ? "all replay pixel-equal and hit-test like Chromium" : `${corpusFailed} checks failed`}`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
