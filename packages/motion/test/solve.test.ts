import { describe, expect, test } from "bun:test";
import {
  BONES, type BoneName, type Body, type JointName, SCRIPTS, SETUPS, boneDifference, boneLength, coverage, distance, jitter, lag, loadTake,
  boneFrames, placeRoot, proportionsFor, randomScript, restPose, normalize, rotate, saveTake, sub, solveTake, synthesize, v,
} from "../src";

const script = (name: string) => SCRIPTS.find((s) => s.name === name)!;
/** Only frames where the bone's far end was seen: a bone that wasn't seen has nothing to be right about. */
const seenOnly = (bodies: readonly Body[]) => (bone: BoneName, i: number) => bodies[i]!.joints[BONES[bone][1] as JointName].source === "seen";

describe("takes", () => {
  test("save and load keep every frame, to a tenth of a millimeter", () => {
    const { take } = synthesize(script("Wave"));
    const back = loadTake(saveTake(take));
    expect(back.frames.length).toBe(take.frames.length);
    const a = take.frames[10]!.pose!.world[15]!;
    const b = back.frames[10]!.pose!.world[15]!;
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-4);
    expect(back.frames[10]!.hands.length).toBe(take.frames[10]!.hands.length);
    expect(() => loadTake("{}")).toThrow();
  });
});

describe("solving scripted takes", () => {
  for (const s of SCRIPTS) {
    test(`${s.name}: seen bones within a few degrees of the truth`, () => {
      const { take, truth } = synthesize(s, { height: 1.9 });
      const raw = solveTake(take, { filter: false });
      const d = boneDifference(raw, truth, seenOnly(raw));
      for (const [bone, diff] of Object.entries(d)) if (!Number.isNaN(diff.mean)) expect([bone, diff.mean < 13]).toEqual([bone, true]);
      const filtered = solveTake(take);
      const f = boneDifference(filtered, truth, seenOnly(filtered));
      for (const [bone, diff] of Object.entries(f)) if (!Number.isNaN(diff.mean)) expect([bone, diff.mean < 12]).toEqual([bone, true]);
    });
  }

  test("learns the person's proportions from what it sees", () => {
    const { take, proportions } = synthesize(script("Wave"), { height: 1.9 });
    const last = solveTake(take).at(-1)!;
    for (const key of ["torso", "shoulderWidth", "upperArm", "forearm", "hand", "thigh", "shin"] as const) {
      expect(Math.abs(last.proportions[key] / proportions[key] - 1)).toBeLessThan(0.03);
    }
  });

  test("keeps every bone its length, seen or not", () => {
    const bodies = solveTake(synthesize(script("Out of frame")).take);
    for (const b of bodies) {
      for (const [bone, [from, to]] of Object.entries(BONES) as [BoneName, readonly [JointName, JointName]][]) {
        if (bone.endsWith("Hand")) continue; // the hand's tip follows the hand's own points when they're seen
        expect(Math.abs(distance(b.joints[from].p, b.joints[to].p) - boneLength(b.proportions, bone))).toBeLessThan(1e-9);
      }
    }
  });

  test("holds a part that leaves the frame, then eases it to where it likely is", () => {
    const bodies = solveTake(synthesize(script("Out of frame")).take);
    const sources = bodies.map((b) => b.joints.rightWrist.source);
    expect(sources[0]).toBe("seen");
    const gone = sources.indexOf("held");
    expect(gone).toBeGreaterThan(0);
    // It is seen again once the hand is back in view.
    expect(sources.lastIndexOf("seen")).toBeGreaterThan(gone);
    // A desk webcam doesn't see the legs: they are assumed seated, not left where noise put them.
    expect(bodies[60]!.joints.leftKnee.source).toBe("assumed");
    expect(bodies[60]!.joints.leftKnee.p.z).toBeGreaterThan(0.3);
  });

  test("smoothing takes out most of the shake for a frame or two of lag", () => {
    const { take } = synthesize(script("Joust"));
    const raw = solveTake(take, { filter: false });
    const smooth = solveTake(take);
    expect(jitter(smooth).rightWrist).toBeLessThan(jitter(raw).rightWrist / 3);
    expect(Math.abs(lag(raw, smooth, "rightWrist"))).toBeLessThanOrEqual(2);
  });

  test("places the body in front of the camera", () => {
    const { take, truth } = synthesize(script("Squat"));
    const bodies = solveTake(take);
    const errors = bodies.map((b, i) => (b.root ? distance(b.root, truth[i]!.root) : Infinity));
    expect(errors.reduce((a, b) => a + b, 0) / errors.length).toBeLessThan(0.05);
  });

  test("a noiseless root comes out exact", () => {
    const { take, truth } = synthesize(script("Wave"), { worldNoise: 0, imageNoise: 0 });
    const f = take.frames[20]!;
    const body = f.pose!.world.map((l) => ({ x: l.x, y: -l.y, z: -l.z }));
    const r = placeRoot(f.pose!.image, body, take.camera, SETUPS[take.setup])!;
    expect(distance(r, truth[20]!.root)).toBeLessThan(1e-6);
  });

  test("tells a pinch from an open hand", () => {
    const { take } = synthesize(script("Reach and pinch"));
    const bodies = solveTake(take);
    const pinches = bodies.map((b) => b.hands.right?.pinch ?? NaN);
    // The script pinches around its middle (fully reached), open at the start.
    expect(pinches[0]).toBeGreaterThan(0.6);
    expect(Math.min(...pinches.filter((p) => !Number.isNaN(p)))).toBeLessThan(0.3);
    const joust = solveTake(synthesize(script("Joust")).take);
    expect(joust[40]!.hands.right!.curl.index).toBeGreaterThan(0.5);
  });

  test("reports what it saw", () => {
    const c = coverage(solveTake(synthesize(script("Wave")).take));
    expect(c.rightWrist).toBe(1);
  });
});

