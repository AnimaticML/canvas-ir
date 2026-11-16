// Driving a rigged character from a solved body. A character's skeleton has its own bone names, proportions and rest
// pose (a T, an A, arms anywhere); what carries over is how each bone has turned from its rest. For each mapped bone,
// the character's rest frame is measured the same way the solver measures the body's (along the bone, twisted by its
// hinge or its side), and the bone is turned by the body bone's turn from that frame:
//
//   world_new = frame_now · frame_rest⁻¹ · world_rest
//
// then made local to its parent's new world rotation. Bones not mapped keep their rest rotation relative to their
// parent. Nothing here knows an engine: a rig is a list of bones with their rest world placement, and the result is
// each bone's new local rotation, for an adapter to set.
import { FINGERS, H } from "./landmarks";
import { type BoneName, type JointName, type Joints, JOINTS } from "./skeleton";
import { type Body, boneFrames } from "./solve";
import { type Quat, type Vec3, add, conjugate, frame, normalize, qmul, rotate, sub } from "./vec";

export interface RigBone {
  readonly name: string;
  readonly parent: string | null;
  /** Where the bone is and how it is turned at rest, in the character's world (y up, facing +z). */
  readonly rest: { readonly p: Vec3; readonly q: Quat };
}

/** A character's skeleton at rest, parents before children. */
export interface Rig {
  readonly bones: readonly RigBone[];
}

export type FingerSegment = `${keyof typeof FINGERS}${1 | 2 | 3}`;

export interface RigMap {
  /** Which of the character's bones each body bone turns; a list turns several the same way (a hand made of palms). */
  readonly bones: Partial<Record<BoneName, string | readonly string[]>>;
  /** Where each of the body's joints is on the character at rest: at a bone, or offset from it (in the rig's units). */
  readonly joints: Partial<Record<JointName, string | { readonly node: string; readonly offset: Vec3 }>>;
  /** The character's finger bones: segment 1 from the knuckle, 2 and 3 toward the tip. */
  readonly fingers?: { readonly left?: Partial<Record<FingerSegment, string>>; readonly right?: Partial<Record<FingerSegment, string>> };
  /** The two bones whose line runs across each hand at rest, from the little finger's side to the index's. */
  readonly palmAcross?: { readonly left?: readonly [string, string]; readonly right?: readonly [string, string] };
}

/** The hand points each finger segment runs between. */
const SEGMENT_POINTS = (s: FingerSegment): [number, number] => {
  const name = s.slice(0, -1) as keyof typeof FINGERS;
  const i = Number(s.slice(-1)) - 1;
  const chain = FINGERS[name];
  return [chain[i]!, chain[Math.min(i + 1, chain.length - 1)]!];
};

export class Retarget {
  private readonly byName = new Map<string, RigBone>();
  /** Each mapped bone's rest frame, and the body bone or finger segment it follows. */
  private readonly mapped = new Map<string, { rest: Quat; source: { bone: BoneName } | { side: "left" | "right"; segment: FingerSegment } }>();
  /** Each bone's rest rotation relative to its parent. */
  private readonly restLocal = new Map<string, Quat>();
  /** The rig's rest joints, for its proportions. */
  readonly restJoints: Partial<Joints> = {};

