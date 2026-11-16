import { describe, expect, test } from "bun:test";
import {
  BONE_NAMES, BONE_PARENT, BONES, type BoneName, type JointName, type Quat, Retarget, type Rig, type RigMap, SCRIPTS, type Vec3,
  conjugate, normalize, proportionsFor, qmul, restPose, rotate, solveTake, sub, synthesize,
} from "../src";

/** A rig shaped like the body at rest but twice as big, its nodes turned every which way: retargeting mustn't care. */
const makeRig = (): { rig: Rig; map: RigMap } => {
  const J = restPose(proportionsFor(1.6));
  const at = (j: JointName): Vec3 => ({ x: J[j].x * 2, y: J[j].y * 2 + 3, z: J[j].z * 2 });
  const odd = (i: number): Quat => {
    const a = normalize({ x: Math.sin(i), y: Math.cos(i * 1.7), z: Math.sin(i * 2.3) });
    const h = (i * 0.9) % Math.PI;
    return { x: a.x * Math.sin(h), y: a.y * Math.sin(h), z: a.z * Math.sin(h), w: Math.cos(h) };
  };
  const bones: Rig["bones"][number][] = BONE_NAMES.map((b, i) => ({ name: b, parent: BONE_PARENT[b], rest: { p: at(BONES[b][0]), q: odd(i + 1) } }));
  // Tips: the ends no bone starts from, hanging from the bone that ends there.
  for (const [tip, bone] of [["head", "neck"], ["leftHandTip", "leftHand"], ["rightHandTip", "rightHand"], ["leftToe", "leftFoot"], ["rightToe", "rightFoot"]] as const)
    bones.push({ name: `tip:${tip}`, parent: bone, rest: { p: at(tip), q: odd(bones.length + 1) } });
  const joints: RigMap["joints"] = {};
  for (const b of BONE_NAMES) joints[BONES[b][0]] ??= b;
  for (const b of bones) if (b.name.startsWith("tip:")) joints[b.name.slice(4) as JointName] = b.name;
  return { rig: { bones }, map: { bones: Object.fromEntries(BONE_NAMES.map((b) => [b, b])), joints } };
};

/** Where each rig node ends up when posed with the given local rotations. */
const forward = (rig: Rig, local: Map<string, Quat>) => {
  const world = new Map<string, { p: Vec3; q: Quat }>();
  const rest = new Map(rig.bones.map((b) => [b.name, b.rest]));
  for (const b of rig.bones) {
    const q = local.get(b.name)!;
    const parent = b.parent ? world.get(b.parent)! : null;
    if (!parent) world.set(b.name, { p: b.rest.p, q });
    else {
      const pr = rest.get(b.parent!)!;
      const offset = rotate(conjugate(pr.q), sub(b.rest.p, pr.p));
      const r = rotate(parent.q, offset);
      world.set(b.name, { p: { x: parent.p.x + r.x, y: parent.p.y + r.y, z: parent.p.z + r.z }, q: qmul(parent.q, q) });
    }
  }
  return world;
};

describe("retargeting", () => {
  test("a posed rig points every bone the way the body's bone points", () => {
    const { rig, map } = makeRig();
    const retarget = new Retarget(rig, map);
    const { take } = synthesize(SCRIPTS.find((s) => s.name === "Joust")!);
    const bodies = solveTake(take, { filter: false });
    const node = (j: JointName) => map.joints[j] as string;
    for (const body of [bodies[5]!, bodies[Math.floor(bodies.length / 2)]!, bodies.at(-5)!]) {
      const world = forward(rig, retarget.pose(body));
      for (const b of BONE_NAMES as BoneName[]) {
        const [a, c] = BONES[b];
        const want = normalize(sub(body.joints[c].p, body.joints[a].p));
        const got = normalize(sub(world.get(node(c))!.p, world.get(node(a))!.p));
        const deg = (Math.acos(Math.min(1, want.x * got.x + want.y * got.y + want.z * got.z)) * 180) / Math.PI;
        expect([b, deg < 2]).toEqual([b, true]);
      }
    }
  });

  test("the rig's size is measured in its own units", () => {
    const { rig, map } = makeRig();
    const p = proportionsFor(1.6);
    expect(new Retarget(rig, map).size).toBeCloseTo(2 * (p.torso + p.thigh + p.shin), 1);
  });
});
