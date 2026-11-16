// The body every tracker's points are fitted to and every character is driven from: a small skeleton of named joints
// in a fixed hierarchy, its rest pose, and how long its bones are for a given person.
//
// Body space: meters, the middle of the hips at the origin, y up, z toward the camera, x to the camera's right, which
// is the person's left while they face it. Its axes are the camera's, turned upright; a body that turns toward or away
// from the camera turns in it.
import { type Quat, type Vec3, add, frame, normalize, scale, v } from "./vec";

export const JOINTS = [
  "hips", "spine", "chest", "neck", "head",
  "leftShoulder", "leftElbow", "leftWrist", "leftHandTip",
  "rightShoulder", "rightElbow", "rightWrist", "rightHandTip",
  "leftHip", "leftKnee", "leftAnkle", "leftToe",
  "rightHip", "rightKnee", "rightAnkle", "rightToe",
] as const;
export type JointName = (typeof JOINTS)[number];

/** Each joint's parent; the hips have none. */
export const PARENT: Record<JointName, JointName | null> = {
  hips: null, spine: "hips", chest: "spine", neck: "chest", head: "neck",
  leftShoulder: "chest", leftElbow: "leftShoulder", leftWrist: "leftElbow", leftHandTip: "leftWrist",
  rightShoulder: "chest", rightElbow: "rightShoulder", rightWrist: "rightElbow", rightHandTip: "rightWrist",
  leftHip: "hips", leftKnee: "leftHip", leftAnkle: "leftKnee", leftToe: "leftAnkle",
  rightHip: "hips", rightKnee: "rightHip", rightAnkle: "rightKnee", rightToe: "rightAnkle",
};

/**
 * The bones a character is driven by, each from one joint toward another: its rotation turns its rest direction to
 * where it points now, its twist fixed by a side hint (see `boneFrames` in solve.ts).
 */
export const BONES = {
  hips: ["hips", "spine"],
  spine: ["spine", "chest"],
  chest: ["chest", "neck"],
  neck: ["neck", "head"],
  leftUpperArm: ["leftShoulder", "leftElbow"],
  leftForearm: ["leftElbow", "leftWrist"],
  leftHand: ["leftWrist", "leftHandTip"],
  rightUpperArm: ["rightShoulder", "rightElbow"],
  rightForearm: ["rightElbow", "rightWrist"],
  rightHand: ["rightWrist", "rightHandTip"],
  leftThigh: ["leftHip", "leftKnee"],
  leftShin: ["leftKnee", "leftAnkle"],
  leftFoot: ["leftAnkle", "leftToe"],
  rightThigh: ["rightHip", "rightKnee"],
  rightShin: ["rightKnee", "rightAnkle"],
  rightFoot: ["rightAnkle", "rightToe"],
} as const satisfies Record<string, readonly [JointName, JointName]>;
export type BoneName = keyof typeof BONES;
export const BONE_NAMES = Object.keys(BONES) as BoneName[];

/** Each bone's parent bone, for local rotations; the hips bone has none. */
export const BONE_PARENT: Record<BoneName, BoneName | null> = {
  hips: null, spine: "hips", chest: "spine", neck: "chest",
  leftUpperArm: "chest", leftForearm: "leftUpperArm", leftHand: "leftForearm",
  rightUpperArm: "chest", rightForearm: "rightUpperArm", rightHand: "rightForearm",
  leftThigh: "hips", leftShin: "leftThigh", leftFoot: "leftShin",
  rightThigh: "hips", rightShin: "rightThigh", rightFoot: "rightShin",
};

/** How long a person's bones are, in meters, and how wide their shoulders and hips. */
export interface Proportions {
  /** From the middle of the hips to the middle of the shoulders. */
  readonly torso: number;
  /** From the middle of the shoulders to the middle of the ears. */
  readonly neck: number;
  readonly shoulderWidth: number;
  readonly hipWidth: number;
  readonly upperArm: number;
  readonly forearm: number;
  /** From the wrist to the knuckle of the middle finger. */
  readonly hand: number;
  readonly thigh: number;
  readonly shin: number;
  /** From the ankle to the tip of the foot. */
  readonly foot: number;
}

