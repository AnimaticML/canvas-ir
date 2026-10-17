import { describe, expect, test } from "bun:test";
import { type ComponentUi, Components } from "../src/components";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { EventRouter } from "../src/interaction";
import type { FillOp } from "../src/types";

const board = () => {
  const ctx = new RecordingContext();
  ctx.fillStyle = "#eee";
  ctx.fillRect(0, 0, 400, 400);
  const scene = new Scene(ctx.getDocument());
  const router = new EventRouter(scene);
  const changes: string[][] = [];
  const components = new Components(scene, router, { onChange: (ids) => changes.push([...ids]) });
  return { scene, router, components, changes };
};

/** A button that, pressed, draws a shadow first, so every op gets a new id while it is held. */
const button = (clicks: string[]) => ({
  id: "button",
  state: { count: 0 },
  cursor: "pointer",
  draw: (ctx: RecordingContext, state: { count: number }, ui: ComponentUi) => {
    if (ui.pressed) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(12, 12, 80, 30);
    }
    ctx.fillStyle = ui.pressed ? "#000080" : ui.hovered ? "#0000ff" : "#808080";
    ctx.fillRect(10, 10, 80, 30);
    ctx.beginGroup({ id: "label", meta: { part: "label" } });
    ctx.fillStyle = "white";
    ctx.fillRect(20, 20, 20 + state.count, 10);
    ctx.endGroup();
  },
  on: {
    click: (e: { stopPropagation(): void }, c: { setState(n: { count: number }): void; state: { count: number } }) => {
      clicks.push("button");
      c.setState({ count: c.state.count + 1 });
      e.stopPropagation();
    },
  },
});

