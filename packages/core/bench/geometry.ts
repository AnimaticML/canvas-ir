// Phase 2 gate: geometry queries on a 10,000-op board must stay well under a
// 16 ms frame, at the 99th percentile, on a sparse board and a dense one.
// Run with `bun run bench`; exits non-zero when a budget is exceeded.
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";

const OPS = 10_000;
// A sparse board, and a dense one where a point lies under dozens of ops.
const WORLDS = [20_000, 2_000];
let WORLD = WORLDS[0]!;

let seed = 42;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const between = (lo: number, hi: number): number => lo + (hi - lo) * random();

const board = (): RecordingContext => {
  const ctx = new RecordingContext();
  let drawn = 0;
  while (drawn < OPS) {
    ctx.save();
    ctx.translate(between(0, WORLD), between(0, WORLD));
    ctx.rotate(between(0, Math.PI * 2));
    ctx.scale(between(0.5, 2), between(0.5, 2));
    ctx.beginPath();
    switch (drawn % 4) {
      case 0:
        ctx.rect(-40, -30, 80, 60);
        ctx.fill();
        break;
      case 1:
        ctx.arc(0, 0, between(10, 60), 0, Math.PI * 2);
        ctx.fill("evenodd");
        break;
      case 2:
        ctx.lineWidth = between(1, 8);
        ctx.moveTo(-50, 0);
        ctx.bezierCurveTo(-20, -60, 20, 60, 50, 0);
        ctx.lineTo(50, 40);
        ctx.stroke();
        break;
      case 3:
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.ellipse(0, 0, 50, 25, 0.3, 0, Math.PI * 1.5);
        ctx.stroke();
        break;
    }
    ctx.restore();
    drawn++;
  }
  return ctx;
};

const time = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

const budgets: { name: string; ms: number; actual: number }[] = [];
const measure = (name: string, budgetMs: number, runs: number, fn: () => void): void => {
  const samples = Array.from({ length: runs }, () => time(fn));
  const p99 = percentile(samples, 0.99);
  budgets.push({ name, ms: budgetMs, actual: p99 });
  const median = percentile(samples, 0.5);
  console.log(`${name.padEnd(36)} median ${median.toFixed(3)} ms   p99 ${p99.toFixed(3)} ms   budget ${budgetMs} ms`);
};

for (const world of WORLDS) {
  WORLD = world;
  console.log(`--- ${OPS} ops on a ${world} x ${world} board`);
  const recordMs = time(board);
  const doc = board().getDocument();
  let scene!: Scene;
  const buildMs = time(() => {
    scene = new Scene(doc);
  });
  console.log(`recording ${OPS} ops: ${recordMs.toFixed(1)} ms; building the scene index: ${buildMs.toFixed(1)} ms\n`);
  budgets.push({ name: `${world}: building the scene index`, ms: 1000, actual: buildMs });

  const point = () => ({ x: between(0, WORLD), y: between(0, WORLD) });
  // Cold queries derive shapes on first touch; warm ones reuse the cache.
  measure(`${world}: hitTest, cold`, 8, 2000, () => scene.hitTest(point(), { tolerance: 2 }));
  // Warm the whole board so later numbers are steady.
  for (const op of doc.ops) scene.bounds(op.id);
  measure(`${world}: hitTest, warm`, 2, 5000, () => scene.hitTest(point(), { tolerance: 2 }));
  measure(`${world}: queryRect 500x500, intersects`, 8, 1000, () => {
    const p = point();
    scene.queryRect({ x: p.x, y: p.y, width: 500, height: 500 });
  });
  measure(`${world}: queryRect 500x500, enclosed`, 8, 1000, () => {
    const p = point();
    scene.queryRect({ x: p.x, y: p.y, width: 500, height: 500 }, "enclosed");
  });
  measure(`${world}: closestPoint within 100`, 8, 1000, () => scene.closestPoint(point(), { maxDistance: 100 }));
  measure(`${world}: transform one op, then hitTest it`, 2, 1000, () => {
    const id = doc.ops[Math.floor(between(0, OPS))]!.id;
    scene.transform(id, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
    scene.hitTest(point());
  });
  console.log("");
}

const over = budgets.filter((b) => b.actual > b.ms);
if (over.length > 0) {
  console.log(`\nover budget: ${over.map((b) => `${b.name} (${b.actual.toFixed(2)} > ${b.ms} ms)`).join(", ")}`);
  process.exit(1);
}
console.log("\nall within budget");
