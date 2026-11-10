// Hands on the board in 3D. Whatever tracks them (a camera and MediaPipe in AR, a replayed recording in a test) hands in
// the 21 joints of each hand in the room's coordinates every frame, and this decides what a hand does there, so the
// tracking never has to reach into the board:
//
// - A fingertip that touches a surface (the table, a tablet's face, the panel) presses it where it touches, and lifting it
//   lets go: a press found by contact in 3D, not by a ray from the camera. It hovers when it's above one.
// - A pinch (thumb and index meeting) next to a crate or a ball takes hold of it; the thing follows the pinch and is
//   thrown with the hand's speed when the pinch opens.
// - A pinch anywhere else presses where it points from the camera, as a finger on a touch screen does: it clicks, drags,
//   and pinched twice quickly double-clicks (to lift or lay down a tablet). Two pinching hands are two fingers, so they
//   carry and turn a tablet by its title bar, zoom its face, and slide, zoom and turn the view.
// - The open hand is solid: its fingertips and palm are bodies in the physics that push the crates and balls around.
// - A hand that's gone lets go of whatever it was doing.
//
// The joints are MediaPipe's: 0 the wrist, 4 the thumb's tip, 5 and 17 the knuckles across the palm, 8 the index tip.
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { Scene as BabylonScene } from "@babylonjs/core/scene";

export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_KNUCKLE = 5;
export const INDEX_TIP = 8;
export const MIDDLE_KNUCKLE = 9;
export const PINKY_KNUCKLE = 17;

/** One tracked hand in one frame: a lasting id (the same hand keeps it while it's seen) and its 21 joints in the room. */
export interface HandFrame {
  readonly id: string;
  readonly joints: readonly Vector3[];
  /** How closed the pinch is (thumb to index over the palm's width), when the tracker measures it better than the joints say. */
  readonly pinch?: number;
}

/** A flat thing a fingertip can touch: a point on it, its normal (the side a finger comes from), and whether a point on its plane is on it. */
export interface HandSurface {
  readonly id: string;
  readonly point: Vector3;
  readonly normal: Vector3;
  contains(at: Vector3, margin: number): boolean;
}

/** Surface dimensions are in mesh-local units; the edge tolerance is in room units. */
export const meshHandSurface = (id: string, mesh: AbstractMesh, width: number, height: number, axis: "y" | "z"): HandSurface => {
  const m = mesh.computeWorldMatrix(true).clone(), inverse = m.clone().invert();
  const sx = Vector3.TransformNormal(Vector3.Right(), m).length();
  const sv = Vector3.TransformNormal(axis === "y" ? Vector3.Forward() : Vector3.Up(), m).length();
  return {
    id, point: m.getTranslation(),
    normal: Vector3.TransformNormal(axis === "y" ? Vector3.Up() : new Vector3(0, 0, -1), m).normalize(),
    contains: (at, margin) => {
      const local = Vector3.TransformCoordinates(at, inverse);
      return Math.abs(local.x) <= width / 2 + margin / sx && Math.abs(axis === "y" ? local.z : local.y) <= height / 2 + margin / sv;
    },
  };
};

/** A proper room-space palm rotation. Degenerate/noisy palms retain the last orientation. */
export const handOrientation = (j: readonly Vector3[]): Quaternion | null => {
  const x = j[INDEX_KNUCKLE]!.subtract(j[PINKY_KNUCKLE]!);
  const forward = j[MIDDLE_KNUCKLE]!.subtract(j[WRIST]!);
  const z = Vector3.Cross(x, forward);
  if (x.lengthSquared() < 1e-10 || z.lengthSquared() < 1e-12) return null;
  x.normalize(); z.normalize();
  return Quaternion.RotationQuaternionFromAxis(x, Vector3.Cross(z, x).normalize(), z);
};

export interface HandContact {
  time: number; handId: string; part: string; target: string; impulse: number;
  position: Vector3; velocity: Vector3; point: Vector3 | null;
}

/** What the board gives the hands. */
export interface HandHost {
  readonly scene: BabylonScene;
  /** The things a hand can push and hold. */
  things(): Iterable<{ readonly id: string; readonly mesh: AbstractMesh }>;
  /** What a fingertip can touch, nearest first when they overlap. */
  surfaces(): HandSurface[];
  /** Presses, moves, lifts or cancels a pointer at a room point: it goes where that point is seen from the camera. `buttons` 0 hovers. */
  press(phase: "down" | "move" | "up" | "cancel", at: Vector3, pointer: number, time: number, buttons: number): void;
  /** Holds a thing at a room point, pulled there each frame, or lets it go (`id` null), thrown with the speed it has. */
  hold(pointer: number, id: string | null, at?: Vector3, orientation?: Quaternion): void;
}

