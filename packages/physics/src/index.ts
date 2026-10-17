// 2D physics for drawings on a CanvasIR scene. planck.js (a port of Box2D)
// simulates; each body is a group on the board, moved with a live transform,
// so nothing is recorded again while it falls, bounces and turns. Colliders
// are read off what was drawn: a box, a circle, a convex hull, or the outline
// itself for the ground.
import { IDENTITY, type Matrix2D, type Point, type Scene, invert, multiply } from "canvas-ir";
import { Box, Chain, Circle, MouseJoint, Polygon, Settings, type Body, type Fixture, type Shape, World } from "planck";

export type ColliderKind = "box" | "circle" | "hull" | "outline";

export interface BodyOptions {
  /** `dynamic` bodies fall and collide, `static` ones stay put, `kinematic` ones move only as told. Default dynamic. */
  readonly type?: "dynamic" | "static" | "kinematic";
  /**
   * How the collider is read off the drawing: its bounding `box`, the `circle`
   * that fits it, the convex `hull` of what was painted (up to 8 corners), or
   * its `outline`, the painted rings as chains, for static ground of any shape.
   * Default box.
   */
  readonly collider?: ColliderKind;
  /** Mass per square meter. Default 1. */
  readonly density?: number;
  /** Default 0.4. */
  readonly friction?: number;
  /** Bounciness, 0 to 1. Default 0.1. */
  readonly restitution?: number;
  readonly linearDamping?: number;
  readonly angularDamping?: number;
  readonly fixedRotation?: boolean;
  /** Checked for tunneling against other dynamic bodies, for fast small things. */
  readonly bullet?: boolean;
  /** Starts moving at this velocity, in pixels per second. */
  readonly velocity?: Point;
  /** Detects contact but doesn't collide, as a pickup or a finish line does. */
  readonly sensor?: boolean;
}

export interface PhysicsOptions {
  /** Pixels per second squared. Default (0, 980): one meter is `scale` pixels, at Earth's gravity. */
  readonly gravity?: Point;
  /** Pixels per meter, so Box2D works at the sizes it is tuned for. Default 50. */
  readonly scale?: number;
  /** The fixed time step, in seconds. Default 1/60. */
  readonly step?: number;
}

/** Two bodies that began touching, by the ids of their groups. */
export interface Contact {
  readonly a: string;
  readonly b: string;
}

interface Entry {
  readonly id: string;
  readonly body: Body;
  /** Where the body's origin was in the drawing, in pixels: the live transform puts this point where the body is. */
  readonly origin: Point;
}

