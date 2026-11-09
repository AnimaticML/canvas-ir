// The same Babylon / Havok / CanvasIR Surface stack as the existing 3D playground.
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Scene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";
import havokWasm from "@babylonjs/havok/lib/esm/HavokPhysics.wasm" with { type: "file" };
import { Surface, World } from "@canvas-ir/babylon";
import { Components, EventRouter } from "canvas-ir";
import { cross, length, sub, unit, type Intrinsics, type Pose, type V3 } from "./geometry";

const vector = (p: V3): Vector3 => new Vector3(...p);
export const rotationMatrix = (r: number[]): Matrix => Matrix.FromValues(r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, 0, 0, 0, 1);
export const smoothPose = (previous: Pose | null, next: Pose, dt: number, smoothing: number): Pose => {
  if (!previous || smoothing === 0) return next;
  // Short time constant at rest, fast response to motion. No averaging of screen corners.
  const motion = length(sub(next.t, previous.t));
  const tau = smoothing / (1 + motion * 100);
  const alpha = 1 - Math.exp(-Math.max(0.001, dt) / tau);
  const q = Quaternion.Slerp(Quaternion.FromRotationMatrix(rotationMatrix(previous.r)), Quaternion.FromRotationMatrix(rotationMatrix(next.r)), alpha);
  const m = Matrix.Identity(); q.toRotationMatrix(m);
  return { r: [m.m[0]!, m.m[4]!, m.m[8]!, m.m[1]!, m.m[5]!, m.m[9]!, m.m[2]!, m.m[6]!, m.m[10]!], t: previous.t.map((v, i) => v + alpha * (next.t[i]! - v)) as V3 };
};

