// Laying a column out again around obstacles, as a drag does on every pointer
// move: a traced image silhouette (hundreds of vertices) and a shape, both with
// a margin. Must stay under 12 ms at the 99th percentile, leaving room in a
// 16 ms frame for drawing.
import { simplifyRing, traceMask } from "canvas-ir";
import { layoutText } from "../src";
import { HALF_EM_FAMILY, installMeasurementShim } from "../test/shim";

installMeasurementShim();
const measurer = {
  width: (font: string, text: string) => [...text].length * Number(/([\d.]+)px/.exec(font)![1]) * 0.5,
  metrics: (font: string) => ({ ascent: Number(/([\d.]+)px/.exec(font)![1]) * 0.8, descent: Number(/([\d.]+)px/.exec(font)![1]) * 0.2 }),
};

// A blob of three disks with a star cut out, traced like an image's alpha.
const inside = (x: number, y: number): boolean => {
  const disk = (cx: number, cy: number, r: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r;
  const blob = disk(62, 72, 50) || disk(112, 58, 46) || disk(120, 98, 34);
  const a = Math.atan2(y + 0.5 - 72, x + 0.5 - 92);
  const star = Math.hypot(x + 0.5 - 92, y + 0.5 - 72) < 10 + 14 * Math.abs(Math.cos((5 * a) / 2));
  return blob && !star;
};
const silhouette = traceMask(180, 140, inside).map((r) => simplifyRing(r, 0.75).map((p) => ({ x: 120 + p.x * 0.6, y: 200 + p.y * 0.6 })));
const ellipse = [Array.from({ length: 96 }, (_, i) => ({ x: 130 + 52 * Math.cos((i / 96) * 2 * Math.PI), y: 120 + 40 * Math.sin((i / 96) * 2 * Math.PI) }))];
const text = { blocks: [{ type: "paragraph" as const, content: ["word and other words, ".repeat(40)] }] };

const times: number[] = [];
for (let i = 0; i < 220; i++) {
  const dy = (i % 20) * 3;
  const t0 = performance.now();
  layoutText(text, {
    container: { x: 10, y: 10, width: 272, height: 300 },
    obstacles: [{ rings: ellipse }, { rings: silhouette.map((r) => r.map((p) => ({ x: p.x, y: p.y - dy }))) }],
    obstacleMargin: 8,
    theme: { fontFamily: HALF_EM_FAMILY, fontSize: 14 },
    measurer,
  });
  times.push(performance.now() - t0);
}
times.splice(0, 20);
times.sort((a, b) => a - b);
const p99 = times[Math.floor(times.length * 0.99)]!;
const median = times[Math.floor(times.length / 2)]!;
const budget = 12;
console.log(`${"wrap around a traced image".padEnd(36)} median ${median.toFixed(3)} ms   p99 ${p99.toFixed(3)} ms   budget ${budget} ms`);
if (p99 > budget) {
  console.log(`over budget: wrap around a traced image (${p99.toFixed(2)} > ${budget} ms)`);
  process.exit(1);
}
