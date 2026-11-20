// A rigged character driven by the solved body: a glTF with a skeleton, read into the motion package's rig, posed by
// its retargeting each frame, scaled to the person and stood where the solver placed them.
import "@babylonjs/loaders/glTF";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { type Body, type JointName, type Rig, type RigMap, Retarget, type Vec3, distance, normalize, sub } from "@canvas-ir/motion";
import robotUrl from "./robot.glb" with { type: "file" };

export interface CharacterSpec {
  readonly url: string;
  /** The map from the body to the character's bones, made once the rig is read (offsets depend on its size). */
  readonly map: (rig: Rig) => RigMap;
  /** Bones that don't hang from the bone they move with (a foot kept beside the leg for its own IK): kept at their rest offset from it. */
  readonly follow?: readonly (readonly [string, string])[];
  /** Nodes shrunk to bring a cartoon's proportions nearer a person's (a big head hides the arms in front of it). */
  readonly shrink?: Readonly<Record<string, number>>;
}

const side = (s: "L" | "R") => {
  const n = (x: string) => `${x}.${s}`;
  return n;
};

/** RobotExpressive: a CC0 robot by Quaternius with fingers, a big head and short legs. */
export const ROBOT: CharacterSpec = {
  url: robotUrl,
  follow: [["Foot.L", "LowerLeg.L"], ["Foot.R", "LowerLeg.R"]],
  shrink: { Head: 0.5 },
  map: (rig) => {
    const at = (name: string) => rig.bones.find((b) => b.name === name)!.rest.p;
    const L = side("L");
    const R = side("R");
    const toe = (s: "L" | "R") => ({ node: `Foot.${s}`, offset: { x: 0, y: 0, z: 0.4 * distance(at(`LowerLeg.${s}`), at(`Foot.${s}`)) } });
    const arm = (n: (x: string) => string, prefix: "left" | "right") => ({
      [`${prefix}UpperArm`]: n("UpperArm"),
      [`${prefix}Forearm`]: n("LowerArm"),
      [`${prefix}Hand`]: [n("Palm1"), n("Palm2"), n("Palm3")],
      [`${prefix}Thigh`]: n("UpperLeg"),
      [`${prefix}Shin`]: n("LowerLeg"),
      [`${prefix}Foot`]: n("Foot"),
    });
    const joints = (n: (x: string) => string, prefix: "left" | "right", s: "L" | "R") => ({
      [`${prefix}Shoulder`]: n("UpperArm"),
      [`${prefix}Elbow`]: n("LowerArm"),
      [`${prefix}Wrist`]: n("Palm2"),
      [`${prefix}HandTip`]: n("Middle1"),
      [`${prefix}Hip`]: n("UpperLeg"),
      [`${prefix}Knee`]: n("LowerLeg"),
      [`${prefix}Ankle`]: n("Foot"),
      [`${prefix}Toe`]: toe(s),
    });
    const fingers = (n: (x: string) => string) => ({
      index1: n("Index"), index2: n("Index2"), middle1: n("Middle1"), middle2: n("Middle2"),
      ring1: n("Ring1"), ring2: n("Ring2"), thumb1: n("Thumb"), thumb2: n("Thumb2"),
    });
    // The robot's ".L" bones are on its left, at +x, as it faces +z.
    return {
      bones: { hips: "Hips", spine: "Abdomen", chest: "Torso", neck: "Neck", ...arm(L, "left"), ...arm(R, "right") },
      joints: { hips: "Hips", spine: "Abdomen", chest: "Torso", neck: "Neck", head: "Head", ...joints(L, "left", "L"), ...joints(R, "right", "R") },
      fingers: { left: fingers(L), right: fingers(R) },
      palmAcross: { left: [L("Palm3"), L("Palm1")], right: [R("Palm3"), R("Palm1")] },
    } as RigMap;
  },
};

