// Takes made up from scripted movements: a known body moved by a script, seen through a pinhole camera, with the
// tracker's noise, its misses and parts leaving the frame. They are what the solver is tested against, since for them
// the truth is known, and they let the playground show something before a camera is on.
import { H, type Landmark, P } from "./landmarks";
import { type BoneName, type JointName, type Joints, type Proportions, boneLength, proportionsFor, restPose } from "./skeleton";
import { SETUPS, type SetupId } from "./setups";
import { boneFrames } from "./solve";
import type { Frame, HandObservation, Take } from "./take";
import { type Quat, type Vec3, add, axisAngle, cross, normalize, rotate, scale, sub, v } from "./vec";

/** What a script says the body does at a moment. */
export interface ScriptPose {
  /** Bone directions in body space; bones left out keep their rest direction. */
  readonly dirs: Partial<Record<BoneName, Vec3>>;
  /** How curled each hand is, 0 open to 1 a fist, and how far its thumb and index tips are pinched together, 0 to 1. */
  readonly grip?: { readonly left?: number; readonly right?: number };
  readonly pinch?: { readonly left?: number; readonly right?: number };
  /** Where the hips are from the camera, in meters; the setup's distance straight ahead if left out. */
  readonly root?: Vec3;
  /** A turn of the whole body about the vertical, in radians, positive turning its left toward the camera. */
  readonly turn?: number;
  /** Pose landmarks the tracker misses this moment, hidden by something, by index. */
  readonly hidden?: readonly number[];
}

export interface Script {
  readonly name: string;
  readonly setup: SetupId;
  readonly seconds: number;
  readonly notes: string;
  readonly at: (t: number) => ScriptPose;
}

export interface SynthOptions {
  readonly fps?: number;
  /** The tracker's noise: in meters on its world points, and in widths of the image on its image points. */
  readonly worldNoise?: number;
  readonly imageNoise?: number;
  readonly seed?: number;
  readonly height?: number;
  readonly camera?: { readonly width: number; readonly height: number; readonly fov?: number };
  /** Plays the script under another setup than its own: its camera's field of view and distance. */
  readonly setup?: SetupId;
}

export interface Synth {
  readonly take: Take;
  /** The body as it really was, frame by frame: its joints in body space and its bones' frames. */
  readonly truth: readonly {
    readonly joints: Joints;
    readonly bones: Record<BoneName, Quat>;
    readonly root: Vec3;
    /** Each hand's 21 points in body space. */
    readonly hands: { readonly left: readonly Vec3[]; readonly right: readonly Vec3[] };
  }[];
  readonly proportions: Proportions;
}

/** A seeded random source, so a synthetic take is the same each time it's made. */
const random = (seed: number) => {
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  return { next, gauss: (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()) };
};

/** Joints from bone directions at given proportions, the same forward kinematics the solver uses. */
export const posed = (p: Proportions, dirs: Partial<Record<BoneName, Vec3>>, turn = 0): Joints => {
  const rest = restPose(p);
  const turnQ = axisAngle(v(0, 1, 0), turn);
  const restDir = (b: BoneName, from: JointName, to: JointName): Vec3 => rotate(turnQ, normalize(dirs[b] ?? sub(rest[to], rest[from])));
  const j = {} as Record<JointName, Vec3>;
  const go = (from: Vec3, b: BoneName, a: JointName, c: JointName) => add(from, scale(restDir(b, a, c), boneLength(p, b)));
  j.hips = v(0, 0, 0);
  j.spine = go(j.hips, "hips", "hips", "spine");
  j.chest = go(j.spine, "spine", "spine", "chest");
  j.neck = go(j.chest, "chest", "chest", "neck");
  j.head = go(j.neck, "neck", "neck", "head");
  const left = rotate(turnQ, v(1, 0, 0));
  for (const s of ["left", "right"] as const) {
    const sign = s === "left" ? 1 : -1;
    j[`${s}Shoulder`] = add(j.neck, scale(left, (sign * p.shoulderWidth) / 2));
    j[`${s}Elbow`] = go(j[`${s}Shoulder`], `${s}UpperArm`, `${s}Shoulder`, `${s}Elbow`);
    j[`${s}Wrist`] = go(j[`${s}Elbow`], `${s}Forearm`, `${s}Elbow`, `${s}Wrist`);
    j[`${s}HandTip`] = go(j[`${s}Wrist`], `${s}Hand`, `${s}Wrist`, `${s}HandTip`);
    j[`${s}Hip`] = add(j.hips, scale(left, (sign * p.hipWidth) / 2));
    j[`${s}Knee`] = go(j[`${s}Hip`], `${s}Thigh`, `${s}Hip`, `${s}Knee`);
    j[`${s}Ankle`] = go(j[`${s}Knee`], `${s}Shin`, `${s}Knee`, `${s}Ankle`);
    j[`${s}Toe`] = go(j[`${s}Ankle`], `${s}Foot`, `${s}Ankle`, `${s}Toe`);
  }
  return j;
};

