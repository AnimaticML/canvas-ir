// A Goldberg machine on the table: a ball waits at the top of a tower behind a gate; opened, it rolls down two ramps,
// knocks over a curving line of dominoes, and the last domino pushes a second ball across the table onto an icon on the
// desk, which it presses, as a finger would. Everything in it is a Havok body, stepped at a fixed rate (see `fixedSteps`),
// so a run can be played again from the same start and, if the engine is repeatable, end the same way.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { Scene } from "@babylonjs/core/scene";

/** Physics steps per second while the machine runs: fixed, whatever the screen's frame rate, so a run repeats. */
export const STEPS_PER_SECOND = 60;

/** Steps physics at a fixed rate from now on, `STEPS_PER_SECOND` a second of time passed, however often frames come. */
export const fixedSteps = (scene: Scene): void => scene.getPhysicsEngine()?.setSubTimeStep(1000 / STEPS_PER_SECOND);

export interface MachineOptions {
  /** Where the target is in the room: the middle of the icon the last ball presses, on the table (y = 0). */
  readonly target: Vector3;
  /** Which way along the table the machine stretches from the target, a unit vector on the table. */
  readonly along: Vector3;
  /** Called once a run's last ball reaches the target. */
  readonly onArrive: () => void;
  /** Called with a line for the status, as the run goes. */
  readonly onEvent?: (text: string) => void;
  /** Called with each moving part as it is made, to be picked up and thrown like anything else, and again as it goes. */
  readonly onPart?: (mesh: Mesh, body: PhysicsAggregate) => void;
  readonly onPartGone?: (mesh: Mesh) => void;
}

/** Where every moving part is: to tell whether two runs ended the same way. */
export type Snapshot = readonly (readonly [number, number, number, number, number, number, number])[];

export interface Machine {
  /** Opens the gate: the ball rolls. Starts from the beginning, setting everything back first if it ran before. */
  run(): void;
  /** Puts every part back where it started, the gate closed. */
  reset(): void;
  /** Whether a run is going, and how many physics steps it has taken. */
  readonly running: boolean;
  readonly steps: number;
  /** Where the moving parts are now, as position and rotation quaternions. */
  snapshot(): Snapshot;
  /** The middle of the machine, for the camera to look at, and how big it is. */
  readonly center: Vector3;
  readonly size: number;
  /** Calls back after the step `step` of the next run, with where everything is then. */
  after(step: number, then: (s: Snapshot) => void): void;
  readonly meshes: readonly Mesh[];
}

