// From what the tracker saw to a body: each frame's landmarks are filtered, fitted to the skeleton at this person's own
// proportions (learned as the take goes), with what isn't seen held a moment and then eased to what the setup says it
// most likely is doing, and placed in front of the camera where the image says it stands.
//
// The result keeps its bones the same length from frame to frame, says how sure it is of each joint, and gives each
// bone's rotation, which is what a character is driven from.
import { FILTER_DEFAULTS, type FilterOptions, PointsFilter } from "./filter";
import { FINGERS, H, type Landmark, P } from "./landmarks";
import { BONES, BONE_NAMES, BONE_PARENT, type BoneName, JOINTS, type JointName, type Joints, type Proportions, boneLength, proportionsFor, restPose } from "./skeleton";
import { SETUPS, type Setup, type SetupId } from "./setups";
import type { CameraInfo, Frame, HandObservation, Take } from "./take";
import { type Quat, type Vec3, add, conjugate, cross, distance, dot, frame, length, lerp, median, mid, normalize, qmul, scale, slerp, sub, v } from "./vec";

export interface SolveOptions {
  readonly setup: SetupId;
  /** The person's height in meters, when known: sets the scale before the take has shown enough to measure. */
  readonly height?: number;
  /** Smoothing; false to take the landmarks as they come. */
  readonly filter?: FilterOptions | false;
  /** How visible a landmark must be to count as seen, 0 to 1. */
  readonly visible?: number;
  /** Whether to keep learning the person's proportions from what is seen. Default true. */
  readonly calibrate?: boolean;
  /** How long a part that went out of sight is held where it was before easing to its likely pose, in milliseconds. */
  readonly hold?: number;
}

export type JointSource = "seen" | "held" | "assumed";

export interface JointState {
  /** Where the joint is, in body space (see skeleton.ts). */
  readonly p: Vec3;
  readonly confidence: number;
  readonly source: JointSource;
}

export interface HandState {
  readonly side: "left" | "right";
  /** The 21 hand joints in body space, at this person's hand size. */
  readonly points: readonly Vec3[];
  /** How far apart the thumb and index tips are, over the hand's length: about 0.1 pinched, 1 or more open. */
  readonly pinch: number;
  /** How bent each finger is, 0 straight to 1 curled. */
  readonly curl: Readonly<Record<keyof typeof FINGERS, number>>;
}

export interface Body {
  readonly t: number;
  readonly joints: Readonly<Record<JointName, JointState>>;
  /** Each bone's orientation in body space: its y axis along the bone, its x axis its hinge or its side. */
  readonly bones: Readonly<Record<BoneName, Quat>>;
  /** Each bone's rotation from its rest orientation, in body space: what turns a character's bone from its rest pose. */
  readonly rotations: Readonly<Record<BoneName, Quat>>;
  /** Each bone's orientation relative to its parent bone's. */
  readonly local: Readonly<Record<BoneName, Quat>>;
  /** Where the middle of the hips is from the camera, in meters (x right, y up, z toward the viewer), when it can be told. */
  readonly root: Vec3 | null;
  readonly hands: { readonly left?: HandState; readonly right?: HandState };
  readonly proportions: Proportions;
  /** Whether a body was seen in this frame at all. */
  readonly seen: boolean;
}

/** From the tracker's world axes (x right, y down, z away) to body space (x right, y up, z toward the camera). */
const toBody = (l: Landmark): Vec3 => v(l.x, -l.y, -l.z);

/** The rest pose's bone frames, which the rotations are measured from. */
const REST = restPose();

/** The measurements calibration learns, and which landmarks each is taken between. */
type Measure = keyof Proportions;

/**
 * The bones' frames from where the joints are, each twisted by a hint: the line across the hips or the shoulders for
 * the torso, the hinge of the elbow or the knee for the limbs (the line across the shoulders or hips when the limb is
 * straight and the hinge can't be seen), and the line across the knuckles for the forearm and hand.
 */
export interface FrameHints {
  /** The line from the right ear to the left. */
  readonly headLeft?: Vec3;
  /** Each hand's line across the knuckles, from the little finger's to the index's. */
  readonly palmAcross?: { readonly left?: Vec3; readonly right?: Vec3 };
  /** Limbs whose lower part wasn't seen, so their bend says nothing about their twist. */
  readonly unbent?: ReadonlySet<"leftArm" | "rightArm" | "leftLeg" | "rightLeg">;
}

