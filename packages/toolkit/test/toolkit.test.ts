import { describe, expect, test } from "bun:test";
import { Actions, Gestures, wrapAngle, type GestureHandlers, Viewport, wheelPixels, wheelZoom } from "../src";

describe("viewport", () => {
  test("zooming at a point keeps the world point under it", () => {
    const v = new Viewport({ zoom: 1, x: 20, y: 10 });
    const anchor = { x: 300, y: 200 };
    const before = v.toWorld(anchor);
    v.zoomAt(2.5, anchor);
    const after = v.toWorld(anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(v.zoom).toBe(2.5);
  });

  test("limits hold for every change, and zoom stops at them with the anchor still", () => {
    const v = new Viewport({ zoom: 1, x: 0, y: 0 }, { minZoom: 0.45, maxZoom: 2.4 });
    v.zoomAt(10, { x: 100, y: 100 });
    expect(v.zoom).toBe(2.4);
    expect(v.toWorld({ x: 100, y: 100 }).x).toBeCloseTo(100, 9);
    v.set({ zoom: 0.01, x: 0, y: 0 });
    expect(v.zoom).toBe(0.45);
  });

  test("a clamp keeps the view in bounds", () => {
    // A 1000-wide picture in a 400-wide window, never panned past its edges.
    const clamp = (view: { zoom: number; x: number; y: number }) => ({ ...view, x: Math.min(0, Math.max(400 - 1000 * view.zoom, view.x)) });
    const v = new Viewport({ zoom: 1, x: 0, y: 0 }, { clamp });
    v.panBy(100, 0);
    expect(v.view.x).toBe(0);
    v.panBy(-5000, 0);
    expect(v.view.x).toBe(-600);
  });

  test("matrices, screen and world agree, and listeners hear each change once", () => {
    const v = new Viewport({ zoom: 2, x: 5, y: -3 });
    const heard: number[] = [];
    const stop = v.onChange((view) => heard.push(view.zoom));
    expect(v.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 5, f: -3 });
    expect(v.device(2)).toEqual({ a: 4, b: 0, c: 0, d: 4, e: 10, f: -6 });
    const w = v.toWorld(v.toScreen({ x: 7, y: 11 }));
    expect(w.x).toBeCloseTo(7, 12);
    expect(w.y).toBeCloseTo(11, 12);
    v.setMatrix({ a: 3, b: 0, c: 0, d: 3, e: 1, f: 2 });
    v.set(v.view);
    stop();
    v.zoomAt(2, { x: 0, y: 0 });
    expect(heard).toEqual([3]);
  });

  test("fit centers a rectangle", () => {
    const v = new Viewport();
    v.fit({ x: 100, y: 100, width: 200, height: 100 }, { width: 400, height: 400 }, 0);
    expect(v.zoom).toBe(2);
    expect(v.toScreen({ x: 200, y: 150 })).toEqual({ x: 200, y: 200 });
  });

  test("wheel lines and pages become pixels, and the zoom is symmetric", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)).toEqual({ x: 0, y: 99 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 800)).toEqual({ x: 0, y: 800 });
    expect(wheelZoom(100) * wheelZoom(-100)).toBeCloseTo(1, 12);
  });
});

/** Records what the gestures said. */
const recorder = () => {
  const said: string[] = [];
  const h: GestureHandlers = {
    press: () => said.push("press"),
    tap: (p) => said.push(`tap ${p.x},${p.y}`),
    dragStart: (e) => said.push(`dragStart ${e.start.x},${e.start.y}`),
    drag: (e) => said.push(`drag ${e.total.x},${e.total.y}`),
    dragEnd: (e) => said.push(`dragEnd ${e.total.x},${e.total.y}`),
    pinchStart: () => said.push("pinchStart"),
    pinch: (e) => said.push(`pinch ${e.scale.toFixed(2)} ${e.center.x},${e.center.y}`),
    pinchEnd: () => said.push("pinchEnd"),
    cancel: () => said.push("cancel"),
    hover: () => said.push("hover"),
  };
  return { said, h };
};

describe("gestures", () => {
  test("a press that stays within the slop taps", () => {
    const { said, h } = recorder();
    const g = new Gestures(h);
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 14, y: 12 });
    g.up(1, { x: 14, y: 12 });
    expect(said).toEqual(["press", "tap 14,12"]);
  });

  test("a press that moves past it drags, from where it began, and ends without a tap", () => {
    const { said, h } = recorder();
    const g = new Gestures(h, { slop: 6 });
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 10, y: 0 });
    g.move(1, { x: 20, y: 5 });
    g.up(1, { x: 20, y: 5 });
    expect(said).toEqual(["press", "dragStart 0,0", "drag 10,0", "drag 20,5", "dragEnd 20,5"]);
  });

  test("a second finger cancels the press and pinches; the finger left does nothing until all are up", () => {
    const { said, h } = recorder();
    const g = new Gestures(h);
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 20, y: 0 });
    g.down(2, { x: 100, y: 0 });
    g.move(2, { x: 120, y: 0 });
    expect(g.pinching).toBe(true);
    g.up(2);
    g.move(1, { x: 60, y: 0 });
    g.up(1);
    expect(said).toEqual(["press", "dragStart 0,0", "drag 20,0", "cancel", "pinchStart", "pinch 1.25 70,0", "pinchEnd"]);
    // Clear again: the next press taps.
    g.down(3, { x: 5, y: 5 });
    g.up(3);
    expect(said.at(-1)).toBe("tap 5,5");
  });

  test("two fingers turning twist, clockwise on screen, the short way across the seam", () => {
    const twists: number[] = [];
    const g = new Gestures({ pinch: (e) => twists.push(e.twist) });
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 100, y: 0 });
    // A quarter turn clockwise on screen (y down): the second finger swings below the first.
    g.move(2, { x: 0, y: 100 });
    expect(twists[0]).toBeCloseTo(Math.PI / 2);
    // From pointing left just above the seam to just below it is a small turn, not nearly a whole one.
    g.move(2, { x: -100, y: 1 });
    g.move(2, { x: -100, y: -1 });
    expect(Math.abs(twists.at(-1)!)).toBeLessThan(0.05);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
  });

  test("a cancelled pointer ends the press without a tap, and hovering is only with nothing pressed", () => {
    const { said, h } = recorder();
    const g = new Gestures(h);
    g.move(9, { x: 1, y: 1 });
    g.down(1, { x: 0, y: 0 });
    g.move(9, { x: 1, y: 1 });
    g.cancel(1);
    g.up(1);
    expect(said).toEqual(["hover", "press", "cancel"]);
    expect(g.active).toBe(0);
  });
});

describe("actions", () => {
  test("a hit's path runs the innermost action, and a stale remover leaves a newer action", () => {
    const a = new Actions();
    const ran: string[] = [];
    const off = a.set("button", () => ran.push("old"));
    a.set("button", { label: "Press", run: () => ran.push("new") });
    off();
    a.set("card", () => ran.push("card"));
    expect(a.run(["label", "button", "card"])).toBe(true);
    expect(a.run("nothing")).toBe(false);
    expect(ran).toEqual(["new"]);
    expect(a.list()).toEqual([{ id: "button", label: "Press" }, { id: "card" }]);
  });
});
