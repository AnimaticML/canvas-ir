// The motion bench as a test: every scripted movement played on the mannequin under each camera setup that sees a
// body, rendered, tracked by MediaPipe (on the CPU, so a run repeats) and solved, then held to the budgets in
// budgets.json. A run that gets worse than its budget fails; one that gets clearly better says so, so the budget
// can be tightened to keep the gain.
//
//   bun run --cwd packages/playground build && bun run --cwd packages/playground bench
//   bun run --cwd packages/playground bench --update     writes the results as the new budgets
//   bun run --cwd packages/playground bench Joust desk   runs one movement under one setup
import { chromium } from "playwright-core";

interface Summary {
  script: string;
  setup: string;
  frames: number;
  found: number;
  overall: number;
  overallSeen: number;
  posing: number;
  bones: Record<string, { mean: number; max: number; seen: number }>;
}
interface Budget {
  /** The least share of frames a body must be found in. */
  found: number;
  /** The most mean error over every frame, and where parts were seen, in degrees. */
  overall: number;
  seen: number;
}

const FPS = 5;
/** Slack over a measured result before it fails, in degrees, and in share of frames found. */
const SLACK = { degrees: 2, found: 0.05 };
const dist = new URL("../dist/", import.meta.url);
const budgetsFile = new URL("./budgets.json", import.meta.url);
const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => !a.startsWith("--"));

const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    const file = Bun.file(new URL(`.${path === "/" ? "/index.html" : path}`, dist));
    return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
  },
});
const executablePath = process.env.CHROMIUM_PATH;
// No GPU on a test machine: WebGL through SwiftShader.
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results: Summary[] = [];
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => {
    console.error("page error:", e.message);
    failed++;
  });
  await page.goto(`http://localhost:${server.port}/motion-bench.html?cpu`);
  await page.waitForFunction(() => !(document.getElementById("run") as HTMLButtonElement).disabled, null, { timeout: 120_000 });
  const budgets: Record<string, Budget> = (await Bun.file(budgetsFile).exists()) ? await Bun.file(budgetsFile).json() : {};
  const scripts: string[] = await page.evaluate(() => Array.from((document.getElementById("script") as HTMLSelectElement).options).map((o) => o.value));
  const setups = ["desk", "phone-stand", "selfie"];
  for (const script of scripts) {
    for (const setup of setups) {
      if (only.length && !(only.includes(script) && (only.length < 2 || only.includes(setup)))) continue;
      const t0 = performance.now();
      const s: Summary = await page.evaluate(async ([s, u, fps]) => (await (window as any).bench.run(s, u, fps)).summary, [script, setup, FPS] as const);
      results.push(s);
      const key = `${script} / ${setup}`;
      const found = s.found / s.frames;
      const b = budgets[key];
      const problems: string[] = [];
      // The bench's own check: the character must be posed as the movement says, or nothing it scores means anything.
      if (s.posing > 6) problems.push(`the character was posed ${s.posing.toFixed(1)}° from the movement`);
      if (b && !update) {
        if (found < b.found - SLACK.found) problems.push(`body found in ${(found * 100).toFixed(0)}% of frames, budget ${(b.found * 100).toFixed(0)}%`);
        if (s.overall > b.overall + SLACK.degrees) problems.push(`error ${s.overall.toFixed(1)}° overall, budget ${b.overall.toFixed(1)}°`);
        if (Number.isFinite(s.overallSeen) && s.overallSeen > b.seen + SLACK.degrees) problems.push(`error ${s.overallSeen.toFixed(1)}° where seen, budget ${b.seen.toFixed(1)}°`);
      } else if (!b && !update) problems.push("no budget: run with --update");
      const better = b && !update && s.overall < b.overall - 2 * SLACK.degrees ? `  (better than its budget of ${b.overall.toFixed(1)}°: tighten it with --update)` : "";
      const line = `${key.padEnd(30)} found ${(found * 100).toFixed(0).padStart(3)}%  seen ${s.overallSeen.toFixed(1).padStart(5)}°  overall ${s.overall.toFixed(1).padStart(5)}°  posing ${s.posing.toFixed(1)}°  ${((performance.now() - t0) / 1000).toFixed(0)} s`;
      if (problems.length) {
        failed++;
        console.log(`✗ ${line}\n    ${problems.join("\n    ")}`);
      } else console.log(`✓ ${line}${better}`);
    }
  }
  if (update) {
    const next = { ...budgets };
    for (const s of results)
      next[`${s.script} / ${s.setup}`] = { found: +(s.found / s.frames).toFixed(2), overall: +s.overall.toFixed(1), seen: Number.isFinite(s.overallSeen) ? +s.overallSeen.toFixed(1) : 180 };
    await Bun.write(budgetsFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${results.length} budgets`);
  }
} finally {
  await browser.close();
  server.stop();
}
if (failed) {
  console.error(`${failed} bench run(s) failed`);
  process.exit(1);
}
