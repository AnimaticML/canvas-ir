import { describe, expect, test } from "bun:test";
import { RecordingContext, Scene } from "canvas-ir";
import { Physics, convexHull, reduceHull } from "../src";

/** Ground from x 0 to 400 at y 300, and a 20 px crate above it at (100, 100). */
const world = (): { scene: Scene; physics: Physics } => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "ground" });
  ctx.fillRect(0, 300, 400, 20);
  ctx.endGroup();
  ctx.beginGroup({ id: "crate" });
  ctx.fillStyle = "#a16207";
  ctx.fillRect(90, 90, 20, 20);
  ctx.strokeRect(92, 92, 16, 16);
  ctx.endGroup();
  const scene = new Scene(ctx.getDocument());
  return { scene, physics: new Physics(scene) };
};

const run = (physics: Physics, seconds: number): void => {
  for (let t = 0; t < seconds; t += 1 / 60) physics.step(1 / 60);
};

describe("physics", () => {
  test("a crate falls onto the ground and rests on it, its drawing moved with it", () => {
    const { scene, physics } = world();
    physics.add("ground", { type: "static" });
    physics.add("crate");
    run(physics, 0.2);
    // About half g t^2 after 0.2 s.
    expect(scene.bounds("crate")!.y).toBeGreaterThan(105);
    run(physics, 3);
    const b = scene.bounds("crate")!;
    expect(b.y + b.height).toBeCloseTo(300, 0);
    expect(b.x).toBeCloseTo(90, 0);
    expect(physics.body("crate")!.isAwake()).toBe(false);
  });

  test("contacts are reported by group id", () => {
    const { physics } = world();
    physics.add("ground", { type: "static" });
    physics.add("crate");
    const seen: string[] = [];
    physics.onContact((c) => seen.push([c.a, c.b].sort().join("+")));
    run(physics, 2);
    expect(seen).toContain("crate+ground");
  });

  test("ground of any shape collides through its outline", () => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "hill" });
    // A slope down to the right.
    ctx.beginPath();
    ctx.moveTo(0, 200);
    ctx.lineTo(400, 300);
    ctx.lineTo(400, 320);
    ctx.lineTo(0, 320);
    ctx.closePath();
    ctx.fill();
    ctx.endGroup();
    ctx.beginGroup({ id: "ball" });
    ctx.beginPath();
    ctx.arc(50, 150, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.endGroup();
    const scene = new Scene(ctx.getDocument());
    const physics = new Physics(scene);
    physics.add("hill", { collider: "outline" });
    physics.add("ball", { collider: "circle" });
    run(physics, 1.5);
    const b = scene.bounds("ball")!;
    // It rolled down the slope and sits on it, not through it.
    expect(b.x).toBeGreaterThan(80);
    const surface = 200 + ((b.x + b.width / 2) / 400) * 100;
    expect(b.y + b.height).toBeLessThan(surface + 2);
  });

  test("a body can be grabbed and dragged on a spring", () => {
    const { scene, physics } = world();
    physics.add("ground", { type: "static" });
    physics.add("crate");
    run(physics, 2);
    expect(physics.bodyAt({ x: 100, y: 290 })).toBe("crate");
    expect(physics.grab("crate", { x: 100, y: 290 })).toBe(true);
    physics.drag({ x: 200, y: 150 });
    run(physics, 1);
    const b = scene.bounds("crate")!;
    expect(b.x + b.width / 2).toBeCloseTo(200, -1);
    physics.release();
    expect(physics.dragging).toBeNull();
  });

  test("hulls are convex and cut down to Box2D's corner limit", () => {
    const circle = Array.from({ length: 40 }, (_, i) => ({ x: Math.cos((i / 40) * 2 * Math.PI), y: Math.sin((i / 40) * 2 * Math.PI) }));
    const hull = convexHull([...circle, { x: 0, y: 0 }, { x: 0.5, y: 0.1 }]);
    expect(hull.length).toBe(40);
    expect(reduceHull(hull, 8).length).toBe(8);
  });
});

describe("rebinding", () => {
  test("bodies carry on in a scene replayed from the board as drawn now", () => {
    const { scene, physics } = world();
    physics.add("ground", { type: "static" });
    physics.add("crate");
    run(physics, 0.3);
    const before = scene.bounds("crate")!;
    const replayed = new Scene(scene.document);
    physics.rebind(replayed);
    physics.step(0);
    physics.sync();
    expect(replayed.bounds("crate")!.y).toBeCloseTo(before.y, 6);
    run(physics, 3);
    const b = replayed.bounds("crate")!;
    expect(b.y + b.height).toBeCloseTo(300, 0);
  });
});
