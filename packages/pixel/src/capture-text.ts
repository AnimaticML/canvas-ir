// Captures text measurements and layouts from Chromium into packages/text/test/captured.json,
// so the Bun tests can lay out the fixtures without a browser. Run again when fixtures change.
import { chromium } from "playwright-core";

const build = await Bun.build({ entrypoints: [new URL("./page.ts", import.meta.url).pathname], target: "browser" });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const captured = await page.evaluate(() =>
    (globalThis as unknown as { captureText: () => Promise<unknown> }).captureText(),
  );
  const out = new URL("../../text/test/captured.json", import.meta.url).pathname;
  await Bun.write(out, `${JSON.stringify(captured, null, 1)}\n`);
  const { measurements } = captured as { measurements: object };
  console.log(`wrote ${Object.keys(measurements).length} measurements to ${out}`);
} finally {
  await browser.close();
}