/**
 * A plain human mannequin rigged for MediaPipe (bones named hips, spine, chest, upper_chest, neck, head, clavicle,
 * upper_arm, forearm, hand, five three-bone fingers, thigh, shin, foot, toes, each ".L" or ".R"). It isn't in the repo:
 * give its file to whatever loads it.
 */
export const mannequinSpec = (url: string): CharacterSpec => ({
  url,
  map: () => {
    const sided = (s: "L" | "R", prefix: "left" | "right") => {
      const n = (x: string) => `${x}.${s}`;
      const fingers: Record<string, string> = {};
      for (const f of ["thumb", "index", "middle", "ring", "pinky"]) for (const i of [1, 2, 3]) fingers[`${f}${i}`] = n(`${f}_${i}`);
      return {
        bones: {
          [`${prefix}UpperArm`]: n("upper_arm"), [`${prefix}Forearm`]: n("forearm"), [`${prefix}Hand`]: n("hand"),
          [`${prefix}Thigh`]: n("thigh"), [`${prefix}Shin`]: n("shin"), [`${prefix}Foot`]: n("foot"),
        },
        joints: {
          [`${prefix}Shoulder`]: n("upper_arm"), [`${prefix}Elbow`]: n("forearm"), [`${prefix}Wrist`]: n("hand"), [`${prefix}HandTip`]: n("middle_3"),
          [`${prefix}Hip`]: n("thigh"), [`${prefix}Knee`]: n("shin"), [`${prefix}Ankle`]: n("foot"), [`${prefix}Toe`]: n("toes"),
        },
        fingers,
        across: [n("pinky_1"), n("index_1")] as const,
      };
    };
    const L = sided("L", "left");
    const R = sided("R", "right");
    return {
      bones: { hips: "hips", spine: "spine", chest: "chest", neck: "neck", ...L.bones, ...R.bones },
      joints: { hips: "hips", spine: "spine", chest: "chest", neck: "neck", head: "head", ...L.joints, ...R.joints },
      fingers: { left: L.fingers, right: R.fingers },
      palmAcross: { left: L.across, right: R.across },
    } as RigMap;
  },
});

export class Character {
  private constructor(
    private readonly root: AbstractMesh,
    private readonly nodes: Map<string, TransformNode>,
    private readonly order: readonly TransformNode[],
    readonly retarget: Retarget,
    private readonly follow: readonly { node: TransformNode; after: TransformNode; offset: Vector3 }[],
    /** The glTF root's own scale: the rig was measured with it, so the person's size multiplies it. */
    private readonly baseScale: Vector3,
  ) {}