export const boneFrames = (j: Joints, hints: FrameHints = {}): Record<BoneName, Quat> => {
  const hipsLeft = normalize(sub(j.leftHip, j.rightHip), v(1, 0, 0));
  const shouldersLeft = normalize(sub(j.leftShoulder, j.rightShoulder), hipsLeft);
  const torsoUp = normalize(sub(j.neck, j.hips));
  const forward = normalize(cross(shouldersLeft, torsoUp), v(0, 0, 1));
  const hinge = (a: Vec3, b: Vec3, fallback: Vec3): Vec3 => {
    const h = cross(normalize(a), normalize(b));
    // Under about 20° of bend the hinge is mostly noise: lean on the fallback.
    const w = Math.min(1, length(h) / Math.sin((20 * Math.PI) / 180));
    return normalize(add(scale(fallback, 1 - w), scale(normalize(h, fallback), w)), fallback);
  };
  const arm = (side: "left" | "right") => {
    const s = side === "left" ? "left" : "right";
    const upper = sub(j[`${s}Elbow`], j[`${s}Shoulder`]);
    const fore = sub(j[`${s}Wrist`], j[`${s}Elbow`]);
    const hand = sub(j[`${s}HandTip`], j[`${s}Wrist`]);
    // A straight arm's twist shows only in its hand: the elbow's axis is square to the forearm and the knuckles' line.
    // With no hand seen, it bends as an elbow would: around the axis square to it and to the way the chest faces.
    const palm = hints.palmAcross?.[side];
    const byPalm = palm ? cross(normalize(fore), palm) : null;
    const straight = byPalm && length(byPalm) > 0.3 ? normalize(byPalm) : normalize(cross(normalize(upper), forward), side === "left" ? v(0, -1, 0) : v(0, 1, 0));
    const h = hints.unbent?.has(`${side}Arm`) ? straight : hinge(upper, fore, straight);
    // The palm's line across the knuckles, or as the forearm would be with no twist.
    const across = hints.palmAcross?.[side] ?? normalize(cross(h, normalize(fore)), v(0, 0, 1));
    return { upper: frame(upper, h), fore: frame(fore, across), hand: frame(hand, across) };
  };
  const leg = (side: "left" | "right") => {
    const s = side;
    const thigh = sub(j[`${s}Knee`], j[`${s}Hip`]);
    const shin = sub(j[`${s}Ankle`], j[`${s}Knee`]);
    const foot = sub(j[`${s}Toe`], j[`${s}Ankle`]);
    const h = hints.unbent?.has(`${side}Leg`) ? hipsLeft : hinge(thigh, shin, hipsLeft);
    return { thigh: frame(thigh, h), shin: frame(shin, h), foot: frame(foot, h) };
  };
  const l = arm("left");
  const r = arm("right");
  const ll = leg("left");
  const rl = leg("right");
  return {
    hips: frame(sub(j.spine, j.hips), hipsLeft),
    spine: frame(sub(j.chest, j.spine), normalize(add(hipsLeft, shouldersLeft), hipsLeft)),
    chest: frame(sub(j.neck, j.chest), shouldersLeft),
    neck: frame(sub(j.head, j.neck), hints.headLeft ?? shouldersLeft),
    leftUpperArm: l.upper, leftForearm: l.fore, leftHand: l.hand,
    rightUpperArm: r.upper, rightForearm: r.fore, rightHand: r.hand,
    leftThigh: ll.thigh, leftShin: ll.shin, leftFoot: ll.foot,
    rightThigh: rl.thigh, rightShin: rl.shin, rightFoot: rl.foot,
  };
};

/** The rest pose's frames. */
export const REST_FRAMES = boneFrames(REST);

/** Where each bone most likely points while it isn't seen, for a setup: arms hanging, legs standing or seated. */
const likelyDirection = (bone: BoneName, setup: Setup): Vec3 | null => {
  const seated = setup.stance === "seated";
  switch (bone) {
    case "leftUpperArm": return normalize(v(0.15, -1, 0.05));
    case "rightUpperArm": return normalize(v(-0.15, -1, 0.05));
    case "leftForearm": case "rightForearm": return normalize(v(0, -1, 0.25));
    case "leftHand": case "rightHand": return normalize(v(0, -1, 0.15));
    case "leftThigh": case "rightThigh": return seated ? normalize(v(0, -0.15, 1)) : v(0, -1, 0);
    case "leftShin": case "rightShin": return v(0, -1, 0);
    case "leftFoot": case "rightFoot": return normalize(v(0, -0.3, 1));
    default: return null;
  }
};

