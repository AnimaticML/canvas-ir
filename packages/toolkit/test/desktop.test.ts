import { describe, expect, test } from "bun:test";
import { Components, EventRouter, RecordingContext, Scene, type TextMeasure } from "canvas-ir";
import { Desktop, Windows, fixedTheme } from "../src/index";

const measureText = (text: string): TextMeasure => ({
  width: text.length * 6,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: text.length * 6,
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 9,
  fontBoundingBoxDescent: 3,
});

const layer = (doc: ConstructorParameters<typeof Scene>[0] = { version: 1, ops: [] }) => {
  const scene = new Scene(doc);
  const router = new EventRouter(scene);
  const components = new Components(scene, router, { recorder: { measureText } });
  return { scene, router, components };
};
const colors = fixedTheme().colors;

describe("desktop", () => {
  test("pressing an icon opens its window, pressing again closes it, and an open window shows as a dot", () => {
    const l = layer();
    let open = false;
    const toggled: string[] = [];
    const desktop = new Desktop({ layer: l, colors, redraw: () => {}, onToggle: (id, opened) => toggled.push(`${id} ${opened}`) });
    desktop.add({ id: "map", name: "World map", x: 0, y: 0, open: () => open, show: () => (open = true), hide: () => (open = false) });
    const ops = () => l.scene.document.ops.length;
    // A press on the tile, as the router delivers it.
    l.router.pointerDown({ x: 75, y: 75, button: 0 });
    l.router.pointerUp({ x: 75, y: 75, button: 0 });
    expect(open).toBe(true);
    const openOps = ops();
    desktop.toggle("map");
    expect(open).toBe(false);
    // The dot went with it.
    expect(ops()).toBe(openOps - 1);
    expect(toggled).toEqual(["map true", "map false"]);
    expect(desktop.iconOf("icon-map")).toBe("map");
    expect(desktop.iconOf("icon-other")).toBeNull();
  });

  test("an icon dragged moves, and the host is told where it was let go; a kept place is where it starts", () => {
    const l = layer();
    const moved: unknown[] = [];
    const desktop = new Desktop({ layer: l, colors, redraw: () => {}, moved: { cat: { x: 300, y: 0 } }, onMoved: (id, at) => moved.push([id, at]) });
    let acted = 0;
    desktop.add({ id: "cat", name: "Cat", x: 0, y: 0, show: () => acted++ });
    expect(desktop.position("cat")).toEqual({ x: 300, y: 0 });
    l.router.pointerDown({ x: 375, y: 75, button: 0 });
    l.router.pointerMove({ x: 395, y: 85, button: 0 });
    l.router.pointerMove({ x: 425, y: 115, button: 0 });
    l.router.pointerUp({ x: 425, y: 115, button: 0 });
    expect(acted).toBe(0);
    expect(moved).toEqual([["cat", { x: 350, y: 40 }]]);
    expect(desktop.position("cat")).toEqual({ x: 350, y: 40 });
    expect(Math.abs(desktop.boxOf("cat")!.x - 350)).toBeLessThan(3);
  });
});

describe("windows", () => {
  test("a frame goes round what a window holds, moves with it, and its close button closes it", () => {
    const ctx = new RecordingContext({ measureText });
    ctx.beginGroup({ id: "demo" });
    ctx.fillRect(100, 100, 200, 100);
    ctx.endGroup();
    ctx.beginGroup({ id: "demo-button" });
    ctx.fillRect(100, 220, 50, 20);
    ctx.endGroup();
    ctx.beginGroup({ id: "other" });
    ctx.fillRect(500, 500, 10, 10);
    ctx.endGroup();
    const board = layer(ctx.getDocument());
    const followed: string[] = [];
    let closed = 0;
    const windows = new Windows({ board, moved: (id) => followed.push(id), onClose: () => closed++ });
    windows.frame("demo", "Demo", ["demo", "demo-button", "gone"], () => {});
    expect(windows.with(["demo-button"]).sort()).toEqual(["demo", "demo-button", "demo:window"]);
    expect(windows.with(["other"])).toEqual(["other"]);
    const [w] = windows.list();
    expect(w!.held).toEqual(["demo", "demo-button"]);
    expect(w!.box.x).toBeCloseTo(84);
    windows.moveBy("demo", 10, 0);
    expect(followed.sort()).toEqual(["demo", "demo-button", "demo:window"]);
    expect(board.scene.bounds("demo")!.x).toBeCloseTo(110);
    // The close button, at the title bar's left end.
    const b = windows.list()[0]!.box;
    board.router.pointerDown({ x: b.x + 24, y: b.y + 20, button: 0 });
    board.router.pointerUp({ x: b.x + 24, y: b.y + 20, button: 0 });
    expect(closed).toBe(1);
    expect(windows.list()).toEqual([]);
  });
});