const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** The convex hull of points, counterclockwise in a y-up sense (Andrew's monotone chain). */
export const convexHull = (points: readonly Point[]): Point[] => {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (sorted.length < 3) return sorted;
  const half = (list: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
};

/** Drops the corner that adds least area until `max` are left, so a hull fits Box2D's polygon limit. */
export const reduceHull = (hull: readonly Point[], max: number): Point[] => {
  const out = [...hull];
  while (out.length > max) {
    let worst = 0;
    let least = Infinity;
    for (let i = 0; i < out.length; i++) {
      const area = Math.abs(cross(out[(i + out.length - 1) % out.length]!, out[i]!, out[(i + 1) % out.length]!));
      if (area < least) {
        least = area;
        worst = i;
      }
    }
    out.splice(worst, 1);
  }
  return out;
};

/**
 * A physics world over a scene. `add` turns a group into a body; `step`
 * advances the simulation by fixed steps and moves each awake body's group
 * to where its body is. Bodies at rest cost nothing.
 */
export class Physics {
  readonly world: World;
  readonly scale: number;
  private readonly dt: number;
  private carry = 0;
  private readonly entries = new Map<string, Entry>();
  /** What each body's group was under before it got a body: the body's motion composes onto it. */
  private readonly base = new Map<string, Matrix2D>();
  private readonly contacts: Contact[] = [];
  private readonly listeners = new Set<(contact: Contact) => void>();
  private grabbed: { joint: MouseJoint; id: string } | null = null;
  private readonly anchor: Body;

  constructor(
    private _scene: Scene,
    options: PhysicsOptions = {},
  ) {
    this.scale = options.scale ?? 50;
    this.dt = options.step ?? 1 / 60;
    const g = options.gravity ?? { x: 0, y: 980 };
    this.world = new World({ gravity: { x: g.x / this.scale, y: g.y / this.scale } });
    this.anchor = this.world.createBody();
    this.world.on("begin-contact", (contact) => {
      const a = this.idOf(contact.getFixtureA().getBody());
      const b = this.idOf(contact.getFixtureB().getBody());
      if (a !== undefined && b !== undefined) this.contacts.push({ a, b });
    });
  }

  get scene(): Scene {
    return this._scene;
  }

  /**
   * Moves the bodies over to another scene holding the same groups as drawn
   * now, such as the board replayed into a new scene: each body carries on
   * from where it is.
   */
  rebind(scene: Scene): void {
    for (const entry of this.entries.values()) {
      // The new scene's drawing is the old one under the body's motion so far; undo that motion first.
      const motion = this.motionOf(entry);
      this.base.set(entry.id, multiply(invert(motion) ?? IDENTITY, scene.transformOf(entry.id)));
    }
    this._scene = scene;
  }

  /** The group a body moves. */
  idOf(body: Body): string | undefined {
    const data = body.getUserData();
    return typeof data === "string" ? data : undefined;
  }

  body(id: string): Body | undefined {
    return this.entries.get(id)?.body;
  }

  get bodies(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** Calls `listener` when two bodies begin touching, after the step it happened in. */
  onContact(listener: (contact: Contact) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Makes a group (or a single op) a body, with a collider read off its
   * drawing as it is now. The body starts where the drawing is.
   */
  add(id: string, options: BodyOptions = {}): Body {
    if (this.entries.has(id)) throw new Error(`${id} already has a body`);
    const scene = this._scene;
    const box = scene.bounds(id, "paint");
    if (!box) throw new Error(`${id} paints nothing to collide with`);
    const s = this.scale;
    const kind = options.collider ?? "box";
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const local = (p: Point): Point => ({ x: (p.x - origin.x) / s, y: (p.y - origin.y) / s });
    const shapes: Shape[] = [];
    // Box2D keeps a thin skin around polygons; boxes shrink by it so drawings touch where they meet.
    const skin = Settings.polygonRadius;
    if (kind === "box") shapes.push(new Box(Math.max(skin, box.width / 2 / s - skin), Math.max(skin, box.height / 2 / s - skin)));
    else if (kind === "circle") shapes.push(new Circle(Math.max(box.width, box.height) / 2 / s));
    else {
      // Ground follows the filled areas only: a stroke's box (grass along a hilltop, say) would be a wall.
      const rings = this.rings(id, kind === "hull");
      if (kind === "hull") {
        const hull = reduceHull(convexHull(rings.flat()), 8);
        shapes.push(hull.length >= 3 ? new Polygon(hull.map(local)) : new Box(box.width / 2 / s, box.height / 2 / s));
      } else {
        for (const ring of rings) if (ring.length >= 3) shapes.push(new Chain(ring.map(local), true));
      }
    }
    const type = options.type ?? (kind === "outline" ? "static" : "dynamic");
    const body = this.world.createBody({
      type,
      position: { x: origin.x / s, y: origin.y / s },
      ...(options.linearDamping !== undefined ? { linearDamping: options.linearDamping } : {}),
      ...(options.angularDamping !== undefined ? { angularDamping: options.angularDamping } : {}),
      ...(options.fixedRotation !== undefined ? { fixedRotation: options.fixedRotation } : {}),
      ...(options.bullet !== undefined ? { bullet: options.bullet } : {}),
      ...(options.velocity ? { linearVelocity: { x: options.velocity.x / s, y: options.velocity.y / s } } : {}),
    });
    for (const shape of shapes) {
      body.createFixture(shape, {
        density: options.density ?? 1,
        friction: options.friction ?? 0.4,
        restitution: options.restitution ?? 0.1,
        isSensor: options.sensor ?? false,
      });
    }
    body.setUserData(id);
    // The drawing as it is now, under any live transform it already has, is where the body starts.
    this.entries.set(id, { id, body, origin: { x: origin.x, y: origin.y } });
    this.base.set(id, scene.transformOf(id));
    return body;
  }

  /**
   * Moves a group with a body made directly with planck (a bicycle's frame on
   * wheel joints, say). `origin` is the point of the drawing, as it is now,
   * that sits at the body's position when the body has not turned. Default:
   * the body's position.
   */
  attach(id: string, body: Body, origin?: Point): void {
    if (this.entries.has(id)) throw new Error(`${id} already has a body`);
    const p = body.getPosition();
    const at = origin ?? { x: p.x * this.scale, y: p.y * this.scale };
    body.setUserData(id);
    this.entries.set(id, { id, body, origin: at });
    this.base.set(id, this._scene.transformOf(id));
  }

  /** Pixels to meters, for making bodies directly with planck. */
  meters(p: Point): { x: number; y: number } {
    return { x: p.x / this.scale, y: p.y / this.scale };
  }

  /** The painted rings of a group's ops, in world space: fills' outlines, and with `boxes` the boxes of strokes too; boxes alone if there is nothing else. */
  private rings(id: string, boxes: boolean): Point[][] {
    const scene = this._scene;
    const ids = scene.getGroup(id) ? scene.groupOps(id) : [id];
    const out: Point[][] = [];
    const strokes: Point[][] = [];
    for (const opId of ids) {
      const region = scene.region(opId);
      if (region) out.push(...region.rings);
      else {
        const b = scene.bounds(opId, "paint");
        if (b) strokes.push([{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }]);
      }
    }
    return boxes || out.length === 0 ? [...out, ...strokes] : out;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (this.grabbed?.id === id) this.release();
    this.world.destroyBody(entry.body);
    this.entries.delete(id);
    this.base.delete(id);
  }

  /**
   * Advances by `seconds` of simulated time in fixed steps (at most 5 a call,
   * so a stalled tab doesn't spiral), then moves the groups of awake bodies.
   */
  step(seconds: number): void {
    this.carry = Math.min(this.carry + seconds, this.dt * 5);
    while (this.carry >= this.dt) {
      this.world.step(this.dt);
      this.carry -= this.dt;
    }
    this.sync();
    if (this.contacts.length > 0) {
      const contacts = this.contacts.splice(0);
      for (const contact of contacts) for (const listener of this.listeners) listener(contact);
    }
  }

  /** Puts every awake body's group where its body is. */
  sync(): void {
    for (const entry of this.entries.values()) {
      const body = entry.body;
      if (!body.isAwake() && !body.isKinematic()) continue;
      if (body.isStatic()) continue;
      const motion = this.motionOf(entry);
      const base = this.base.get(entry.id);
      this._scene.setTransform(entry.id, base ? multiply(motion, base) : motion);
    }
  }

  /** How far a body has moved its drawing: a turn about the drawing's origin, then a move to the body. */
  private motionOf(entry: Entry): Matrix2D {
    const s = this.scale;
    const p = entry.body.getPosition();
    const angle = entry.body.getAngle();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { x, y } = entry.origin;
    return { a: cos, b: sin, c: -sin, d: cos, e: p.x * s - (cos * x - sin * y), f: p.y * s - (sin * x + cos * y) };
  }

  /** Where a body is, in pixels, and how far it has turned. */
  where(id: string): { x: number; y: number; angle: number } | undefined {
    const body = this.entries.get(id)?.body;
    if (!body) return undefined;
    const p = body.getPosition();
    return { x: p.x * this.scale, y: p.y * this.scale, angle: body.getAngle() };
  }

  /** Sets a body's velocity, in pixels per second. */
  push(id: string, velocity: Point): void {
    const body = this.entries.get(id)?.body;
    body?.setLinearVelocity({ x: velocity.x / this.scale, y: velocity.y / this.scale });
    body?.setAwake(true);
  }

  /** The dynamic body at a point, topmost of those whose collider contains it. */
  bodyAt(point: Point): string | undefined {
    const p = { x: point.x / this.scale, y: point.y / this.scale };
    let found: string | undefined;
    this.world.queryAABB({ lowerBound: { x: p.x - 0.001, y: p.y - 0.001 }, upperBound: { x: p.x + 0.001, y: p.y + 0.001 } }, (fixture: Fixture) => {
      const body = fixture.getBody();
      if (!body.isDynamic() || !fixture.testPoint(p)) return true;
      found = this.idOf(body);
      return false;
    });
    return found;
  }

  /** Starts dragging a body by a point on it: it follows `drag` on a spring, still colliding on the way. */
  grab(id: string, point: Point): boolean {
    const body = this.entries.get(id)?.body;
    if (!body || !body.isDynamic()) return false;
    this.release();
    const target = { x: point.x / this.scale, y: point.y / this.scale };
    const joint = this.world.createJoint(new MouseJoint({ maxForce: 1000 * body.getMass(), frequencyHz: 8, dampingRatio: 0.9 }, this.anchor, body, target));
    if (!joint) return false;
    body.setAwake(true);
    this.grabbed = { joint, id };
    return true;
  }

  drag(point: Point): void {
    this.grabbed?.joint.setTarget({ x: point.x / this.scale, y: point.y / this.scale });
  }

  release(): void {
    if (!this.grabbed) return;
    this.world.destroyJoint(this.grabbed.joint);
    this.grabbed = null;
  }

  get dragging(): string | null {
    return this.grabbed?.id ?? null;
  }
}