/** Fits each frame's landmarks to the skeleton, frame after frame, keeping what it learns about the person. */
export class Solver {
  readonly setup: Setup;
  private readonly visible: number;
  private readonly hold: number;
  private readonly calibrating: boolean;
  private readonly base: Proportions;
  private readonly measured = new Map<Measure, number[]>();
  private readonly poseFilter: PointsFilter | null;
  private readonly rootFilter: PointsFilter | null;
  private readonly handFilters: { left: PointsFilter | null; right: PointsFilter | null };
  /** Each bone's last direction and when it was last seen. */
  private readonly last = new Map<BoneName, { dir: Vec3; t: number; seen: boolean }>();
  private cached: Proportions;

  constructor(options: SolveOptions) {
    this.setup = SETUPS[options.setup];
    this.visible = options.visible ?? 0.5;
    this.hold = options.hold ?? 400;
    this.calibrating = options.calibrate ?? true;
    this.base = proportionsFor(options.height);
    this.cached = this.base;
    const f = options.filter === false ? null : (options.filter ?? FILTER_DEFAULTS);
    this.poseFilter = f && new PointsFilter(f);
    this.rootFilter = f && new PointsFilter(f);
    this.handFilters = { left: f && new PointsFilter(f), right: f && new PointsFilter(f) };
  }

  /** The person's proportions as learned so far: measured where enough was seen, the rest scaled to match. */
  get proportions(): Proportions {
    return this.cached;
  }

  reset(): void {
    this.poseFilter?.reset();
    this.rootFilter?.reset();
    this.handFilters.left?.reset();
    this.handFilters.right?.reset();
    this.last.clear();
  }

  private measure(key: Measure, value: number): void {
    if (!this.calibrating || !(value > 0.01)) return;
    let list = this.measured.get(key);
    if (!list) this.measured.set(key, (list = []));
    list.push(value);
    if (list.length > 600) list.shift();
  }

  private updateProportions(): void {
    const known: Partial<Record<Measure, number>> = {};
    const ratios: number[] = [];
    for (const [key, list] of this.measured) {
      if (list.length < 10) continue;
      known[key] = median(list);
      ratios.push(known[key]! / this.base[key]);
    }
    const k = ratios.length ? median(ratios) : 1;
    const out = {} as Record<Measure, number>;
    for (const key of Object.keys(this.base) as Measure[]) out[key] = known[key] ?? this.base[key] * k;
    this.cached = out;
  }