/** An open hand's 21 points, for a hand 0.095 m from wrist to middle knuckle: x across toward the index, y along it. */
const OPEN_HAND: readonly [number, number, number][] = [
  [0, 0, 0],
  [0.025, 0.025, 0.012], [0.045, 0.045, 0.022], [0.06, 0.068, 0.028], [0.07, 0.092, 0.032],
  [0.025, 0.09, 0], [0.028, 0.13, 0], [0.03, 0.155, 0], [0.031, 0.175, 0],
  [0, 0.095, 0], [0, 0.14, 0], [0, 0.167, 0], [0, 0.19, 0],
  [-0.02, 0.09, 0], [-0.022, 0.13, 0], [-0.024, 0.153, 0], [-0.025, 0.172, 0],
  [-0.038, 0.08, 0], [-0.042, 0.11, 0], [-0.045, 0.128, 0], [-0.047, 0.145, 0],
];
const CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]] as const;

/**
 * A hand's points in body space: the open hand scaled to `size`, its fingers curled toward the palm by `grip`, its
 * thumb and index tips brought together by `pinch`, set on the wrist along the hand bone's frame.
 */
export const handPoints = (side: "left" | "right", frameQ: Quat, wrist: Vec3, size: number, grip = 0, pinch = 0): Vec3[] => {
  const k = size / 0.095;
  // The palm faces the frame's -z for a left hand and +z for a right one (their frames mirror each other).
  const palm = side === "left" ? -1 : 1;
  const local = OPEN_HAND.map(([x, y, z]) => v(x * k, y * k, z * k * palm));
  for (const [ci, chain] of CHAINS.entries()) {
    const amount = ci === 0 ? grip * 0.5 : grip;
    // Each joint of the finger bends by a share of the curl, toward the palm, about the axis across the hand.
    for (let i = 0; i < chain.length - 1; i++) {
      const pivot = local[chain[i]!]!;
      const q = axisAngle(v(1, 0, 0), -palm * amount * (Math.PI / 2.4));
      for (let n = i + 1; n < chain.length; n++) local[chain[n]!] = add(pivot, rotate(q, sub(local[chain[n]!]!, pivot)));
    }
  }
  if (pinch > 0) {
    // The thumb and index tips meet halfway, the joints before them following part of the way.
    const meet = scale(add(local[H.thumbTip]!, local[H.indexTip]!), 0.5);
    for (const [tip, chain] of [[H.thumbTip, CHAINS[0]], [H.indexTip, CHAINS[1]]] as const) {
      const shift = scale(sub(meet, local[tip]!), pinch);
      chain.forEach((idx, i) => (local[idx] = add(local[idx]!, scale(shift, i / (chain.length - 1)))));
    }
  }
  return local.map((p) => add(wrist, rotate(frameQ, p)));
};