export class ARScene {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  private world: World;
  private button;
  private buttonMat: StandardMaterial;
  private fingertip;
  private shadow;
  private objects: { mesh: ReturnType<typeof CreateBox>; physics: PhysicsAggregate; initial: V3 }[] = [];
  private held: { item: ARScene["objects"][number]; offset: Vector3; relative: Quaternion; target: Vector3; rotation: Quaternion } | null = null;
  private pinched = false;
  private pressed = false;
  private touchFrames = 0;
  private lastHand = 0;
  presses = 0;
  grabs = 0;
  releases = 0;
  rotations = 0;
  enabled = false;
  constructor(canvas: HTMLCanvasElement, plugin: HavokPlugin) {
    this.engine = new Engine(canvas, true, { alpha: true, preserveDrawingBuffer: true }, true);
    this.engine.setHardwareScalingLevel(1 / Math.min(devicePixelRatio, 2));
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
    this.camera = new FreeCamera("ar-camera", new Vector3(0, 0.65, -0.5), this.scene);
    this.camera.minZ = 0.01; this.camera.maxZ = 10;
    this.camera.setTarget(Vector3.Zero());
    new HemisphericLight("sky", new Vector3(0, 1, 0), this.scene);
    this.world = new World({ scene: this.scene, size: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }) });
    const table = CreateGround("tabletop", { width: 0.6, height: 0.4 }, this.scene);
    const material = new StandardMaterial("tabletop", this.scene);
    material.diffuseColor = Color3.FromHexString("#163c42"); material.alpha = 0.48;
    table.material = material;
    // The physical slab's upper face is exactly Y=0.
    const slab = CreateBox("table-collider", { width: 0.6, height: 0.02, depth: 0.4 }, this.scene);
    slab.position.y = -0.01; slab.isVisible = false;
    new PhysicsAggregate(slab, PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, this.scene);
    const label = CreateGround("canvas-ir-board", { width: 0.58, height: 0.38 }, this.scene);
    label.position.y = 0.0005;
    // Ground UVs put the drawing's top at +Z; our table's far edge is -Z.
    const uvs = label.getVerticesData(VertexBuffer.UVKind)!;
    label.setVerticesData(VertexBuffer.UVKind, uvs.map((v, i) => i % 2 ? 1 - v : v));
    label.material = new StandardMaterial("board-ink", this.scene);
    const surface = this.world.add(new Surface({ version: 1, ops: [] }, { mesh: label, width: 600, height: 400, background: null, sharp: false }));
    // StandardMaterial derives transparency from diffuse/opacity textures,
    // whereas Surface's unlit ink is attached as emissiveTexture.
    const ink = label.material as StandardMaterial;
    ink.diffuseTexture = surface.texture; ink.useAlphaFromDiffuseTexture = true;
    const ui = new Components(surface.scene, new EventRouter(this.world), { onChange: () => surface.invalidate() });
    ui.mount({ id: "ar-board", state: {}, draw: ctx => {
      ctx.strokeStyle = "rgba(112,233,218,0.45)"; ctx.lineWidth = 1;
      for (let x = 0; x <= 600; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 400); ctx.stroke(); }
      for (let y = 0; y <= 400; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(600, y); ctx.stroke(); }
      ctx.strokeStyle = "#7aeee0"; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 594, 394);
      ctx.fillStyle = "#b6fff4"; ctx.font = "600 18px system-ui"; ctx.fillText("CANVAS IR / AR LAB", 20, 34);
      ctx.font = "14px system-ui"; ctx.fillText("60 × 40 cm  ·  5 cm grid", 20, 375);
    } });
    this.button = CreateBox("touch-button", { width: 0.085, height: 0.008, depth: 0.085 }, this.scene);
    this.button.position.set(-0.13, 0.004, 0.06);
    this.buttonMat = new StandardMaterial("button-mat", this.scene); this.button.material = this.buttonMat;
    this.buttonMat.diffuseColor = Color3.FromHexString("#19d3b0");
    for (const [i, p] of ([[0.06, 0.03, 0.06], [0.16, 0.012, -0.07]] as V3[]).entries()) {
      const mesh = CreateBox(i === 0 ? "cube" : "card", i === 0 ? { size: 0.05 } : { width: 0.08, height: 0.008, depth: 0.055 }, this.scene);
      mesh.position.copyFrom(vector(p)); mesh.rotationQuaternion = Quaternion.Identity();
      const mat = new StandardMaterial(`object-${i}`, this.scene); mat.diffuseColor = Color3.FromHexString(i === 0 ? "#ffb36b" : "#a59bff"); mesh.material = mat;
      const physics = new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0.06, friction: 0.65, restitution: 0.12 }, this.scene);
      this.objects.push({ mesh, physics, initial: p });
    }
    this.fingertip = CreateSphere("index-tip", { diameter: 0.012 }, this.scene);
    const tipMat = new StandardMaterial("tip", this.scene); tipMat.emissiveColor = Color3.FromHexString("#ff7594"); this.fingertip.material = tipMat;
    this.shadow = CreateSphere("tip-on-table", { diameter: 0.016 }, this.scene); this.shadow.scaling.y = 0.08; this.shadow.material = this.buttonMat;
    this.fingertip.isVisible = this.shadow.isVisible = false;
    this.scene.onBeforePhysicsObservable.add(() => {
      // Havok derives velocity from a target transform. Refresh it on every
      // physics step, including between the lower-frequency camera samples.
      if (this.held) this.held.item.physics.body.setTargetTransform(this.held.target, this.held.rotation);
    });
    this.engine.runRenderLoop(() => {
      if (performance.now() - this.lastHand > 250) this.loseHand();
      for (const item of this.objects) if (item !== this.held?.item && item.mesh.position.y < -0.4) this.restore(item);
      if (this.enabled) { this.world.draw(); this.scene.render(); }
    });
  }
  static async create(canvas: HTMLCanvasElement): Promise<ARScene> {
    const hk = await HavokPhysics({ locateFile: () => havokWasm });
    return new ARScene(canvas, new HavokPlugin(true, hk));
  }
  resize(): void { this.engine.resize(); }
  pose(p: Pose, k: Intrinsics): void {
    const r = p.r, t = p.t;
    // OpenCV → a right-handed Babylon camera: flip camera Y and Z, never the table.
    const view = Matrix.FromValues(r[0]!, -r[3]!, -r[6]!, 0, r[1]!, -r[4]!, -r[7]!, 0, r[2]!, -r[5]!, -r[8]!, 0, t[0], -t[1], -t[2], 1);
    const cameraWorld = view.clone().invert();
    this.camera.position.copyFrom(cameraWorld.getTranslation());
    this.camera.rotationQuaternion = Quaternion.FromRotationMatrix(cameraWorld);
    const near = 0.01, far = 10;
    this.camera.freezeProjectionMatrix(Matrix.FromValues(2 * k.fx / k.width, 0, 0, 0, 0, 2 * k.fy / k.height, 0, 0,
      1 - 2 * k.cx / k.width, 2 * k.cy / k.height - 1, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0));
    this.enabled = true;
  }
  hide(): void {
    this.enabled = false; this.loseHand(true);
    // Clear stale objects when the camera or all markers disappear.
    this.engine.clear(new Color4(0, 0, 0, 0), true, true, true);
  }
  hand(points: V3[], allow3D: boolean, now: number): void {
    this.lastHand = now;
    const tip = points[8]!, thumb = points[4]!;
    this.fingertip.position.copyFrom(vector(tip)); this.fingertip.isVisible = true;
    this.shadow.position.set(tip[0], 0.001, tip[2]); this.shadow.isVisible = true;
    const atButton = Math.abs(tip[0] + 0.13) < 0.046 && Math.abs(tip[2] - 0.06) < 0.046;
    const contact = allow3D && atButton && tip[1] > -0.018 && tip[1] < (this.pressed ? 0.025 : 0.014);
    this.touchFrames = contact ? this.touchFrames + 1 : 0;
    if (!this.pressed && this.touchFrames >= 2) { this.pressed = true; this.presses++; }
    if (!contact) this.pressed = false;
    this.button.scaling.y = this.pressed ? 0.35 : 1;
    this.buttonMat.emissiveColor = this.pressed ? new Color3(0.2, 0.7, 0.4) : Color3.Black();
    if (!allow3D) { this.release(); this.pinched = false; return; }
    const gap = length(sub(tip, thumb));
    const pinching = gap < (this.pinched ? 0.040 : 0.025);
    const midpoint = vector([(tip[0] + thumb[0]) / 2, (tip[1] + thumb[1]) / 2, (tip[2] + thumb[2]) / 2]);
    const x = unit(sub(points[5]!, points[17]!)), forward = unit(sub(points[9]!, points[0]!));
    const z = unit(cross(x, forward)), y = unit(cross(z, x));
    if (length(cross(x, forward)) < 0.2) return;
    const orientation = Quaternion.RotationQuaternionFromAxis(vector(x), vector(y), vector(z));
    if (pinching && !this.pinched && !this.held) {
      const item = this.objects.filter(o => Vector3.Distance(midpoint, o.mesh.position) < (o.mesh.name === "card" ? 0.065 : 0.055))
        .sort((a, b) => Vector3.DistanceSquared(midpoint, a.mesh.position) - Vector3.DistanceSquared(midpoint, b.mesh.position))[0];
      if (item) {
        item.physics.body.setMotionType(PhysicsMotionType.ANIMATED);
        this.held = { item, offset: item.mesh.position.subtract(midpoint).applyRotationQuaternion(orientation.conjugate()), relative: orientation.conjugate().multiply(item.mesh.rotationQuaternion!), target: item.mesh.position.clone(), rotation: item.mesh.rotationQuaternion!.clone() };
        this.grabs++;
      }
    }
    if (pinching && this.held) {
      const { item, offset, relative } = this.held;
      const rotation = orientation.multiply(relative);
      const target = midpoint.add(offset.applyRotationQuaternion(orientation));
      target.y = Math.max(0.015, target.y);
      this.held.target = target; this.held.rotation = rotation;
      if (Math.abs(Quaternion.Dot(item.mesh.rotationQuaternion!, rotation)) < 0.997) this.rotations++;
    }
    if (!pinching) this.release();
    this.pinched = pinching;
  }
  loseHand(immediate = false): void {
    this.fingertip.isVisible = this.shadow.isVisible = false;
    this.pressed = false; this.touchFrames = 0; this.button.scaling.y = 1; this.buttonMat.emissiveColor = Color3.Black();
    if (immediate || performance.now() - this.lastHand > 600) { this.release(); this.pinched = false; }
  }
  private release(): void {
    if (!this.held) return;
    const body = this.held.item.physics.body;
    body.setMotionType(PhysicsMotionType.DYNAMIC); body.setLinearVelocity(Vector3.Zero()); body.setAngularVelocity(Vector3.Zero());
    this.held = null; this.releases++;
  }
  private restore(item: ARScene["objects"][number]): void {
    item.physics.body.disablePreStep = false;
    item.mesh.position.copyFrom(vector(item.initial)); item.mesh.rotationQuaternion = Quaternion.Identity();
    item.physics.body.setLinearVelocity(Vector3.Zero()); item.physics.body.setAngularVelocity(Vector3.Zero());
    this.scene.onAfterPhysicsObservable.addOnce(() => { item.physics.body.disablePreStep = true; });
  }
  resetObjects(): void { this.release(); for (const item of this.objects) this.restore(item); }
  get holding(): string { return this.held?.item.mesh.name ?? "—"; }
  dispose(): void { this.scene.dispose(); this.engine.dispose(); }
}