export interface HandOptions {
  /** How many meters one room unit is: the distances below are in meters. */
  metersPerUnit: number;
  /** A pinch closes below this ratio of thumb-to-index over palm width, and opens again above `pinchOff`. */
  pinchOn: number;
  pinchOff: number;
  /** A fingertip presses a surface nearer than this, in meters, and lets go farther than `releaseAt`. */
  pressAt: number;
  releaseAt: number;
  /** How far past a surface's edge a pressed fingertip still counts as on it, in meters. */
  edge: number;
  /** How near a pinch must be to a thing to take hold of it, in meters. */
  reach: number;
  /** Whether a touching fingertip presses where it touches (`"contact"`), or where the camera sees it on the surface (`"ray"`), which hides depth errors along the camera's line of sight. */
  route: "contact" | "ray";
  /** Whether fingertips press surfaces at all, and whether the open hand pushes things. */
  touch: boolean;
  solid: boolean;
}

export const HAND_DEFAULTS: HandOptions = {
  metersPerUnit: 1,
  pinchOn: 0.3,
  pinchOff: 0.48,
  pressAt: 0.012,
  releaseAt: 0.025,
  edge: 0.02,
  reach: 0.035,
  route: "ray",
  touch: true,
  solid: true,
};

/** What one hand is doing, for a status line or a test. */
export interface HandState {
  readonly id: string;
  readonly action: "hover" | "touch" | "pinch" | "hold" | "idle";
  /** The surface touched, the thing held, or null. */
  readonly target: string | null;
  /** How far the fingertip is from the nearest surface it's over, in meters, or null over none. */
  readonly gap: number | null;
  readonly pinch: number;
}

const dist = (a: Vector3, b: Vector3): number => Vector3.Distance(a, b);

/** The bodies that make an open hand solid: index and thumb tips and the palm. */
const SOLID = [
  { name: "index", joint: INDEX_TIP, radius: 0.009 },
  { name: "thumb", joint: THUMB_TIP, radius: 0.01 },
  { name: "palm", joint: -1, radius: 0.03 },
] as const;

class Hand {
  pinched = false;
  /** The pointer a pinch presses with, while it's down. */
  pinchDown = false;
  holding: string | null = null;
  orientation: Quaternion | null = null;
  /** The surface the fingertip is pressing, and where. */
  touching: { surface: string; at: Vector3 } | null = null;
  hovering = false;
  /** Where the pinch was last seen. */
  mid = Vector3.Zero();
  bodies: { mesh: Mesh; body: PhysicsAggregate; on: boolean }[] = [];
  state: HandState;
  constructor(
    readonly id: string,
    /** Pointer ids: the pinch's, and the fingertip's. */
    readonly pointers: [number, number],
  ) {
    this.state = { id, action: "idle", target: null, gap: null, pinch: 1 };
  }
}

export class Hands {
  options: HandOptions;
  private readonly hands = new Map<string, Hand>();
  private nextPointer = 1000;
  /** Bounded real Havok contacts, in room coordinates, for diagnostics. */
  readonly contacts: HandContact[] = [];

  constructor(
    private readonly host: HandHost,
    options: Partial<HandOptions> = {},
  ) {
    this.options = { ...HAND_DEFAULTS, ...options };
  }

  /** What each hand seen is doing. */
  get states(): HandState[] {
    return [...this.hands.values()].map((h) => h.state);
  }

  configure(options: Partial<HandOptions>): void {
    this.options = { ...this.options, ...options };
    for (const h of this.hands.values()) this.makeBodies(h);
  }

  /** Takes this frame's hands; a hand not among them is gone and lets go. `time` is in milliseconds, for double pinches. */
  update(frames: readonly HandFrame[], time = performance.now()): HandState[] {
    const seen = new Set<string>();
    for (const f of frames) {
      if (f.joints.length < 21) continue;
      seen.add(f.id);
      let hand = this.hands.get(f.id);
      if (!hand) {
        hand = new Hand(f.id, [this.nextPointer++, this.nextPointer++]);
        this.hands.set(f.id, hand);
        this.makeBodies(hand);
      }
      this.step(hand, f, time);
    }
    for (const [id, hand] of this.hands) if (!seen.has(id)) this.lose(hand, time);
    return this.states;
  }

  /** Lets go of everything, as if every hand left. */
  clear(time = performance.now()): void {
    for (const hand of [...this.hands.values()]) this.lose(hand, time);
  }

  private units(meters: number): number {
    return meters / this.options.metersPerUnit;
  }

