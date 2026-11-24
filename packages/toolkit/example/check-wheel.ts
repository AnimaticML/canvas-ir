// Run with bun run example/check-wheel.ts from packages/toolkit.
import { chromium, firefox, webkit } from "playwright-core";
import type { WheelDelta, WheelSource } from "../src/wheel";

const url = new URL("../src/wheel.ts", import.meta.url);
const source = await Bun.file(url).text();
const script = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
const moduleUrl = "data:text/javascript;base64," + Buffer.from(script).toString("base64");
const fixtures: { name: string; samples: WheelDelta[]; source: WheelSource }[] = [];
const vertical = (values: number[]): WheelDelta[] => values.map((deltaY) => ({ deltaX: 0, deltaY }));
for (const step of [3, 53.25, 100, 120, 144, 240]) {
  fixtures.push(
    { name: `repeated notches at ${step}`, samples: vertical([step, step, -step]), source: "mouse" },
    { name: `coalesced notches at ${step}`, samples: vertical([step * 3, -step * 2, step * 4]), source: "mouse" },
  );
}
fixtures.push(
  { name: "single overlapping delta", samples: vertical([120]), source: "ambiguous" },
  { name: "two overlapping deltas", samples: vertical([120, 240]), source: "ambiguous" },
  { name: "zero deltas", samples: vertical([0, 0, 0]), source: "ambiguous" },
  { name: "horizontal pan", samples: [{ deltaX: 8, deltaY: 0 }], source: "trackpad" },
  { name: "slow vertical pan", samples: vertical([0.5, 1.8, 2.1, 4.9, 4.1, 3.3, 1.7]), source: "trackpad" },
  { name: "fast vertical pan crossing a mouse notch", samples: vertical([18, 47, 120, 184, 92, 33]), source: "trackpad" },
);

const failures: string[] = [];
for (const engine of [chromium, firefox, webkit]) {
  const name = engine.name();
  try {
    const executablePath = name === "chromium" ? process.env["CHROMIUM_PATH"] : undefined;
    const browser = await engine.launch({ timeout: 20_000, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="target"></div>');
      const mismatches = await page.evaluate(async ({ cases, url }) => {
        const { classifyWheel: classify, WheelGesture }: typeof import("../src/wheel") = await import(url);
        const target = document.getElementById("target")!;
        const errors = cases.flatMap(({ name, samples, source }) => {
          const observed: WheelDelta[] = [];
          const record = ({ deltaX, deltaY }: WheelEvent) => observed.push({ deltaX, deltaY });
          target.addEventListener("wheel", record);
          for (const delta of samples) target.dispatchEvent(new WheelEvent("wheel", delta));
          target.removeEventListener("wheel", record);
          const actual = classify(observed);
          return actual === source ? [] : [`${name}: expected ${source}, got ${actual}`];
        });
        const gesture = new WheelGesture();
        const routed = [
          [0, 120, 0, 0], [0, 240, 10, 0], [0, 120, 20, 0],
          [0, 120, 130, 0], [2, 15, 140, 0], [0, 23, 150, 0],
          [2, 15, 260, 0], [0, 120, 270, 0], [0, 11, 275, 0],
          [0, 11, 280, 1], [0, 12, 290, 1], [0, 17, 295, 0],
          [0, 240, 405, 0],
        ].map(([deltaX = 0, deltaY = 0, timeStamp = 0, ctrl = 0]) => {
          const event = new WheelEvent("wheel", { deltaX, deltaY, ctrlKey: ctrl === 1 });
          return gesture.push({ deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey, timeStamp });
        });
        const expected = "pan pan pan zoom zoom zoom pan pan pan zoom zoom pan zoom";
        if (routed.join(" ") !== expected) errors.push("burst actions: " + routed.join(" "));
        const isolated = new WheelGesture();
        const single = [0, 110, 220, 330].map((timeStamp) =>
          isolated.push({ deltaX: 0, deltaY: -120, ctrlKey: false, timeStamp }));
        if (single.join(" ") !== "pan pan pan zoom") errors.push("isolated notches: " + single.join(" "));
        return errors;
      }, { cases: fixtures, url: moduleUrl });
      if (mismatches.length) failures.push(...mismatches.map((error) => `${name}: ${error}`));
      else console.log(`${name} ${browser.version()}: ${fixtures.length + 2} cases passed`);
    } finally {
      await browser.close();
    }
  } catch (error) {
    failures.push(`${name}: ${error}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