/** Average proportions for a person of the given height, in meters. */
export const proportionsFor = (height = 1.72): Proportions => {
  const k = height / 1.72;
  return {
    torso: 0.5 * k, neck: 0.2 * k, shoulderWidth: 0.36 * k, hipWidth: 0.2 * k, upperArm: 0.29 * k, forearm: 0.25 * k,
    hand: 0.095 * k, thigh: 0.43 * k, shin: 0.41 * k, foot: 0.16 * k,
  };
};

/** Where the spine and the chest sit along the torso, from the hips (0) to the shoulders (1). */
export const SPINE_AT = 0.35;
export const CHEST_AT = 0.7;

/** Each bone's length for given proportions, the torso split at the spine and the chest. */
export const boneLength = (p: Proportions, bone: BoneName): number => {
  switch (bone) {
    case "hips": return p.torso * SPINE_AT;
    case "spine": return p.torso * (CHEST_AT - SPINE_AT);
    case "chest": return p.torso * (1 - CHEST_AT);
    case "neck": return p.neck;
    case "leftUpperArm": case "rightUpperArm": return p.upperArm;
    case "leftForearm": case "rightForearm": return p.forearm;
    case "leftHand": case "rightHand": return p.hand;
    case "leftThigh": case "rightThigh": return p.thigh;
    case "leftShin": case "rightShin": return p.shin;
    case "leftFoot": case "rightFoot": return p.foot;
  }
};

export type Joints = Record<JointName, Vec3>;

/**
 * The rest pose: standing, facing the camera (+z), arms out to the sides with the palms down and the elbows a little
 * bent forward, knees a little bent forward, so each hinge has a direction to be measured from.
 */
export const restPose = (p: Proportions = proportionsFor()): Joints => {
  const sw = p.shoulderWidth / 2;
  const hw = p.hipWidth / 2;
  const hips = v(0, 0, 0);
  const spine = v(0, p.torso * SPINE_AT, 0);
  const chest = v(0, p.torso * CHEST_AT, 0);
  const neck = v(0, p.torso, 0);
  const head = v(0, p.torso + p.neck, 0);
  const arm = (side: 1 | -1) => {
    const shoulder = v(side * sw, p.torso, 0);
    const elbow = add(shoulder, scale(normalize(v(side, 0, 0.08)), p.upperArm));
    const wrist = add(elbow, scale(normalize(v(side, 0, 0.12)), p.forearm));
    const tip = add(wrist, scale(v(side, 0, 0), p.hand));
    return { shoulder, elbow, wrist, tip };
  };
  const leg = (side: 1 | -1) => {
    const hip = v(side * hw, 0, 0);
    const knee = add(hip, scale(normalize(v(0, -1, 0.04)), p.thigh));
    const ankle = add(knee, scale(normalize(v(0, -1, -0.04)), p.shin));
    const toe = add(ankle, scale(normalize(v(0, -0.25, 1)), p.foot));
    return { hip, knee, ankle, toe };
  };
  const l = arm(1);
  const r = arm(-1);
  const ll = leg(1);
  const rl = leg(-1);
  return {
    hips, spine, chest, neck, head,
    leftShoulder: l.shoulder, leftElbow: l.elbow, leftWrist: l.wrist, leftHandTip: l.tip,
    rightShoulder: r.shoulder, rightElbow: r.elbow, rightWrist: r.wrist, rightHandTip: r.tip,
    leftHip: ll.hip, leftKnee: ll.knee, leftAnkle: ll.ankle, leftToe: ll.toe,
    rightHip: rl.hip, rightKnee: rl.knee, rightAnkle: rl.ankle, rightToe: rl.toe,
  };
};

/** A frame for a bone pointing along `along`, twisted by `side`: re-exported so callers needn't reach into vec.ts. */
export const boneFrame = (along: Vec3, side: Vec3): Quat => frame(along, side);
