import { BONES, SCRIPTS, boneDifference, solveTake, synthesize } from "./src";
for (const s of SCRIPTS) for (const lift of [false, true]) {
  const { take, truth } = synthesize(s, { height: 1.9 });
  const raw = solveTake(take, { filter: false, lift });
  const d = boneDifference(raw, truth, (b, i) => raw[i]!.joints[BONES[b][1]].source === "seen");
  console.log(s.name.padEnd(16), lift, Object.entries(d).filter(([, x]) => x.mean > 8).map(([k, x]) => `${k} ${x.mean.toFixed(0)}=${x.direction.toFixed(0)}+${x.twist.toFixed(0)}`).join(" "));
}
