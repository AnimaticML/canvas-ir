// Measures for judging a solve: how far two takes' bodies differ bone by bone, how much a body shakes, how long the
// parts were seen, and how far one take lags another. They are what experiments report and what tests hold to.
import { BONE_NAMES, type BoneName, JOINTS, type JointName } from "./skeleton";
import type { Body } from "./solve";
import { type Quat, angleBetween, length, sub } from "./vec";

export interface BoneDifference {
  /** Mean and largest angle between the two bodies' bones, in degrees. */
  readonly mean: number;
  readonly max: number;
}

/** Bone by bone, how far apart two sequences of bone frames are, frame for frame, in degrees. */
export const boneDifference = (
  a: readonly { readonly bones: Readonly<Record<BoneName, Quat>> }[],
  b: readonly { readonly bones: Readonly<Record<BoneName, Quat>> }[],
  only?: (bone: BoneName, frame: number) => boolean,
): Record<BoneName, BoneDifference> => {
  const out = {} as Record<BoneName, BoneDifference>;
  const n = Math.min(a.length, b.length);
  for (const bone of BONE_NAMES) {
    let sum = 0;
    let max = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (only && !only(bone, i)) continue;
      const d = (angleBetween(a[i]!.bones[bone], b[i]!.bones[bone]) * 180) / Math.PI;
      sum += d;
      max = Math.max(max, d);
      count++;
    }
    out[bone] = { mean: count ? sum / count : NaN, max };
  }
  return out;
};

/**
 * How much each joint shakes: the mean size of its acceleration, in m/s², over frames where it was seen. A still
 * joint seen through noise shows its noise here; a moving one, its noise and its movement.
 */
export const jitter = (bodies: readonly Body[]): Record<JointName, number> => {
  const out = {} as Record<JointName, number>;
  for (const name of JOINTS) {
    let sum = 0;
    let count = 0;
    for (let i = 2; i < bodies.length; i++) {
      const [a, b, c] = [bodies[i - 2]!, bodies[i - 1]!, bodies[i]!];
      if ([a, b, c].some((x) => x.joints[name].source !== "seen")) continue;
      const dt = (c.t - a.t) / 2000;
      if (dt <= 0) continue;
      const acc = sub(sub(c.joints[name].p, b.joints[name].p), sub(b.joints[name].p, a.joints[name].p));
      sum += length(acc) / (dt * dt);
      count++;
    }
    out[name] = count ? sum / count : NaN;
  }
  return out;
};

/** The share of frames each joint was seen in. */
export const coverage = (bodies: readonly Body[]): Record<JointName, number> => {
  const out = {} as Record<JointName, number>;
  for (const name of JOINTS) out[name] = bodies.length ? bodies.filter((b) => b.joints[name].source === "seen").length / bodies.length : 0;
  return out;
};

/**
 * How many frames `b` trails `a` by, the shift that makes a joint's path in `b` best match its path in `a`, searched up
 * to `most` frames each way: a smoothed solve against an unsmoothed one shows the smoothing's lag.
 */
export const lag = (a: readonly Body[], b: readonly Body[], joint: JointName, most = 15): number => {
  let best = 0;
  let bestErr = Infinity;
  for (let shift = -most; shift <= most; shift++) {
    let err = 0;
    let count = 0;
    for (let i = Math.max(0, -shift); i < Math.min(a.length, b.length - shift); i++) {
      err += length(sub(a[i]!.joints[joint].p, b[i + shift]!.joints[joint].p)) ** 2;
      count++;
    }
    if (count && err / count < bestErr) {
      bestErr = err / count;
      best = shift;
    }
  }
  return best;
};
