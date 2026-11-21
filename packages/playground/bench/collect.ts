// Training data for the learned correction (see correct.ts in the motion package): made-up movements played on the
// bench's mannequin, rendered, tracked by MediaPipe on the CPU, and written frame by frame as what MediaPipe reported
// beside the bone frames the mannequin was rendered in, one JSON line a frame.
//
//   bun run --cwd packages/playground build
//   bun run --cwd packages/playground/bench collect.ts 1 450 random.jsonl      seeds 1 to 450, about two hours
//   bun run --cwd packages/playground/bench collect.ts scripted scripted.jsonl the scripted movements, to test on
//
// Seed n plays under the desk, phone and selfie cameras in turn (n mod 3). Then train.py fits the correction.
import { chromium } from "playwright-core";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const scripted = args[0] === "scripted";
const [from, to] = scripted ? [0, 14] : [Number(args[0] ?? 1), Number(args[1] ?? 450)];
const out = scripted ? (args[1] ?? "scripted.jsonl") : (args[2] ?? "random.jsonl");
const MOVES = ["Wave", "Reach and pinch", "Joust", "Squat", "Out of frame"];
const SETUPS = ["desk", "phone-stand", "selfie"];
const dist = new URL("../dist/", import.meta.url);
const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    const file = Bun.file(new URL(`.${path === "/" ? "/index.html" : path}`, dist));
    return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
  },
});
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://localhost:${server.port}/motion-bench.html?cpu`);
  await page.waitForFunction(() => !(document.getElementById("run") as HTMLButtonElement).disabled, null, { timeout: 120_000 });
  for (let seed = from; seed <= to; seed++) {
    const setup = SETUPS[seed % 3]!;
    const movement = scripted ? MOVES[Math.floor(seed / 3)]! : `Random ${seed}`;
    const rows = await page.evaluate(
      async ([seed, setup, movement]) => {
        const x = await (window as any).bench.run(movement, setup, 5);
        const r = (n: number) => Math.round(n * 1e4) / 1e4;
        const q = (bones: Record<string, { x: number; y: number; z: number; w: number }>) => Object.fromEntries(Object.entries(bones).map(([k, b]) => [k, [r(b.x), r(b.y), r(b.z), r(b.w)]]));
        return x.take.frames.map((f: any, i: number) => ({
          seed, setup, movement, t: f.t,
          image: f.pose?.image.map((l: any) => [r(l.x), r(l.y), r(l.visibility ?? 0)]) ?? null,
          world: f.pose?.world.map((l: any) => [r(l.x), r(l.y), r(l.z)]) ?? null,
          truth: q(x.rendered[i].bones),
          solved: q(x.bodies[i].bones),
        }));
      },
      [seed, setup, movement] as const,
    );
    appendFileSync(out, rows.map((r: unknown) => JSON.stringify(r)).join("\n") + "\n");
    if (seed % 10 === 0) console.log("seed", seed);
  }
} finally {
  await browser.close();
  server.stop();
}
