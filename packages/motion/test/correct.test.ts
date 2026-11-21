import { describe, expect, test } from "bun:test";
import { Correction, type CorrectionWeights, type Landmark, P, SCRIPTS, distance, synthesize, v } from "../src";

const b64 = (a: number[]) => Buffer.from(new Float32Array(a).buffer).toString("base64");
const BONES = [
  { name: "hips", from: [23, 24], to: [11, 12] },
  { name: "leftUpperArm", from: [11], to: [13] },
];
const POINTS = [11, 12, 13, 15, 23, 24];
const inputs = POINTS.length * 6 + 3 + BONES.length * 3;

/** A one-layer "network" whose outputs are fixed: zero turns nothing, others turn the bones by that much. */
const fixed = (outputs: number[], apply = BONES.map((b) => b.name)): Correction => {
  const weights: CorrectionWeights = {
    points: POINTS,
    bones: BONES,
    apply,
    mean: b64(Array(inputs).fill(0)),
    spread: b64(Array(inputs).fill(1)),
    layers: [{ inputs, outputs: outputs.length, w: b64(Array(inputs * outputs.length).fill(0)), b: b64(outputs) }],
  };
  return new Correction(weights);
};

const frame = () => {
  const take = synthesize(SCRIPTS[0]!, { fps: 5 }).take;
  return { pose: take.frames[3]!.pose!, camera: take.camera };
};
const W = (l: Landmark) => v(l.x, -l.y, -l.z);

describe("correction", () => {
  test("that turns nothing leaves the landmarks where they were", () => {
    const { pose, camera } = frame();
    const out = fixed([0, 0, 0, 0, 0, 0]).apply(pose.image, pose.world, camera);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.x).toBeCloseTo(pose.world[i]!.x, 6);
      expect(out[i]!.z).toBeCloseTo(pose.world[i]!.z, 6);
    }
  });

  test("turns a bone where it says, keeps its length, and moves what hangs from it along", () => {
    const { pose, camera } = frame();
    const c = fixed([0, 0, 0, 0, 0, 0.8], ["leftUpperArm"]);
    const { corrected } = c.directions(pose.image, pose.world, camera);
    const out = c.apply(pose.image, pose.world, camera);
    const [s, e, w] = [P.leftShoulder, P.leftElbow, P.leftWrist];
    expect(distance(W(out[s]!), W(pose.world[s]!))).toBeCloseTo(0, 6);
    expect(distance(W(out[s]!), W(out[e]!))).toBeCloseTo(distance(W(pose.world[s]!), W(pose.world[e]!)), 5);
    const d = W(out[e]!);
    const dir = v(d.x - W(out[s]!).x, d.y - W(out[s]!).y, d.z - W(out[s]!).z);
    const len = Math.hypot(dir.x, dir.y, dir.z);
    expect(dir.x / len).toBeCloseTo(corrected[1]!.x, 5);
    expect(dir.z / len).toBeCloseTo(corrected[1]!.z, 5);
    // The forearm keeps its own length and direction: it moved with the elbow.
    expect(distance(W(out[e]!), W(out[w]!))).toBeCloseTo(distance(W(pose.world[e]!), W(pose.world[w]!)), 5);
    // The other arm and the torso weren't touched.
    expect(out[P.rightElbow]).toEqual(pose.world[P.rightElbow]!);
    expect(out[P.leftHip]).toEqual(pose.world[P.leftHip]!);
  });

  test("leaves bones it wasn't asked to apply, and those not seen", () => {
    const { pose, camera } = frame();
    const near = (a: Landmark, b: Landmark) => expect(distance(W(a), W(b))).toBeCloseTo(0, 6);
    near(fixed([0, 0, 0, 0, 0, 0.8], ["hips"]).apply(pose.image, pose.world, camera)[P.leftElbow]!, pose.world[P.leftElbow]!);
    const hidden = pose.image.map((l, i) => (i === P.leftElbow ? { ...l, visibility: 0.1 } : l));
    near(fixed([0, 0, 0, 0, 0, 0.8]).apply(hidden, pose.world, camera)[P.leftElbow]!, pose.world[P.leftElbow]!);
  });
});