  constructor(readonly rig: Rig, readonly map: RigMap) {
    for (const b of rig.bones) this.byName.set(b.name, b);
    for (const b of rig.bones) {
      const parent = b.parent ? this.byName.get(b.parent) : null;
      this.restLocal.set(b.name, parent ? qmul(conjugate(parent.rest.q), b.rest.q) : b.rest.q);
    }
    const at = (name: string): Vec3 => {
      const b = this.byName.get(name);
      if (!b) throw new Error(`the rig has no bone ${name}`);
      return b.rest.p;
    };
    for (const j of JOINTS) {
      const m = map.joints[j];
      if (!m) continue;
      this.restJoints[j] = typeof m === "string" ? at(m) : add(at(m.node), m.offset);
    }
    // Joints the map leaves out sit where their neighbours put them, so every bone has a direction.
    const J = this.restJoints as Record<JointName, Vec3>;
    J.spine ??= J.hips && J.neck ? add(J.hips, scaleV(sub(J.neck, J.hips), 0.35)) : J.spine;
    J.chest ??= J.hips && J.neck ? add(J.hips, scaleV(sub(J.neck, J.hips), 0.7)) : J.chest;
    const across = (side: "left" | "right"): Vec3 | undefined => {
      const pair = map.palmAcross?.[side];
      return pair ? normalize(sub(at(pair[1]), at(pair[0]))) : undefined;
    };
    const palmAcross = { left: across("left"), right: across("right") };
    const frames = boneFrames(J, { palmAcross: { ...(palmAcross.left ? { left: palmAcross.left } : {}), ...(palmAcross.right ? { right: palmAcross.right } : {}) } });
    for (const [bone, nodes] of Object.entries(map.bones) as [BoneName, string | readonly string[]][]) {
      for (const n of typeof nodes === "string" ? [nodes] : nodes) this.mapped.set(n, { rest: frames[bone], source: { bone } });
    }
    for (const side of ["left", "right"] as const) {
      const fingers = map.fingers?.[side];
      if (!fingers) continue;
      const acr = palmAcross[side] ?? rotate(frames[`${side}Hand`], { x: 1, y: 0, z: 0 });
      for (const [segment, node] of Object.entries(fingers) as [FingerSegment, string][]) {
        // A finger bone's rest direction: toward the next bone of its finger, or its parent's direction at the tip.
        const next = Object.entries(fingers).find(([s]) => s.slice(0, -1) === segment.slice(0, -1) && Number(s.slice(-1)) === Number(segment.slice(-1)) + 1)?.[1];
        const bone = this.byName.get(node)!;
        const parent = bone.parent ? this.byName.get(bone.parent) : null;
        const dir = next ? sub(at(next), bone.rest.p) : parent ? sub(bone.rest.p, parent.rest.p) : { x: 0, y: 1, z: 0 };
        this.mapped.set(node, { rest: frame(dir, acr!), source: { side, segment } });
      }
    }
  }

  /** How long the rig is from hips to neck and down the left leg, in its units: for scaling it to a person. */
  get size(): number {
    const J = this.restJoints;
    const d = (a?: Vec3, b?: Vec3) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0);
    return d(J.hips, J.neck) + d(J.leftHip, J.leftKnee) + d(J.leftKnee, J.leftAnkle);
  }

  /** Each bone's new rotation relative to its parent, for the body as it is now. */
  pose(body: Body): Map<string, Quat> {
    const world = new Map<string, Quat>();
    const local = new Map<string, Quat>();
    for (const b of this.rig.bones) {
      const parentWorld = b.parent ? world.get(b.parent) : undefined;
      const m = this.mapped.get(b.name);
      let w: Quat;
      if (m) {
        let now: Quat | null = null;
        if ("bone" in m.source) now = body.bones[m.source.bone];
        else {
          const hand = body.hands[m.source.side];
          if (hand) {
            const [a, c] = SEGMENT_POINTS(m.source.segment);
            const across = normalize(sub(hand.points[H.indexMcp]!, hand.points[H.pinkyMcp]!));
            now = frame(sub(hand.points[c]!, hand.points[a]!), across);
          }
        }
        w = now ? qmul(qmul(now, conjugate(m.rest)), b.rest.q) : parentWorld ? qmul(parentWorld, this.restLocal.get(b.name)!) : b.rest.q;
      } else w = parentWorld ? qmul(parentWorld, this.restLocal.get(b.name)!) : b.rest.q;
      world.set(b.name, w);
      local.set(b.name, parentWorld ? qmul(conjugate(parentWorld), w) : w);
    }
    return local;
  }
}

const scaleV = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