  /** The body in one frame. Frames are expected in order of time. */
  solve(f: Frame, camera: CameraInfo): Body {
    const t = f.t;
    const vis = this.visible;
    const world = f.pose ? (this.poseFilter ? this.poseFilter.next(f.pose.world.map(toBody), t) : f.pose.world.map(toBody)) : null;
    const seenAt = (i: number): number => f.pose?.world[i]?.visibility ?? (f.pose ? 1 : 0);
    const W = (i: number): Vec3 => world![i]!;
    const both = (a: number, b: number): number => Math.min(seenAt(a), seenAt(b));

    // Calibrate: lengths measured between landmarks seen clearly.
    if (world) {
      const sure = Math.max(vis, 0.8);
      const m = (key: Measure, a: Vec3, b: Vec3, c: number) => c >= sure && this.measure(key, distance(a, b));
      m("shoulderWidth", W(P.leftShoulder), W(P.rightShoulder), both(P.leftShoulder, P.rightShoulder));
      m("hipWidth", W(P.leftHip), W(P.rightHip), both(P.leftHip, P.rightHip));
      const hc = mid(W(P.leftHip), W(P.rightHip));
      const sc = mid(W(P.leftShoulder), W(P.rightShoulder));
      m("torso", hc, sc, Math.min(both(P.leftHip, P.rightHip), both(P.leftShoulder, P.rightShoulder)));
      m("neck", sc, mid(W(P.leftEar), W(P.rightEar)), Math.min(both(P.leftShoulder, P.rightShoulder), both(P.leftEar, P.rightEar)));
      for (const s of ["left", "right"] as const) {
        const L = (n: string) => P[`${s}${n}` as keyof typeof P];
        m("upperArm", W(L("Shoulder")), W(L("Elbow")), both(L("Shoulder"), L("Elbow")));
        m("forearm", W(L("Elbow")), W(L("Wrist")), both(L("Elbow"), L("Wrist")));
        m("thigh", W(L("Hip")), W(L("Knee")), both(L("Hip"), L("Knee")));
        m("shin", W(L("Knee")), W(L("Ankle")), both(L("Knee"), L("Ankle")));
        m("foot", W(L("Ankle")), W(L("FootIndex")), both(L("Ankle"), L("FootIndex")));
      }
    }
    // Hands: matched to the body's wrists in the image, their size measured from their own metric points.
    const hands = this.matchHands(f);
    for (const h of Object.values(hands)) if (h && h.score > 0.6) this.measure("hand", distance(toBody(h.world[H.wrist]!), toBody(h.world[H.middleMcp]!)));
    this.updateProportions();
    const p = this.cached;

    // Each bone's direction: seen, held a moment, or eased to where it likely is.
    const dirs = {} as Record<BoneName, { dir: Vec3; source: JointSource; confidence: number }>;
    const observe = (bone: BoneName, from: () => Vec3, to: () => Vec3, confidence: number): void => {
      const prev = this.last.get(bone);
      if (world && confidence >= vis) {
        const dir = normalize(sub(to(), from()), prev?.dir ?? v(0, 1, 0));
        this.last.set(bone, { dir, t, seen: true });
        dirs[bone] = { dir, source: "seen", confidence };
        return;
      }
      const likely = likelyDirection(bone, this.setup) ?? prev?.dir ?? normalize(sub(REST[BONES[bone][1]], REST[BONES[bone][0]]));
      if (!prev) {
        dirs[bone] = { dir: likely, source: "assumed", confidence: 0 };
        return;
      }
      const since = t - prev.t;
      if (since <= this.hold) {
        dirs[bone] = { dir: prev.dir, source: "held", confidence: 0.5 * (1 - since / this.hold) };
        return;
      }
      // Ease toward the likely direction over about a second, so a part that leaves the frame doesn't snap.
      const k = Math.min(1, (since - this.hold) / 1000);
      const dir = normalize(lerp(prev.dir, likely, k * 0.15), likely);
      this.last.set(bone, { dir, t: prev.t, seen: false });
      dirs[bone] = { dir, source: k >= 1 ? "assumed" : "held", confidence: 0 };
    };
    const hipsC = () => mid(W(P.leftHip), W(P.rightHip));
    const shouldersC = () => mid(W(P.leftShoulder), W(P.rightShoulder));
    const torsoSeen = world ? Math.min(both(P.leftHip, P.rightHip), both(P.leftShoulder, P.rightShoulder)) : 0;
    observe("hips", hipsC, shouldersC, torsoSeen);
    dirs.spine = dirs.hips;
    dirs.chest = dirs.hips;
    observe("neck", shouldersC, () => mid(W(P.leftEar), W(P.rightEar)), world ? Math.min(both(P.leftShoulder, P.rightShoulder), both(P.leftEar, P.rightEar)) : 0);
    for (const s of ["left", "right"] as const) {
      const L = (n: string) => P[`${s}${n}` as keyof typeof P];
      observe(`${s}UpperArm`, () => W(L("Shoulder")), () => W(L("Elbow")), both(L("Shoulder"), L("Elbow")));
      observe(`${s}Forearm`, () => W(L("Elbow")), () => W(L("Wrist")), both(L("Elbow"), L("Wrist")));
      const hand = hands[s];
      if (hand) {
        // The hand's own points say where it points far better than the body's few hand landmarks.
        const hw = hand.world.map(toBody);
        observe(`${s}Hand`, () => hw[H.wrist]!, () => hw[H.middleMcp]!, hand.score);
      } else observe(`${s}Hand`, () => W(L("Wrist")), () => mid(W(L("Index")), W(L("Pinky"))), Math.min(seenAt(L("Wrist")), seenAt(L("Index")), seenAt(L("Pinky"))));
      observe(`${s}Thigh`, () => W(L("Hip")), () => W(L("Knee")), both(L("Hip"), L("Knee")));
      observe(`${s}Shin`, () => W(L("Knee")), () => W(L("Ankle")), both(L("Knee"), L("Ankle")));
      observe(`${s}Foot`, () => W(L("Ankle")), () => W(L("FootIndex")), both(L("Ankle"), L("FootIndex")));
    }

    // The lines across the hips and the shoulders, which place the hip and shoulder joints.
    const across = (a: number, b: number, key: "hipsAcross" | "shouldersAcross", fallback: Vec3): Vec3 => {
      const prev = this.acrossLast[key];
      if (world && both(a, b) >= vis) return (this.acrossLast[key] = normalize(sub(W(a), W(b)), fallback));
      return prev ?? fallback;
    };
    const hipsLeft = across(P.leftHip, P.rightHip, "hipsAcross", v(1, 0, 0));
    const shouldersLeft = across(P.leftShoulder, P.rightShoulder, "shouldersAcross", hipsLeft);

    // Forward kinematics at this person's proportions.
    const j = {} as Record<JointName, Vec3>;
    const go = (from: Vec3, bone: BoneName): Vec3 => add(from, scale(dirs[bone].dir, boneLength(p, bone)));
    j.hips = v(0, 0, 0);
    j.spine = go(j.hips, "hips");
    j.chest = go(j.spine, "spine");
    j.neck = go(j.chest, "chest");
    j.head = go(j.neck, "neck");
    for (const s of ["left", "right"] as const) {
      const sign = s === "left" ? 1 : -1;
      j[`${s}Shoulder`] = add(j.neck, scale(shouldersLeft, (sign * p.shoulderWidth) / 2));
      j[`${s}Elbow`] = go(j[`${s}Shoulder`], `${s}UpperArm`);
      j[`${s}Wrist`] = go(j[`${s}Elbow`], `${s}Forearm`);
      j[`${s}HandTip`] = go(j[`${s}Wrist`], `${s}Hand`);
      j[`${s}Hip`] = add(j.hips, scale(hipsLeft, (sign * p.hipWidth) / 2));
      j[`${s}Knee`] = go(j[`${s}Hip`], `${s}Thigh`);
      j[`${s}Ankle`] = go(j[`${s}Knee`], `${s}Shin`);
      j[`${s}Toe`] = go(j[`${s}Ankle`], `${s}Foot`);
    }

    // The hands' 21 points, hung from the wrists at this person's hand size.
    const handStates: { left?: HandState; right?: HandState } = {};
    const palmAcross: { left?: Vec3; right?: Vec3 } = {};
    for (const s of ["left", "right"] as const) {
      const obs = hands[s];
      if (!obs) continue;
      const filter = this.handFilters[s];
      const hw = filter ? filter.next(obs.world.map(toBody), t) : obs.world.map(toBody);
      const k = p.hand / (distance(hw[H.wrist]!, hw[H.middleMcp]!) || p.hand);
      const points = hw.map((q) => add(j[`${s}Wrist`], scale(sub(q, hw[H.wrist]!), k)));
      palmAcross[s] = normalize(sub(points[H.indexMcp]!, points[H.pinkyMcp]!), v(0, 0, 1));
      // The hand's tip follows its own points, so the hand bone and the hand agree.
      j[`${s}HandTip`] = points[H.middleMcp]!;
      handStates[s] = { side: s, points, pinch: distance(points[H.thumbTip]!, points[H.indexTip]!) / p.hand, curl: curls(points) };
    }

    const headLeft = world && both(P.leftEar, P.rightEar) >= vis ? normalize(sub(W(P.leftEar), W(P.rightEar)), shouldersLeft) : shouldersLeft;
    const unbent = new Set<"leftArm" | "rightArm" | "leftLeg" | "rightLeg">();
    for (const s of ["left", "right"] as const) {
      if (dirs[`${s}UpperArm`].source === "seen" && dirs[`${s}Forearm`].source !== "seen") unbent.add(`${s}Arm`);
      if (dirs[`${s}Thigh`].source === "seen" && dirs[`${s}Shin`].source !== "seen") unbent.add(`${s}Leg`);
    }
    const bones = boneFrames(j, { headLeft, palmAcross, unbent });
    const rotations = {} as Record<BoneName, Quat>;
    const local = {} as Record<BoneName, Quat>;
    for (const b of BONE_NAMES) {
      rotations[b] = qmul(bones[b], conjugate(REST_FRAMES[b]));
      const parent = BONE_PARENT[b];
      local[b] = parent ? qmul(conjugate(bones[parent]), bones[b]) : bones[b];
    }

    // Each joint's confidence: its bone's, and the hips' and the torso's from the torso.
    const joints = {} as Record<JointName, JointState>;
    const jointBone: Partial<Record<JointName, BoneName>> = {};
    for (const b of BONE_NAMES) jointBone[BONES[b][1]] = b;
    for (const name of JOINTS) {
      const b = jointBone[name] ?? (name.endsWith("Shoulder") ? "chest" : "hips");
      const d = dirs[b];
      joints[name] = { p: j[name], confidence: d.confidence, source: d.source };
    }

    // Where the body stands from the camera: the move that lays its points over where the image saw them.
    let root: Vec3 | null = null;
    if (world && f.pose) {
      const r = placeRoot(f.pose.image, world, camera, this.setup, vis, f.pose.world);
      root = r && this.rootFilter ? this.rootFilter.next([r], t)[0]! : r;
    }
    return { t, joints, bones, rotations, local, root, hands: handStates, proportions: p, seen: !!world };
  }