const color = (scene: Scene, name: string, hex: string): StandardMaterial => {
  const m = new StandardMaterial(`machine/${name}`, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(0.15, 0.15, 0.15);
  return m;
};

export const buildMachine = (scene: Scene, shadows: ShadowGenerator, o: MachineOptions): Machine => {
  // The machine's own frame: u along the table away from the target, w across it, y up.
  const u = o.along.normalizeToNew();
  const w = Vector3.Cross(u, Vector3.Up()).normalize();
  const at = (pu: number, py: number, pw = 0): Vector3 => o.target.add(u.scale(pu)).add(w.scale(pw)).add(new Vector3(0, py, 0));
  /** A rotation that turns the box's x axis along u (and the rest with it), then tilts it by `pitch` about w, and turns by `yaw` on the table. */
  const yawOf = Math.atan2(-u.z, u.x);
  const turn = (pitch: number, yaw = 0): Quaternion => Quaternion.RotationYawPitchRoll(yawOf + yaw, 0, 0).multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), pitch));
  const root = new TransformNode("machine", scene);
  const wood = color(scene, "wood", "#d6a56b");
  const rail = color(scene, "rail", "#8b5e34");
  const metal = color(scene, "metal", "#64748b");
  const red = color(scene, "red", "#e11d48");
  const meshes: Mesh[] = [];
  const statics: PhysicsAggregate[] = [];
  const add = (mesh: Mesh, material: StandardMaterial): Mesh => {
    mesh.material = material;
    mesh.parent = root;
    mesh.isPickable = false;
    shadows.addShadowCaster(mesh);
    meshes.push(mesh);
    return mesh;
  };

  /** A static box from one point to another, `width` across and `thick` deep, with rails along both sides. */
  const ramp = (name: string, u0: number, y0: number, u1: number, y1: number, width = 0.56): void => {
    const length = Math.hypot(u1 - u0, y1 - y0);
    const pitch = Math.atan2(y1 - y0, u1 - u0);
    const thick = 0.06;
    const mid = at((u0 + u1) / 2, (y0 + y1) / 2 - thick / 2);
    const board = add(CreateBox(`machine/${name}`, { width: length, height: thick, depth: width }, scene), wood);
    board.position.copyFrom(mid);
    board.rotationQuaternion = turn(pitch);
    statics.push(new PhysicsAggregate(board, PhysicsShapeType.BOX, { mass: 0, friction: 0.4, restitution: 0.1 }, scene));
    for (const side of [-1, 1]) {
      const r = add(CreateBox(`machine/${name}/rail${side}`, { width: length, height: 0.14, depth: 0.04 }, scene), rail);
      r.position.copyFrom(mid.add(w.scale(side * (width / 2 + 0.02))).add(new Vector3(0, 0.06, 0)));
      r.rotationQuaternion = turn(pitch);
      statics.push(new PhysicsAggregate(r, PhysicsShapeType.BOX, { mass: 0, friction: 0.2, restitution: 0.1 }, scene));
    }
  };
  /** A post holding a ramp up, from the table to `y`. */
  const post = (pu: number, y: number, pw: number): void => {
    const p = add(CreateCylinder("machine/post", { height: y, diameter: 0.07 }, scene), metal);
    p.position.copyFrom(at(pu, y / 2, pw));
  };

  // The tower and the ramps: the ball starts at u = 9 m, 2.3 m up, and comes down to the table at u = 5.
  const TOP = { u: 9.0, y: 2.3 };
  const KNEE = { u: 7.4, y: 1.25 };
  const FOOT = { u: 5.0, y: 0.0 };
  ramp("ramp1", TOP.u + 0.3, TOP.y + 0.2, KNEE.u, KNEE.y);
  ramp("ramp2", KNEE.u, KNEE.y, FOOT.u, FOOT.y + 0.03);
  for (const pw of [-0.32, 0.32]) {
    post(TOP.u + 0.25, TOP.y + 0.1, pw);
    post(KNEE.u, KNEE.y - 0.03, pw);
  }
  // A back wall at the top, so the ball can only go one way.
  const wall = add(CreateBox("machine/wall", { width: 0.06, height: 0.5, depth: 0.6 }, scene), rail);
  wall.position.copyFrom(at(TOP.u + 0.33, TOP.y + 0.4));
  wall.rotationQuaternion = turn(0);
  statics.push(new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0 }, scene));

  // The dominoes: a curve on the table from the foot of the ramp toward the target, ending straight at it.
  const DOMINO = { width: 0.36, height: 0.62, thick: 0.08 };
  const path = (t: number): { u: number; w: number } => ({ u: FOOT.u - 0.6 - t * 3.0, w: 0.8 * Math.sin(t * Math.PI) ** 2 });
  const dominoes: { u: number; w: number; yaw: number }[] = [];
  // Even steps along the curve, about 0.27 m apart (under half a domino's height, so each one reaches the next).
  let last = path(0);
  dominoes.push({ ...last, yaw: 0 });
  for (let t = 0; t <= 1; t += 0.001) {
    const p = path(t);
    if (Math.hypot(p.u - last.u, p.w - last.w) >= 0.27) {
      dominoes.push({ ...p, yaw: 0 });
      last = p;
    }
  }
  // Each faces along the curve.
  for (let i = 0; i < dominoes.length; i++) {
    const a = dominoes[Math.max(0, i - 1)]!;
    const b = dominoes[Math.min(dominoes.length - 1, i + 1)]!;
    dominoes[i]!.yaw = Math.atan2(b.w - a.w, -(b.u - a.u));
  }
  const end = dominoes[dominoes.length - 1]!;
  // A low curb along the dominoes' outer side, to keep the first ball on the table once it has knocked them over.
  {
    const from = FOOT.u - 0.2;
    const to = end.u + 0.2;
    const curb = add(CreateBox("machine/curb", { width: from - to, height: 0.22, depth: 0.06 }, scene), rail);
    curb.position.copyFrom(at((from + to) / 2, 0.11, -0.5));
    curb.rotationQuaternion = turn(0);
    statics.push(new PhysicsAggregate(curb, PhysicsShapeType.BOX, { mass: 0, friction: 0.5, restitution: 0.05 }, scene));
  }
  // The second ball, just past the last domino, which pushes it the rest of the way.
  const BALL2 = { u: end.u - 0.42, w: end.w, r: 0.2 };

  // The moving parts, made again for every run so each starts from nothing.
  type Part = { mesh: Mesh; body: PhysicsAggregate; start: { p: Vector3; q: Quaternion } };
  let parts: Part[] = [];
  let gate: PhysicsAggregate | null = null;
  let gateMesh: Mesh | null = null;
  let ball2: Part | null = null;
  const palette = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2"];
  const dominoMaterials = dominoes.map((_, i) => color(scene, `domino${i}`, palette[i % palette.length]!));
  const ballOneMaterial = color(scene, "ball1", "#e11d48");
  const ballMaterial = color(scene, "ball", "#f59e0b");
  const make = (): void => {
    // Taken apart in the reverse of the order they were made: the engine hands freed bodies back last first, so the
    // next run's bodies get the same slots in the same order, and so are solved in the same order. Taken apart in
    // any other order, every second run comes out differently.
    gate?.dispose();
    gateMesh?.dispose();
    for (const p of [...parts].reverse()) {
      o.onPartGone?.(p.mesh);
      p.body.dispose();
      p.mesh.dispose();
    }
    parts = [];
    const dynamic = (mesh: Mesh, shape: PhysicsShapeType, mass: number, friction: number): Part => {
      // The moving parts can be picked up; the rest lets clicks through to the table under it.
      mesh.isPickable = true;
      const body = new PhysicsAggregate(mesh, shape, { mass, friction, restitution: 0.15 }, scene);
      const part = { mesh, body, start: { p: mesh.position.clone(), q: mesh.rotationQuaternion?.clone() ?? Quaternion.Identity() } };
      parts.push(part);
      o.onPart?.(mesh, body);
      return part;
    };
    const ball = add(CreateSphere("machine/ball", { diameter: 0.36, segments: 20 }, scene), ballOneMaterial);
    ball.position.copyFrom(at(TOP.u + 0.05, TOP.y + 0.24));
    ball.rotationQuaternion = Quaternion.Identity();
    dynamic(ball, PhysicsShapeType.SPHERE, 1.2, 0.5);
    dominoes.forEach((d, i) => {
      const m = add(CreateBox(`machine/domino${i}`, { width: DOMINO.thick, height: DOMINO.height, depth: DOMINO.width }, scene), dominoMaterials[i]!);
      m.position.copyFrom(at(d.u, DOMINO.height / 2 + 0.002, d.w));
      m.rotationQuaternion = turn(0, d.yaw);
      dynamic(m, PhysicsShapeType.BOX, 0.25, 0.6);
    });
    const b2 = add(CreateSphere("machine/ball2", { diameter: BALL2.r * 2, segments: 20 }, scene), ballMaterial);
    b2.position.copyFrom(at(BALL2.u, BALL2.r + 0.002, BALL2.w));
    b2.rotationQuaternion = Quaternion.Identity();
    ball2 = dynamic(b2, PhysicsShapeType.SPHERE, 0.5, 0.4);
    // The gate: a thin plate across the top ramp, in front of the ball.
    gateMesh = add(CreateBox("machine/gate", { width: 0.04, height: 0.4, depth: 0.6 }, scene), metal);
    gateMesh.position.copyFrom(at(TOP.u - 0.25, TOP.y + 0.08));
    gateMesh.rotationQuaternion = turn(0);
    gate = new PhysicsAggregate(gateMesh, PhysicsShapeType.BOX, { mass: 0 }, scene);
  };
  make();

  let running = false;
  let steps = 0;
  let arrived = false;
  const waits: { step: number; then: (s: Snapshot) => void }[] = [];
  const snapshot = (): Snapshot =>
    parts.map(({ mesh }) => {
      const p = mesh.position;
      const q = mesh.rotationQuaternion ?? Quaternion.Identity();
      return [p.x, p.y, p.z, q.x, q.y, q.z, q.w] as const;
    });
  scene.onAfterPhysicsObservable.add(() => {
    if (!running) return;
    steps++;
    for (let i = waits.length - 1; i >= 0; i--) {
      if (waits[i]!.step !== steps) continue;
      waits[i]!.then(snapshot());
      waits.splice(i, 1);
    }
    if (!arrived && ball2) {
      const p = ball2.mesh.position;
      if (Math.hypot(p.x - o.target.x, p.z - o.target.z) < 0.3) {
        arrived = true;
        o.onEvent?.(`The machine pressed its icon after ${(steps / STEPS_PER_SECOND).toFixed(2)} s`);
        o.onArrive();
      }
    }
    // A run ends some time after it arrived, or when it took too long.
    if (steps > STEPS_PER_SECOND * 30) running = false;
  });

  const reset = (): void => {
    running = false;
    steps = 0;
    arrived = false;
    make();
  };
  const run = (): void => {
    reset();
    running = true;
    // The gate drops away: the ball rolls.
    gate?.dispose();
    gate = null;
    gateMesh?.dispose();
    gateMesh = null;
    o.onEvent?.("The machine is running");
  };
  const center = at(4.5, 0.6);
  return {
    run,
    reset,
    get running() {
      return running;
    },
    get steps() {
      return steps;
    },
    snapshot,
    center,
    size: 10,
    after: (step, then) => waits.push({ step, then }),
    get meshes() {
      return meshes.filter((m) => !m.isDisposed());
    },
  };
};