describe("components", () => {
  test("draw into their group, and redraw on hover, press and state", () => {
    const { scene, router, components } = board();
    const clicks: string[] = [];
    router.on("*", "click", () => clicks.push("board"));
    const c = components.mount(button(clicks));
    expect(scene.getGroup("button")?.meta).toEqual({ component: true });
    expect(scene.getGroup("button/label")?.parent).toBe("button");
    const fills = () => scene.groupOps("button").map((id) => (scene.get(id) as FillOp).paint);
    expect(fills()).toEqual(["#808080", "#ffffff"]);
    expect(components.cursor).toBeNull();

    router.pointerMove({ x: 50, y: 15 });
    expect(c.ui.hovered).toBe(true);
    expect(fills()).toEqual(["#0000ff", "#ffffff"]);
    expect(components.cursor).toBe("pointer");
    router.pointerMove({ x: 25, y: 25 });
    expect(c.ui.hoveredParts.map((g) => g.meta)).toEqual([{ part: "label" }]);

    router.pointerDown({ x: 50, y: 15 });
    expect(c.ui).toMatchObject({ pressed: true, focused: true });
    expect(fills()).toEqual(["#000000", "#000080", "#ffffff"]);
    // The release lands on an op drawn after the press: the click still reaches the component, and it keeps the click.
    router.pointerUp({ x: 50, y: 15 });
    expect(clicks).toEqual(["button"]);
    expect(c.state.count).toBe(1);
    expect(c.ui.pressed).toBe(false);
    expect(fills()).toEqual(["#0000ff", "#ffffff"]);

    router.pointerMove({ x: 300, y: 300 });
    expect(c.ui.hovered).toBe(false);
    expect(components.cursor).toBeNull();
    router.pointerDown({ x: 300, y: 300 });
    router.pointerUp({ x: 300, y: 300 });
    expect(clicks).toEqual(["button", "board"]);
    expect(c.ui.focused).toBe(false);
  });

  test("drags reach a component that redraws while dragged, and can be kept from the board", () => {
    const { router, components } = board();
    const boardDrags: number[] = [];
    router.on("*", "drag", (e) => boardDrags.push(e.total!.x));
    const knob = components.mount({
      id: "knob",
      state: { value: 0 },
      draw: (ctx, state) => {
        // A different op count per value: ids change on every redraw.
        for (let i = 0; i <= Math.min(5, Math.floor(state.value / 10)); i++) ctx.fillRect(100, 100, 50, 50);
      },
      on: {
        dragstart: (e) => e.stopPropagation(),
        drag: (e, c) => {
          c.setState({ value: Math.round(e.total!.x) });
          e.stopPropagation();
        },
      },
    });
    router.pointerDown({ x: 120, y: 120 });
    for (const x of [130, 140, 160, 180]) router.pointerMove({ x, y: 120 });
    router.pointerUp({ x: 180, y: 120 });
    expect(knob.state.value).toBe(60);
    expect(boardDrags).toEqual([]);
  });

  test("keys go to the focused component after it redraws", () => {
    const { router, components } = board();
    const slider = components.mount({
      id: "slider",
      state: { value: 5 },
      draw: (ctx, state, ui) => {
        if (ui.focused) ctx.strokeRect(0, 0, 100, 20);
        ctx.fillRect(state.value, 0, 10, 20);
      },
      on: { keydown: (e, c) => c.setState((s) => ({ value: s.value + ((e.input as { key: string }).key === "ArrowRight" ? 1 : -1) })) },
    });
    router.pointerDown({ x: 8, y: 10 });
    router.pointerUp({ x: 8, y: 10 });
    router.keyDown({ key: "ArrowRight" });
    router.keyDown({ key: "ArrowRight" });
    router.keyDown({ key: "ArrowLeft" });
    expect(slider.state.value).toBe(6);
  });

  test("a moved component stays where it was moved when it redraws", () => {
    const { scene, components } = board();
    const c = components.mount({ id: "box", state: { w: 10 }, draw: (ctx, s) => ctx.fillRect(0, 0, s.w, 10) });
    components.move("box", { a: 1, b: 0, c: 0, d: 1, e: 200, f: 50 });
    expect(scene.bounds("box")).toEqual({ x: 200, y: 50, width: 10, height: 10 });
    c.setState({ w: 30 });
    expect(scene.bounds("box")).toEqual({ x: 200, y: 50, width: 30, height: 10 });
    components.unmount("box");
    expect(scene.getGroup("box")).toBeUndefined();
  });

  test("invisible shapes in a hit area are targets; snap: false groups aren't snapped to", () => {
    const { scene, router, components } = board();
    const c = components.mount({
      id: "grip",
      state: {},
      meta: { snap: false },
      draw: (ctx) => {
        ctx.beginGroup({ meta: { hitArea: true } });
        ctx.fillStyle = "transparent";
        ctx.fillRect(0, 300, 100, 40);
        ctx.endGroup();
        ctx.fillStyle = "red";
        ctx.fillRect(0, 318, 100, 4);
      },
    });
    router.pointerMove({ x: 50, y: 305 });
    expect(c.ui.hovered).toBe(true);
    expect(scene.hitTest({ x: 50, y: 305 })[0]?.groups.at(-1)).toBe("grip");
    // The red bar's corner is nearest, but only the board's edge is offered.
    const snap = scene.snap({ x: 1, y: 319 }, { radius: 3 })!;
    expect(snap.ids.some((id) => scene.groupChain(id).includes("grip"))).toBe(false);
    expect(snap.point.x).toBe(0);
    expect(scene.snap({ x: 1, y: 319 }, { radius: 3, filter: (op) => op.kind === "text" })).toBeNull();
  });

  test("bind moves components to a rebuilt scene", () => {
    const { scene, components } = board();
    const clicks: string[] = [];
    components.mount(button(clicks));
    const rebuilt = new Scene(scene.document);
    const router = new EventRouter(rebuilt);
    components.bind(rebuilt, router);
    router.pointerDown({ x: 50, y: 15 });
    router.pointerUp({ x: 50, y: 15 });
    expect(clicks).toEqual(["button"]);
    expect(rebuilt.groupOps("button").length).toBe(2);
  });
});