  static async load(scene: Scene, spec: CharacterSpec): Promise<Character> {
    const result = await ImportMeshAsync(spec.url, scene, { pluginExtension: ".glb", pluginOptions: { gltf: { animationStartMode: 0 } } });
    for (const g of result.animationGroups) g.stop();
    const root = result.meshes[0]!;
    for (const m of result.meshes) {
      m.isPickable = false;
      m.alwaysSelectAsActiveMesh = true;
    }
    // Every transform node under the root, parents first: the rig, its unmapped nodes included, so each bone's parent
    // chain is whole.
    const order: TransformNode[] = [];
    const walk = (n: Node) => {
      for (const c of n.getChildren()) {
        if ("rotationQuaternion" in c && !(c as AbstractMesh).getTotalVertices?.()) {
          order.push(c as TransformNode);
          walk(c);
        }
      }
    };
    // The glTF root first: it only moves and scales, but its turn (if any) is part of every bone's world turn.
    order.push(root as unknown as TransformNode);
    walk(root);
    for (const n of order) {
      n.computeWorldMatrix(true);
      n.rotationQuaternion ??= Quaternion.FromEulerVector(n.rotation);
    }
    for (const [name, f] of Object.entries(spec.shrink ?? {})) order.find((n) => n.name === name)?.scaling.scaleInPlace(f);
    const v3 = (p: Vector3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
    const nodes = new Map(order.map((n) => [n.name, n]));
    const rig: Rig = {
      bones: order.map((n) => {
        const q = n.absoluteRotationQuaternion;
        return { name: n.name, parent: n.parent && nodes.has(n.parent.name) ? n.parent.name : null, rest: { p: v3(n.getAbsolutePosition()), q: { x: q.x, y: q.y, z: q.z, w: q.w } } };
      }),
    };
    const retarget = new Retarget(rig, spec.map(rig));
    const follow = (spec.follow ?? []).map(([name, after]) => {
      const node = nodes.get(name)!;
      const a = nodes.get(after)!;
      const offset = node.getAbsolutePosition().subtract(a.getAbsolutePosition());
      offset.rotateByQuaternionToRef(Quaternion.Inverse(a.absoluteRotationQuaternion), offset);
      return { node, after: a, offset };
    });
    return new Character(root, nodes, order, retarget, follow, root.scaling.clone());
  }

  /** Poses the character as the body, its hips at `at` (meters from the camera), at the person's size. */
  show(body: Body | null, at: Vec3): void {
    this.root.setEnabled(!!body);
    if (!body) return;
    const p = body.proportions;
    const k = (p.torso + p.thigh + p.shin) / this.retarget.size;
    this.root.scaling.copyFrom(this.baseScale).scaleInPlace(k);
    for (const [name, q] of this.retarget.pose(body)) {
      const n = this.nodes.get(name);
      if (n) n.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
    }
    // Rotations are relative to rig parents; a rig root's actual parent is the glTF root, which only scales and moves.
    this.root.computeWorldMatrix(true);
    for (const n of this.order) n.computeWorldMatrix(true);
    for (const f of this.follow) {
      const o = f.offset.scale(k);
      o.rotateByQuaternionToRef(f.after.absoluteRotationQuaternion, o);
      f.node.setAbsolutePosition(f.after.getAbsolutePosition().add(o));
      f.node.computeWorldMatrix(true);
    }
    // Stand it where the body is: its hips on the solved hips.
    const at0 = this.retarget.map.joints.hips;
    const hips = this.nodes.get(typeof at0 === "string" ? at0 : (at0?.node ?? ""));
    if (hips) {
      const now = hips.getAbsolutePosition();
      this.root.position.addInPlace(new Vector3(at.x - now.x, at.y - now.y, at.z - now.z));
      this.root.computeWorldMatrix(true);
      for (const n of this.order) n.computeWorldMatrix(true);
    }
  }

  /** Where the body's joints are on the character as it stands now, in the scene, and each hand's line across its knuckles. */
  joints(): { joints: Partial<Record<JointName, Vec3>>; palmAcross: { left?: Vec3; right?: Vec3 } } {
    const at = (name: string): Vec3 | undefined => {
      const n = this.nodes.get(name);
      if (!n) return undefined;
      const p = n.getAbsolutePosition();
      return { x: p.x, y: p.y, z: p.z };
    };
    const joints: Partial<Record<JointName, Vec3>> = {};
    for (const [j, m] of Object.entries(this.retarget.map.joints) as [JointName, string | { node: string; offset: Vec3 }][]) {
      if (typeof m === "string") {
        const p = at(m);
        if (p) joints[j] = p;
      }
      else {
        const n = this.nodes.get(m.node);
        if (!n) continue;
        const o = new Vector3(m.offset.x, m.offset.y, m.offset.z);
        const w = Vector3.TransformCoordinates(o, n.getWorldMatrix());
        joints[j] = { x: w.x, y: w.y, z: w.z };
      }
    }
    const across = (side: "left" | "right") => {
      const pair = this.retarget.map.palmAcross?.[side];
      const a = pair && at(pair[0]);
      const b = pair && at(pair[1]);
      return a && b ? normalize(sub(b, a)) : undefined;
    };
    const l = across("left");
    const r = across("right");
    return { joints, palmAcross: { ...(l ? { left: l } : {}), ...(r ? { right: r } : {}) } };
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }
}