  private acrossLast: { hipsAcross?: Vec3; shouldersAcross?: Vec3 } = {};

  /** Which observed hand is which of the person's: by which of the body's wrists it is nearest in the image. */
  private matchHands(f: Frame): { left?: HandObservation; right?: HandObservation } {
    const out: { left?: HandObservation; right?: HandObservation } = {};
    const img = f.pose?.image;
    for (const h of f.hands) {
      let side = h.side;
      if (img) {
        const w = h.image[H.wrist]!;
        const dl = Math.hypot(w.x - img[P.leftWrist]!.x, w.y - img[P.leftWrist]!.y);
        const dr = Math.hypot(w.x - img[P.rightWrist]!.x, w.y - img[P.rightWrist]!.y);
        if (Math.min(dl, dr) < 0.15) side = dl < dr ? "left" : "right";
      }
      if (!side) continue;
      const taken = out[side];
      if (!taken || taken.score < h.score) out[side] = h;
    }
    return out;
  }
}

/** How bent each finger is, from the angles at its joints: 0 straight, 1 fully curled. */
const curls = (points: readonly Vec3[]): HandState["curl"] => {
  const out = {} as Record<keyof typeof FINGERS, number>;
  for (const [name, chain] of Object.entries(FINGERS) as [keyof typeof FINGERS, readonly number[]][]) {
    const pts = [points[H.wrist]!, ...chain.map((i) => points[i]!)];
    let bend = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = normalize(sub(pts[i]!, pts[i - 1]!));
      const b = normalize(sub(pts[i + 1]!, pts[i]!));
      bend += Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
    }
    // A fist bends a finger about 250° along its joints; the thumb, less.
    out[name] = Math.min(1, bend / ((name === "thumb" ? 150 : 250) * (Math.PI / 180)));
  }
  return out;
};

