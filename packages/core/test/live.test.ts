import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { multiply } from "../src/math";
import type { FillOp, Matrix2D } from "../src/types";

const translate = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
const rotate = (angle: number): Matrix2D => ({ a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 0, f: 0 });

/** A bicycle: a frame square at the origin, and a wheel group inside it with a square at (100, 0). */
const bike = (): Scene => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "bike" });
  ctx.fillRect(-10, -10, 20, 20);
  ctx.beginGroup({ id: "wheel" });
  ctx.fillRect(90, -10, 20, 20);
  ctx.endGroup();
  ctx.endGroup();
  return new Scene(ctx.getDocument());
};

const center = (s: Scene, id: string): { x: number; y: number } => {
  const b = s.bounds(id)!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

describe("live transforms", () => {
  test("setTransform places a group absolutely: setting it again replaces, it does not compose", () => {
    const s = bike();
    s.setTransform("bike", translate(50, 0));
    s.setTransform("bike", translate(30, 5));
    expect(center(s, "o0").x).toBeCloseTo(30, 9);
    expect(center(s, "o0").y).toBeCloseTo(5, 9);
    expect(s.transformOf("bike")).toEqual(translate(30, 5));
    s.setTransform("bike", { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(center(s, "o0").x).toBeCloseTo(0, 9);
  });

  test("a thousand small turns leave no drift", () => {
    const s = bike();
    for (let i = 1; i <= 1000; i++) s.setTransform("bike", rotate(i * 0.01));
    s.setTransform("bike", rotate(0));
    const op = s.get("o1") as FillOp;
    expect(op.path.matrices[0]).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  test("nested live transforms compose, outermost first", () => {
    const s = bike();
    // The wheel turns half a turn about the frame's origin, then the bike moves.
    s.setTransform("wheel", rotate(Math.PI));
    s.setTransform("bike", translate(0, 40));
    expect(center(s, "o1").x).toBeCloseTo(-100, 6);
    expect(center(s, "o1").y).toBeCloseTo(40, 6);
    expect(center(s, "o0").y).toBeCloseTo(40, 6);
    // Setting the inner one again keeps the outer.
    s.setTransform("wheel", rotate(0));
    expect(center(s, "o1").x).toBeCloseTo(100, 6);
    expect(center(s, "o1").y).toBeCloseTo(40, 6);
  });

  test("hit tests, rect queries and the index follow a moved group", () => {
    const s = bike();
    s.setTransform("bike", multiply(translate(500, 500), rotate(Math.PI / 2)));
    expect(s.hitTest({ x: 0, y: 0 })).toEqual([]);
    expect(s.hitTest({ x: 500, y: 600 }).map((h) => h.id)).toEqual(["o1"]);
    expect(s.queryRect({ x: 480, y: 480, width: 40, height: 40 })).toEqual(["o0"]);
    expect(s.opsIn({ x: 490, y: 590, width: 20, height: 20 })).toEqual(["o1"]);
  });

  test("each move is one change per op, with where it was and is", () => {
    const s = bike();
    const changes: string[] = [];
    s.onChange((c) => changes.push(`${c.id} ${c.before?.box?.x} ${c.after?.box?.x}`));
    s.setTransform("bike", translate(5, 0));
    expect(changes).toEqual(["o0 -10 -5", "o1 90 95"]);
    s.setTransform("bike", translate(5, 0));
    expect(changes.length).toBe(2);
  });

  test("ops redrawn into a moving group are drawn in its space", () => {
    const s = bike();
    s.setTransform("bike", translate(0, 100));
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "wheel" });
    ctx.fillRect(190, -10, 20, 20);
    ctx.endGroup();
    s.replaceGroup("wheel", ctx.getDocument(), { parent: "bike" });
    const wheel = s.groupOps("wheel")[0]!;
    expect(center(s, wheel)).toEqual({ x: 200, y: 100 });
    // And the group's own live transform survives a redraw of its contents.
    s.setTransform("wheel", translate(1, 0));
    s.replaceGroup("wheel", ctx.getDocument(), { parent: "bike" });
    expect(center(s, s.groupOps("wheel")[0]!)).toEqual({ x: 201, y: 100 });
    s.setTransform("bike", translate(0, 0));
    expect(center(s, s.groupOps("wheel")[0]!)).toEqual({ x: 201, y: 0 });
  });

  test("a drag under a live transform stays when the live transform changes", () => {
    const s = bike();
    s.setTransform("bike", translate(0, 100));
    s.transform("o0", translate(7, 0));
    expect(center(s, "o0")).toEqual({ x: 7, y: 100 });
    s.setTransform("bike", translate(0, 200));
    expect(center(s, "o0")).toEqual({ x: 7, y: 200 });
  });

  test("replace takes the op as drawn, and later moves carry it", () => {
    const s = bike();
    s.setTransform("bike", translate(0, 100));
    const op = s.get("o0") as FillOp;
    s.replace({ ...op, paint: "#ff0000" });
    s.setTransform("bike", translate(0, 0));
    expect(center(s, "o0")).toEqual({ x: 0, y: 0 });
    expect((s.get("o0") as FillOp).paint).toBe("#ff0000");
  });

  test("an op can have its own live transform", () => {
    const s = bike();
    s.setTransform("o1", translate(0, 10));
    s.setTransform("bike", translate(10, 0));
    expect(center(s, "o1")).toEqual({ x: 110, y: 10 });
    expect(() => s.setTransform("nope", translate(1, 1))).toThrow();
  });

  test("removing a group forgets its live transform", () => {
    const s = bike();
    s.setTransform("wheel", translate(3, 0));
    s.remove("wheel");
    expect(s.transformOf("wheel")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(s.groupOps("bike")).toEqual(["o0"]);
  });
});