  private step(hand: Hand, f: HandFrame, time: number): void {
    const o = this.options;
    const j = f.joints;
    const tip = j[INDEX_TIP]!;
    const thumb = j[THUMB_TIP]!;
    const palmWidth = Math.max(this.units(0.035), dist(j[INDEX_KNUCKLE]!, j[PINKY_KNUCKLE]!));
    const ratio = f.pinch ?? dist(tip, thumb) / palmWidth;
    const pinching = ratio < (hand.pinched ? o.pinchOff : o.pinchOn);
    const mid = tip.add(thumb).scaleInPlace(0.5);
    hand.mid = mid;
    const [pinchPointer, tipPointer] = hand.pointers;

    if (pinching) {
      this.solid(hand, null);
      if (hand.touching) this.lift(hand, time, true);
      hand.orientation = handOrientation(j) ?? hand.orientation;
      if (hand.holding && ![...this.host.things()].some(t => t.id === hand.holding)) {
        this.host.hold(pinchPointer, null); hand.holding = null;
      }
      // A closed pinch may enter the grab zone later. Cancel any prior pointer
      // drag before promoting it to a physical hold; never send a stray click.
      if (!hand.holding) {
        const near = this.nearest(mid, hand);
        if (near && near.gap <= this.units(o.reach)) {
          if (hand.pinchDown) this.host.press("cancel", mid, pinchPointer, time, 0);
          hand.pinchDown = false; hand.holding = near.id;
        }
      }
      if (hand.holding) this.host.hold(pinchPointer, hand.holding, mid, hand.orientation ?? undefined);
      else if (!hand.pinched) {
        this.host.press("down", mid, pinchPointer, time, 1); hand.pinchDown = true;
      } else if (hand.pinchDown) this.host.press("move", mid, pinchPointer, time, 1);
      hand.pinched = true;
      hand.state = { id: hand.id, action: hand.holding ? "hold" : "pinch", target: hand.holding, gap: null, pinch: ratio };
      return;
    }

    // Open.
    if (hand.pinched) {
      if (hand.holding) this.host.hold(pinchPointer, null);
      if (hand.pinchDown) this.host.press("up", mid, pinchPointer, time, 0);
      hand.holding = null;
      hand.pinchDown = false;
      hand.pinched = false;
    }
    this.solid(hand, j);
    if (!o.touch) {
      hand.state = { id: hand.id, action: "idle", target: null, gap: null, pinch: ratio };
      return;
    }
    // A solid fingertip touching an actor must not also click a panel behind it.
    const actor = this.nearest(tip, hand);
    if (o.solid && actor && actor.gap <= this.units(SOLID[0].radius)) {
      this.lift(hand, time, true);
      const contact = [...this.contacts].reverse().find(c => c.handId === hand.id && c.target === actor.id && performance.now() - c.time < 350);
      hand.state = { id: hand.id, action: contact ? "touch" : "hover", target: actor.id, gap: actor.gap * o.metersPerUnit, pinch: ratio };
      return;
    }
    // The fingertip against the surfaces: pressing one it touches, hovering one it's over.
    const over = this.over(tip, hand.touching?.surface ?? null);
    if (hand.touching && (!over || over.surface.id !== hand.touching.surface || over.gap > this.units(o.releaseAt))) this.lift(hand, time, false);
    if (over && !hand.touching && over.gap <= this.units(o.pressAt)) {
      const at = this.route(tip, over.surface);
      hand.touching = { surface: over.surface.id, at };
      hand.hovering = false;
      this.host.press("down", at, tipPointer, time, 1);
    } else if (hand.touching && over) {
      const at = this.route(tip, over.surface);
      hand.touching.at = at;
      this.host.press("move", at, tipPointer, time, 1);
    } else if (over) {
      // Hovering: what's under the fingertip lights up as under a mouse.
      hand.hovering = true;
      this.host.press("move", this.route(tip, over.surface), tipPointer, time, 0);
    } else hand.hovering = false;
    hand.state = {
      id: hand.id,
      action: hand.touching ? "touch" : over ? "hover" : "idle",
      target: hand.touching?.surface ?? over?.surface.id ?? null,
      gap: over ? over.gap * o.metersPerUnit : null,
      pinch: ratio,
    };
  }

  /** The surface a fingertip is over and how far above it (negative: pushed into it), the one it's pressing kept while it can. */
  private over(tip: Vector3, pressing: string | null): { surface: HandSurface; gap: number } | null {
    let best: { surface: HandSurface; gap: number } | null = null;
    const edge = this.units(this.options.edge);
    for (const s of this.host.surfaces()) {
      const gap = Vector3.Dot(tip.subtract(s.point), s.normal);
      // In front of it, not far behind it (a finger pushed into the table), and over it.
      if (gap > this.units(0.15) || gap < -this.units(0.04)) continue;
      const on = tip.subtract(s.normal.scale(gap));
      if (!s.contains(on, s.id === pressing ? edge : 0)) continue;
      if (s.id === pressing) return { surface: s, gap };
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { surface: s, gap };
    }
    return best;
  }

