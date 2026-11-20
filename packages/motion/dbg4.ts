import { BONE_NAMES, boneDifference, solveTake } from "./src";
const dir = "/tmp/claude-0/-home-claude/ab0df6cb-be8b-5a3b-bdf1-7c6398db37d5/scratchpad/";
const files = ["t-Wave-phone-stand.json", "t-Joust-desk.json", "t-Wave-selfie.json", "t-Squat-phone-stand.json", "t-Out of frame-desk.json"];
const takes = await Promise.all(files.map(async (f) => JSON.parse(await Bun.file(dir + f).text())));
for (const mode of ["off", 1]) {
  (globalThis as any).LIFTMODE = mode;
  const row = takes.map((d) => { const diff = boneDifference(solveTake(d.take, { lift: mode !== "off" }), d.rendered); const v = BONE_NAMES.map((b) => diff[b].mean).filter(Number.isFinite); return (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1); });
  console.log(String(mode).padEnd(4), row.join("  "));
}