/** The body's 33 landmarks from its joints and hands, as a tracker would place them. */
const poseLandmarks = (j: Joints, hands: { left: Vec3[]; right: Vec3[] }, turn: number): Vec3[] => {
  const turnQ = axisAngle(v(0, 1, 0), turn);
  const up = normalize(sub(j.head, j.neck));
  const left = normalize(sub(j.leftShoulder, j.rightShoulder));
  const fwd = normalize(cross(left, up));
  void turnQ;
  const at = (base: Vec3, f: number, u: number, l: number) => add(base, add(scale(fwd, f), add(scale(up, u), scale(left, l))));
  const out: Vec3[] = new Array(33);
  out[P.nose] = at(j.head, 0.1, -0.01, 0);
  out[P.leftEyeInner] = at(j.head, 0.085, 0.03, 0.015);
  out[P.leftEye] = at(j.head, 0.08, 0.03, 0.032);
  out[P.leftEyeOuter] = at(j.head, 0.075, 0.03, 0.048);
  out[P.rightEyeInner] = at(j.head, 0.085, 0.03, -0.015);
  out[P.rightEye] = at(j.head, 0.08, 0.03, -0.032);
  out[P.rightEyeOuter] = at(j.head, 0.075, 0.03, -0.048);
  out[P.leftEar] = at(j.head, 0, 0, 0.075);
  out[P.rightEar] = at(j.head, 0, 0, -0.075);
  out[P.mouthLeft] = at(j.head, 0.085, -0.05, 0.025);
  out[P.mouthRight] = at(j.head, 0.085, -0.05, -0.025);
  for (const s of ["left", "right"] as const) {
    const L = (n: string) => P[`${s}${n}` as keyof typeof P];
    out[L("Shoulder")] = j[`${s}Shoulder`];
    out[L("Elbow")] = j[`${s}Elbow`];
    out[L("Wrist")] = j[`${s}Wrist`];
    out[L("Pinky")] = hands[s][H.pinkyMcp]!;
    out[L("Index")] = hands[s][H.indexMcp]!;
    out[L("Thumb")] = hands[s][H.thumbIp]!;
    out[L("Hip")] = j[`${s}Hip`];
    out[L("Knee")] = j[`${s}Knee`];
    out[L("Ankle")] = j[`${s}Ankle`];
    const foot = normalize(sub(j[`${s}Toe`], j[`${s}Ankle`]));
    out[L("Heel")] = add(j[`${s}Ankle`], add(scale(foot, -0.05), v(0, -0.04, 0)));
    out[L("FootIndex")] = j[`${s}Toe`];
  }
  return out;
};