  /** Where a touching fingertip presses: straight down onto the surface, or where the camera's ray through it meets it. */
  private route(tip: Vector3, s: HandSurface): Vector3 {
    if (this.options.route === "ray") return tip.clone();
    return tip.subtract(s.normal.scale(Vector3.Dot(tip.subtract(s.point), s.normal)));
  }

  private lift(hand: Hand, time: number, cancel: boolean): void {
    if (!hand.touching) return;
    this.host.press(cancel ? "cancel" : "up", hand.touching.at, hand.pointers[1], time, 0);
    hand.touching = null;
  }

  /** The thing nearest a point, by the gap to its box. */
  private nearest(at: Vector3, hand: Hand): { id: string; gap: number } | null {
    let best: { id: string; gap: number } | null = null;
    for (const t of this.host.things()) {
      if ([...this.hands.values()].some(h => h !== hand && h.holding === t.id)) continue;
      t.mesh.computeWorldMatrix(true);
      const box = t.mesh.getBoundingInfo().boundingBox;
      const gap = dist(at, Vector3.Clamp(at, box.minimumWorld, box.maximumWorld));
      if (!best || gap < best.gap) best = { id: t.id, gap };
    }
    return best;
  }

  private makeBodies(hand: Hand): void {
    for (const b of hand.bodies) {
      b.body.dispose();
      b.mesh.dispose();
    }
    hand.bodies = [];
    if (!this.options.solid || !this.host.scene.getPhysicsEngine()) return;
    for (const s of SOLID) {
      const mesh = CreateSphere(`hand/${hand.id}/${s.name}`, { diameter: 2 * this.units(s.radius) }, this.host.scene);
      mesh.isVisible = false;
      mesh.isPickable = false;
      const body = new PhysicsAggregate(mesh, PhysicsShapeType.SPHERE, { mass: 0, friction: 0.6, restitution: 0 }, this.host.scene);
      body.body.setMotionType(PhysicsMotionType.ANIMATED);
      body.shape.filterCollideMask = 0;
      hand.bodies.push({ mesh, body, on: false });
      body.body.setCollisionCallbackEnabled(true);
      body.body.getCollisionObservable().add(event => {
        const other = event.collider === body.body ? event.collidedAgainst : event.collider;
        const actor = [...this.host.things()].find(t => t.mesh === other.transformNode);
        if (!actor) return;
        this.contacts.push({ time: performance.now(), handId: hand.id, part: s.name, target: actor.id, impulse: event.impulse,
          position: actor.mesh.getAbsolutePosition().clone(), velocity: other.getLinearVelocity().clone(), point: event.point?.clone() ?? null });
        if (this.contacts.length > 60) this.contacts.shift();
      });
    }
  }

  /** Moves the open hand's bodies to its joints, or (joints null) takes them out of the way. A body that comes back jumps there before it collides. */
  private solid(hand: Hand, joints: readonly Vector3[] | null): void {
    SOLID.forEach((s, i) => {
      const b = hand.bodies[i];
      if (!b) return;
      if (!joints) {
        if (b.on) {
          b.body.shape.filterCollideMask = 0;
          b.body.body.setLinearVelocity(Vector3.Zero());
          b.on = false;
        }
        return;
      }
      const at =
        s.joint >= 0 ? joints[s.joint]!.clone() : joints[WRIST]!.add(joints[INDEX_KNUCKLE]!).add(joints[PINKY_KNUCKLE]!).add(joints[MIDDLE_KNUCKLE]!).scaleInPlace(0.25);
      // Never below the table, so a noisy fingertip doesn't push things through it.
      at.y = Math.max(at.y, this.units(s.radius));
      if (!b.on) {
        b.mesh.position.copyFrom(at);
        b.body.body.disablePreStep = false;
        this.host.scene.onAfterPhysicsObservable.addOnce(() => {
          if (b.mesh.isDisposed()) return;
          b.body.body.disablePreStep = true;
          if (!b.mesh.isDisposed() && b.on) b.body.shape.filterCollideMask = 0xffffffff;
        });
        b.on = true;
        return;
      }
      b.body.body.setTargetTransform(at, b.mesh.rotationQuaternion ?? b.mesh.rotation.toQuaternion());
    });
  }

  private lose(hand: Hand, time: number): void {
    this.lift(hand, time, true);
    if (hand.holding) this.host.hold(hand.pointers[0], null);
    if (hand.pinchDown) this.host.press("cancel", hand.mid, hand.pointers[0], time, 0);
    this.solid(hand, null);
    for (const b of hand.bodies) {
      b.body.dispose();
      b.mesh.dispose();
    }
    this.hands.delete(hand.id);
  }
}
