// The mannequin: the solved body drawn as plainly as it can be, a rod for each bone and a ball for each joint, so what
// the solver thinks is exactly what is seen. Color says the side and the source: blue the left, red the right, slate
// the middle; solid where seen, amber where held from a moment ago, faint grey where only assumed.
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { BONES, BONE_NAMES, type Body, HAND_LINES, JOINTS, type JointName, type JointSource, type Vec3, frame, sub, v, length } from "@canvas-ir/motion";

type Side = "left" | "right" | "middle";
const sideOf = (name: string): Side => (name.startsWith("left") ? "left" : name.startsWith("right") ? "right" : "middle");

const COLORS: Record<Side, string> = { left: "#2563eb", right: "#dc2626", middle: "#475569" };

export interface MannequinOptions {
  /** A ghost: drawn see-through in one color, for comparing against. */
  readonly ghost?: string;
}

export class Mannequin {
  readonly root: TransformNode;
  private readonly bones = new Map<string, Mesh>();
  private readonly joints = new Map<JointName, Mesh>();
  private readonly hand = { left: [] as Mesh[], right: [] as Mesh[] };
  private readonly handRods = { left: [] as Mesh[], right: [] as Mesh[] };
  private readonly materials = new Map<string, StandardMaterial>();

  constructor(private readonly scene: Scene, name: string, private readonly options: MannequinOptions = {}) {
    this.root = new TransformNode(name, scene);
    for (const b of BONE_NAMES) {
      const rod = CreateCylinder(`${name}/${b}`, { height: 1, diameter: b === "hips" || b === "spine" || b === "chest" ? 0.07 : 0.045, tessellation: 12 }, scene);
      rod.parent = this.root;
      rod.isPickable = false;
      this.bones.set(b, rod);
    }
    for (const j of JOINTS) {
      const ball = CreateSphere(`${name}/${j}`, { diameter: j === "head" ? 0.2 : 0.06, segments: 12 }, scene);
      ball.parent = this.root;
      ball.isPickable = true;
      this.joints.set(j, ball);
    }
    for (const s of ["left", "right"] as const) {
      for (let i = 0; i < 21; i++) {
        const dot = CreateSphere(`${name}/${s}Hand${i}`, { diameter: i === 0 ? 0.018 : 0.013, segments: 8 }, scene);
        dot.parent = this.root;
        dot.isPickable = false;
        this.hand[s].push(dot);
      }
      for (let i = 0; i < HAND_LINES.length; i++) {
        const rod = CreateCylinder(`${name}/${s}HandLine${i}`, { height: 1, diameter: 0.007, tessellation: 6 }, scene);
        rod.parent = this.root;
        rod.isPickable = false;
        this.handRods[s].push(rod);
      }
    }
  }

  private material(side: Side, source: JointSource): StandardMaterial {
    const key = `${side}/${source}`;
    let m = this.materials.get(key);
    if (m) return m;
    m = new StandardMaterial(`${this.root.name}/${key}`, this.scene);
    const ghost = this.options.ghost;
    const hex = ghost ?? (source === "held" ? "#f59e0b" : source === "assumed" ? "#94a3b8" : COLORS[side]);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(0.15, 0.15, 0.15);
    m.alpha = ghost ? (source === "seen" ? 0.35 : 0.15) : source === "assumed" ? 0.3 : 1;
    if (ghost) m.emissiveColor = Color3.FromHexString(hex).scale(0.4);
    this.materials.set(key, m);
    return m;
  }

  /** Puts a rod from `a` to `b`, in the root's space. */
  private static rod(mesh: Mesh, a: Vec3, b: Vec3): void {
    const d = sub(b, a);
    const len = length(d);
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    const q = frame(d, Math.abs(d.y) < 0.99 * len ? v(0, 1, 0) : v(1, 0, 0));
    mesh.rotationQuaternion = new Quaternion(q.x, q.y, q.z, q.w);
    mesh.scaling.set(1, Math.max(len, 1e-4), 1);
  }

  /** Shows a body, its hips at `at` (meters from the camera), or hides the mannequin with null. */
  show(body: Body | null, at: Vec3): void {
    this.root.setEnabled(!!body);
    if (!body) return;
    this.root.position.set(at.x, at.y, at.z);
    for (const b of BONE_NAMES) {
      const [from, to] = BONES[b];
      const rod = this.bones.get(b)!;
      Mannequin.rod(rod, body.joints[from].p, body.joints[to].p);
      const source = body.joints[to].source;
      rod.material = this.material(sideOf(b), source);
    }
    for (const j of JOINTS) {
      const ball = this.joints.get(j)!;
      const p = body.joints[j].p;
      ball.position.set(p.x, p.y, p.z);
      ball.material = this.material(sideOf(j), body.joints[j].source);
    }
    for (const s of ["left", "right"] as const) {
      const hand = body.hands[s];
      for (const dot of this.hand[s]) dot.setEnabled(!!hand);
      for (const rod of this.handRods[s]) rod.setEnabled(!!hand);
      if (!hand) continue;
      const m = this.material(s, "seen");
      hand.points.forEach((p, i) => {
        const dot = this.hand[s][i]!;
        dot.position.set(p.x, p.y, p.z);
        dot.material = m;
      });
      HAND_LINES.forEach(([a, b], i) => {
        const rod = this.handRods[s][i]!;
        Mannequin.rod(rod, hand.points[a]!, hand.points[b]!);
        rod.material = m;
      });
    }
  }

  /** Where a joint is in the room now. */
  jointAt(name: JointName): Vector3 {
    return this.joints.get(name)!.getAbsolutePosition();
  }

  /** Which joint a picked mesh is, if it is one of this mannequin's. */
  jointOf(mesh: { name: string } | null | undefined): JointName | null {
    if (!mesh) return null;
    for (const [j, m] of this.joints) if (m === mesh) return j;
    return null;
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }
}