/** Plays a script into a take, seen from a camera at the origin looking down -z. */
export const synthesize = (script: Script, options: SynthOptions = {}): Synth => {
  const setupId = options.setup ?? script.setup;
  const own = SETUPS[script.setup];
  const setup = SETUPS[setupId];
  const fps = options.fps ?? 30;
  const rng = random(options.seed ?? 7);
  const wn = options.worldNoise ?? 0.008;
  const imn = options.imageNoise ?? 0.0015;
  const cam = options.camera ?? { width: 640, height: 480 };
  const fov = cam.fov ?? setup.fov;
  const fx = 0.5 / Math.tan((fov * Math.PI) / 360);
  const aspect = cam.height / cam.width;
  const p = proportionsFor(options.height ?? 1.72);
  const frames: Frame[] = [];
  const truth: Synth["truth"][number][] = [];
  const project = (q: Vec3): { x: number; y: number; inside: boolean } => {
    const d = -q.z;
    const x = 0.5 + (fx * q.x) / d;
    const y = 0.5 + (fx * -q.y) / d / aspect;
    return { x, y, inside: d > 0.05 && x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  };
  const noisy = (a: number, s: number) => a + rng.gauss() * s;
  for (let i = 0; i <= script.seconds * fps; i++) {
    const t = (i / fps) * 1000;
    const s = script.at(t / 1000);
    const turn = s.turn ?? 0;
    // A seated script sits: thighs forward and shins down, unless it says otherwise.
    const seat = own.stance === "seated" ? { leftThigh: dir(0, -0.15, 1), rightThigh: dir(0, -0.15, 1), leftShin: v(0, -1, 0), rightShin: v(0, -1, 0) } : {};
    const j = posed(p, { ...seat, ...s.dirs }, turn);
    // Under another setup, a scripted place is kept but moved out to that setup's distance.
    const home = (u: typeof setup) => v(0, -u.hipsBelow, -u.distance);
    // Under another setup, a scripted place keeps its offset from where the script's own setup puts a person.
    const root = s.root ? (setup === own ? s.root : add(home(setup), sub(s.root, home(own)))) : home(setup);
    const handFrames = boneFrames(j);
    const hands = {
      left: handPoints("left", handFrames.leftHand, j.leftWrist, p.hand, s.grip?.left ?? 0, s.pinch?.left ?? 0),
      right: handPoints("right", handFrames.rightHand, j.rightWrist, p.hand, s.grip?.right ?? 0, s.pinch?.right ?? 0),
    };
    const across = (side: "left" | "right") => normalize(sub(hands[side][H.indexMcp]!, hands[side][H.pinkyMcp]!));
    const ear = normalize(sub(j.leftShoulder, j.rightShoulder));
    truth.push({ joints: j, bones: boneFrames(j, { headLeft: ear, palmAcross: { left: across("left"), right: across("right") } }), root, hands });
    const body = poseLandmarks(j, hands, turn);
    const hidden = new Set(s.hidden ?? []);
    const image: Landmark[] = [];
    const world: Landmark[] = [];
    body.forEach((q, k) => {
      const at = project(add(q, root));
      const seen = at.inside && !hidden.has(k);
      // A missed point is still reported, as trackers do, but far off and marked unlikely.
      const off = seen ? 1 : 12;
      image.push({ x: noisy(at.x, imn * off), y: noisy(at.y, imn * off), z: -q.z * fx * 0.5, visibility: seen ? 0.95 + rng.next() * 0.04 : 0.05 + rng.next() * 0.2 });
      world.push({ x: noisy(q.x, wn * off), y: noisy(-q.y, wn * off), z: noisy(-q.z, wn * off), visibility: image[k]!.visibility! });
    });
    const handObs: HandObservation[] = [];
    for (const side of ["left", "right"] as const) {
      const wristIdx = side === "left" ? P.leftWrist : P.rightWrist;
      const at = project(add(j[`${side}Wrist`], root));
      if (!at.inside || hidden.has(wristIdx)) continue;
      const pts = hands[side];
      const center = scale(pts.reduce((a, b) => add(a, b), v(0, 0, 0)), 1 / pts.length);
      handObs.push({
        side,
        score: 0.95,
        image: pts.map((q) => {
          const pr = project(add(q, root));
          return { x: noisy(pr.x, imn * 0.5), y: noisy(pr.y, imn * 0.5), z: 0 };
        }),
        world: pts.map((q) => {
          const r = sub(q, center);
          return { x: noisy(r.x, wn * 0.3), y: noisy(-r.y, wn * 0.3), z: noisy(-r.z, wn * 0.3) };
        }),
      });
    }
    frames.push({ t, pose: { image, world }, hands: handObs });
  }
  const take: Take = { version: 1, name: script.name, setup: setupId, camera: { width: cam.width, height: cam.height, facing: setup.facing, fov }, created: "2026-01-01T00:00:00.000Z", notes: script.notes, frames };
  return { take, truth, proportions: p };
};

const deg = Math.PI / 180;
const dir = (x: number, y: number, z: number): Vec3 => normalize(v(x, y, z));
const wave = (t: number, hz: number) => Math.sin(2 * Math.PI * hz * t);

/** A few scripted movements, one per kind of thing worth testing. */
export const SCRIPTS: readonly Script[] = [
  {
    name: "Wave",
    setup: "phone-stand",
    seconds: 4,
    notes: "Standing, the right hand raised and waving, the left arm hanging.",
    at: (t) => {
      const a = wave(t, 1.5) * 35 * deg;
      return {
        dirs: {
          rightUpperArm: dir(-1, 0.6, 0.1),
          rightForearm: dir(-Math.sin(a), Math.cos(a), 0.05),
          rightHand: dir(-Math.sin(a) * 1.2, Math.cos(a), 0.05),
          leftUpperArm: dir(0.15, -1, 0.05),
          leftForearm: dir(0.05, -1, 0.3),
          leftHand: dir(0, -1, 0.2),
        },
        grip: { left: 0.4 },
      };
    },
  },
  {
    name: "Reach and pinch",
    setup: "desk",
    seconds: 4,
    notes: "Seated at a webcam, reaching toward the screen and pinching, then back.",
    at: (t) => {
      const k = (1 - Math.cos(2 * Math.PI * 0.5 * t)) / 2;
      return {
        dirs: {
          rightUpperArm: dir(-0.1, -1 + 0.5 * k, 0.2 + 0.6 * k),
          rightForearm: dir(0.5 - 0.2 * k, 0.6 - 0.2 * k, 0.4 + 0.6 * k),
          rightHand: dir(0.3, 0.6, 0.6),
          leftUpperArm: dir(0.15, -1, 0.35),
          leftForearm: dir(-0.3, 0.5, 1),
          leftHand: dir(-0.2, 0.4, 1),
        },
        pinch: { right: k > 0.8 ? 1 : 0 },
      };
    },
  },
  {
    name: "Joust",
    setup: "desk",
    seconds: 5,
    notes: "Seated: the right arm couches a lance, the left holds the reins, leaning in and bracing, the torso turning.",
    at: (t) => {
      const lean = (1 - Math.cos(2 * Math.PI * 0.4 * t)) / 2;
      const swing = wave(t, 0.3) * 0.15;
      return {
        dirs: {
          hips: dir(swing * 0.3, 1, 0.1 + 0.35 * lean),
          spine: dir(swing * 0.3, 1, 0.1 + 0.35 * lean),
          chest: dir(swing * 0.3, 1, 0.1 + 0.35 * lean),
          neck: dir(0, 1, 0.1),
          rightUpperArm: dir(-0.25, -1, -0.35),
          rightForearm: dir(swing, 0.1, 1),
          rightHand: dir(swing, 0.1, 1),
          leftUpperArm: dir(0.1, -0.7, 0.6),
          leftForearm: dir(-0.4, 0.2, 1),
          leftHand: dir(-0.3, 0, 1),
        },
        grip: { right: 0.9, left: 0.8 },
        turn: wave(t, 0.4) * 12 * deg,
        // Back a little from the webcam, so the hips are just in view, as when playing.
        root: v(0, -0.35, -1.1),
      };
    },
  },
  {
    name: "Squat",
    setup: "phone-stand",
    seconds: 4,
    notes: "Standing, squatting down and up with the arms out in front.",
    at: (t) => {
      const k = (1 - Math.cos(2 * Math.PI * 0.5 * t)) / 2;
      const knee = 100 * k * deg;
      const thigh = dir(0, -Math.cos(knee * 0.7), Math.sin(knee * 0.7));
      const shin = dir(0, -Math.cos(knee * 0.3), -Math.sin(knee * 0.3));
      const torso = dir(0, 1, 0.5 * k);
      return {
        dirs: {
          hips: torso, spine: torso, chest: torso,
          leftThigh: thigh, rightThigh: thigh, leftShin: shin, rightShin: shin,
          leftUpperArm: dir(0.1, -0.3 + 0.3 * k, 1), rightUpperArm: dir(-0.1, -0.3 + 0.3 * k, 1),
          leftForearm: dir(0, 0, 1), rightForearm: dir(0, 0, 1), leftHand: dir(0, 0, 1), rightHand: dir(0, 0, 1),
        },
        root: v(0, -0.1 - 0.45 * k, -2.5),
      };
    },
  },
  {
    name: "Out of frame",
    setup: "desk",
    seconds: 5,
    notes: "Seated at a webcam: the right hand rises out of the top of the image, stays out a second, comes back; the left elbow is hidden behind the desk for a moment.",
    at: (t) => {
      const k = t < 1 ? 0 : t < 2 ? t - 1 : t < 3 ? 1 : t < 4 ? 4 - t : 0;
      return {
        dirs: {
          rightUpperArm: dir(-0.3, -1 + 2.2 * k, 0.4 - 0.2 * k),
          rightForearm: dir(0.3, 0.5 + 1.2 * k, 1 - 0.8 * k),
          rightHand: dir(0.2, 0.4 + k, 1 - 0.5 * k),
          leftUpperArm: dir(0.15, -1, 0.35),
          leftForearm: dir(-0.3, 0.5, 1),
        },
        hidden: t > 2.2 && t < 3.2 ? [P.leftElbow] : [],
      };
    },
  },
];
