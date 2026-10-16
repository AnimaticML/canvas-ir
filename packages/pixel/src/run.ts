// Pixel test, run in headless Chromium. For every fixture, replaying the recorded
// document must paint exactly what direct drawing paints once transform calls are
// applied as `setTransform` with the same matrix, and may differ from plain direct
// drawing only in anti-aliased edge pixels (see withComposedTransforms in page.ts).
import { chromium } from "playwright-core";
import type { Comparison, FixtureResult } from "./page";

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
  for (const r of results) {
    const exactEnough = r.engineDeviation ? r.exact?.interiorPixels === 0 : r.exact?.differentPixels === 0;
    const ok = exactEnough && r.direct?.interiorPixels === 0;
    if (!ok) failed++;
    const detail =
      r.error ??
      `exact: ${describe(r.exact!)}; direct drawing: ${describe(r.direct!)}`;
    console.log(`${ok ? "pass" : "FAIL"}  ${r.name}  (${detail})`);
    if (r.engineDeviation) console.log(`      known deviation: ${r.engineDeviation}`);
  }
  console.log(`\n${results.length - failed} of ${results.length} fixtures replay pixel-equal`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