/**
 * Where the middle of the hips is from the camera: the translation that best lays the body's points (in meters around
 * the hips) over where the image saw them, through a pinhole camera of the given field of view. A least-squares solve
 * of the projection equations, linear in the translation.
 */
export const placeRoot = (image: readonly Landmark[], body: readonly Vec3[], camera: CameraInfo, setup: Setup, visible = 0.5, raw?: readonly Landmark[]): Vec3 | null => {
  const fov = ((camera.fov ?? setup.fov) * Math.PI) / 180;
  const fx = 0.5 / Math.tan(fov / 2);
  const aspect = camera.height / camera.width;
  // Normal equations, A^T A x = A^T b, built a row at a time.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  let rows = 0;
  const row = (a0: number, a1: number, a2: number, b: number) => {
    const a = [a0, a1, a2];
    for (let i = 0; i < 3; i++) {
      r[i]! += a[i]! * b;
      for (let k = 0; k < 3; k++) m[i * 3 + k]! += a[i]! * a[k]!;
    }
    rows++;
  };
  for (let i = 0; i < Math.min(image.length, body.length); i++) {
    if ((raw?.[i]?.visibility ?? image[i]!.visibility ?? 1) < visible) continue;
    const J = body[i]!;
    const u = image[i]!.x - 0.5;
    const a = (image[i]!.y - 0.5) * aspect;
    row(fx, 0, u, -u * J.z - fx * J.x);
    row(0, fx, -a, a * J.z - fx * J.y);
  }
  if (rows < 6) return null;
  const T = solve3(m, r);
  return T && T.z < -0.05 ? T : null;
};

const solve3 = (m: number[], b: number[]): Vec3 | null => {
  const [a, b1, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [e * i - f * h, c * h - b1 * i, b1 * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b1 * g - a * h, a * e - b1 * d];
  const x = (k: number) => (inv[k * 3]! * b[0]! + inv[k * 3 + 1]! * b[1]! + inv[k * 3 + 2]! * b[2]!) / det;
  return v(x(0), x(1), x(2));
};

/** Every frame of a take through a fresh solver. */
export const solveTake = (take: Take, options: Partial<SolveOptions> = {}): Body[] => {
  const solver = new Solver({ setup: take.setup, ...options });
  return take.frames.map((f) => solver.solve(f, take.camera));
};