describe("bone frames", () => {
  test("a straight leg measured a little past straight keeps its twist", () => {
    const j = restPose(proportionsFor(1.8));
    const bent = { ...j, leftKnee: { ...j.leftKnee, z: j.leftKnee.z + 0.1 } }; // the knee a little ahead: bent as knees bend
    const past = { ...j, leftKnee: { ...j.leftKnee, z: j.leftKnee.z - 0.1 } }; // a little behind: past straight
    const side = (q: ReturnType<typeof boneFrames>["leftShin"]) => rotate(q, v(1, 0, 0));
    expect(side(boneFrames(bent).leftShin).x).toBeGreaterThan(0.9);
    expect(side(boneFrames(past).leftShin).x).toBeGreaterThan(0.9);
  });
});

describe("depth from the image", () => {
  test("lifting takes nothing away on a take whose 3D points are already right", () => {
    for (const s of SCRIPTS) {
      const { take, truth } = synthesize(s, { height: 1.9 });
      const off = solveTake(take, { filter: false, lift: false });
      const on = solveTake(take, { filter: false, lift: true });
      const mean = (bodies: readonly Body[]) => {
        const d = boneDifference(bodies, truth, seenOnly(bodies));
        const m = Object.values(d).map((x) => x.mean).filter(Number.isFinite);
        return m.reduce((a, b) => a + b, 0) / m.length;
      };
      expect([s.name, mean(on) <= mean(off) + 0.5]).toEqual([s.name, true]);
    }
  });
});

describe("random movements", () => {
  test("are the same for a seed and different across seeds, and keep their bones", () => {
    const a = synthesize(randomScript(1), { fps: 5 });
    const b = synthesize(randomScript(1), { fps: 5 });
    const c = synthesize(randomScript(2), { fps: 5 });
    expect(a.truth[10]!.joints.leftWrist).toEqual(b.truth[10]!.joints.leftWrist);
    expect(a.truth[10]!.joints.leftWrist).not.toEqual(c.truth[10]!.joints.leftWrist);
    for (const f of a.truth) for (const q of Object.values(f.joints)) expect(Number.isFinite(q.x + q.y + q.z)).toBe(true);
  });

  test("bend both elbows the way elbows bend", () => {
    // A forearm bent backward would teach whatever learns from these that elbows do that: both arms' forearms should
    // reach forward alike, on average, and neither mostly back.
    const forward = { left: 0, right: 0 };
    let n = 0;
    for (let seed = 1; seed <= 40; seed++)
      for (const f of synthesize(randomScript(seed), { fps: 2 }).truth) {
        for (const s of ["left", "right"] as const) forward[s] += normalize(sub(f.joints[`${s}Wrist`], f.joints[`${s}Elbow`])).z;
        n++;
      }
    expect(forward.left / n).toBeGreaterThan(0.2);
    expect(forward.right / n).toBeGreaterThan(0.2);
    expect(Math.abs(forward.left - forward.right) / n).toBeLessThan(0.15);
  });
});
