import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { EventRouter, type RouterEvent } from "../src/interaction";
import { replayDocument } from "../src/replay";
import { deserializeDocument, parseDocument, serializeDocument } from "../src/serialization";
import type { IRDocument } from "../src/types";

/** A badge group (circle and check mark) inside an asset group, and a loose square. */
const drawing = (): IRDocument => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "asset", meta: { source: "badge.svg" } });
  ctx.beginGroup({ id: "badge" });
  ctx.beginPath();
  ctx.arc(50, 50, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(35, 50);
  ctx.lineTo(45, 60);
  ctx.lineTo(65, 40);
  ctx.stroke();
  ctx.endGroup();
  ctx.endGroup();
  ctx.fillRect(150, 30, 40, 40);
  return ctx.getDocument();
};

describe("groups", () => {
  test("ops record their innermost group, and groups their parents", () => {
    const doc = drawing();
    expect(doc.groups).toEqual([{ id: "asset", meta: { source: "badge.svg" } }, { id: "badge", parent: "asset" }]);
    expect(doc.ops.map((op) => op.group)).toEqual(["badge", "badge", undefined]);
  });

  test("a document without groups has no groups field", () => {
    const ctx = new RecordingContext();
    ctx.fillRect(0, 0, 1, 1);
    expect("groups" in ctx.getDocument()).toBe(false);
  });

  test("unbalanced or duplicate groups throw", () => {
    const ctx = new RecordingContext();
    expect(() => ctx.endGroup()).toThrow();
    ctx.beginGroup({ id: "a" });
    expect(() => ctx.beginGroup({ id: "a" })).toThrow();
  });

  test("a closed group can be added to again, so its ops needn't be consecutive", () => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "a" });
    ctx.fillRect(0, 0, 1, 1);
    ctx.endGroup();
    ctx.fillRect(0, 0, 1, 1);
    ctx.beginGroup({ id: "a" });
    ctx.fillRect(0, 0, 1, 1);
    ctx.endGroup();
    const doc = ctx.getDocument();
    expect(doc.groups).toHaveLength(1);
    expect(doc.ops.map((op) => op.group)).toEqual(["a", undefined, "a"]);
    const again = new RecordingContext();
    replayDocument(again, doc);
    expect(again.getDocument()).toEqual(doc);
  });

  test("automatic ids skip groups replayed into the context", () => {
    const ctx = new RecordingContext();
    ctx.beginGroup();
    ctx.fillRect(0, 0, 1, 1);
    ctx.endGroup();
    const again = new RecordingContext();
    replayDocument(again, ctx.getDocument());
    expect(again.beginGroup()).toBe("g1");
  });

  test("groups round-trip through JSON and replay", () => {
    const doc = drawing();
    const json = serializeDocument(doc);
    expect(serializeDocument(deserializeDocument(json))).toBe(json);
    const again = new RecordingContext();
    replayDocument(again, doc);
    expect(again.getDocument()).toEqual(doc);
  });

  test("the schema rejects unknown groups and parents declared later", () => {
    const doc = JSON.parse(serializeDocument(drawing()));
    expect(() => parseDocument({ ...doc, ops: [{ ...doc.ops[0], group: "nope" }] })).toThrow(/no group nope/);
    expect(() => parseDocument({ ...doc, groups: [...doc.groups].reverse() })).toThrow(/not an earlier group/);
  });

  test("hits carry the group chain, and groups have bounds, moves and removal", () => {
    const scene = new Scene(drawing());
    expect(scene.hitTest({ x: 45, y: 59 }).map((h) => [h.id, h.groups])).toEqual([
      ["o1", ["badge", "asset"]],
      ["o0", ["badge", "asset"]],
    ]);
    expect(scene.bounds("asset")).toEqual({ x: 20, y: 20, width: 60, height: 60 });
    scene.transform("asset", { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
    expect(scene.bounds("badge")).toEqual({ x: 120, y: 20, width: 60, height: 60 });
    scene.remove("asset");
    expect(scene.document.ops.map((op) => op.id)).toEqual(["o2"]);
    expect(scene.document.groups).toBeUndefined();
  });
});

describe("event router", () => {
  const setup = () => {
    const scene = new Scene(drawing());
    // The host shows the world at 2x, panned by (10, 10).
    const router = new EventRouter(scene, { view: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 } });
    const log: string[] = [];
    const record = (e: RouterEvent) => log.push(`${e.type}@${e.currentTarget}:${e.target ?? "-"}`);
    return { scene, router, log, record };
  };
  const at = (x: number, y: number) => ({ x: 2 * x + 10, y: 2 * y + 10 });

  test("enter and leave go to each id the pointer crosses, outermost entered first", () => {
    const { router, log, record } = setup();
    for (const id of ["o0", "badge", "asset", "o2"]) {
      router.on(id, "enter", record);
      router.on(id, "leave", record);
    }
    router.pointerMove(at(50, 30));
    router.pointerMove(at(170, 50));
    expect(log).toEqual(["enter@asset:o0", "enter@badge:o0", "enter@o0:o0", "leave@o0:o0", "leave@badge:o0", "leave@asset:o0", "enter@o2:o2"]);
  });

  test("clicks capture down through groups and bubble up, and can be stopped", () => {
    const { router, log, record } = setup();
    router.on("*", "click", record, { capture: true });
    router.on("asset", "click", record, { capture: true });
    router.on("o0", "click", record);
    router.on("badge", "click", record);
    router.on("asset", "click", record);
    router.on("*", "click", record);
    router.pointerDown(at(50, 30));
    router.pointerUp(at(50, 30));
    expect(log).toEqual(["click@*:o0", "click@asset:o0", "click@o0:o0", "click@badge:o0", "click@asset:o0", "click@*:o0"]);
    log.length = 0;
    router.on("badge", "click", (e) => e.stopPropagation());
    router.pointerDown(at(50, 30));
    router.pointerUp(at(50, 30));
    expect(log).toEqual(["click@*:o0", "click@asset:o0", "click@o0:o0", "click@badge:o0"]);
  });

  test("a press that moves past the threshold drags instead of clicking", () => {
    const { scene, router, log, record } = setup();
    const moves: { x: number; y: number }[] = [];
    for (const type of ["dragstart", "drag", "dragend", "click"] as const) router.on("asset", type, record);
    router.on("asset", "drag", (e) => {
      scene.transform("asset", { a: 1, b: 0, c: 0, d: 1, e: e.delta!.x, f: e.delta!.y });
      moves.push(e.total!);
    });
    router.pointerDown(at(50, 30));
    router.pointerMove({ ...at(50, 30), x: at(50, 30).x + 1 }); // under the threshold
    router.pointerMove(at(60, 30));
    router.pointerMove(at(70, 40));
    router.pointerUp(at(70, 40));
    expect(log).toEqual(["dragstart@asset:o0", "drag@asset:o0", "drag@asset:o0", "dragend@asset:o0"]);
    expect(moves.at(-1)).toEqual({ x: 20, y: 10 });
    // The badge moved with the pointer, in world units.
    expect(scene.bounds("badge")).toEqual({ x: 40, y: 30, width: 60, height: 60 });
  });

  test("events carry world and local points, and keys go to the pressed op", () => {
    const ctx = new RecordingContext();
    ctx.translate(100, 0);
    ctx.scale(2, 2);
    ctx.fillRect(0, 0, 10, 10);
    const router = new EventRouter(new Scene(ctx.getDocument()));
    const seen: RouterEvent[] = [];
    router.on("o0", "down", (e) => seen.push(e));
    router.on("o0", "keydown", (e) => seen.push(e));
    router.pointerDown({ x: 110, y: 4 });
    router.keyDown({ key: "Delete" });
    expect(seen[0]!.point).toEqual({ x: 110, y: 4 });
    expect(seen[0]!.local).toEqual({ x: 5, y: 2 });
    expect(seen[1]!.target).toBe("o0");
    expect((seen[1]!.input as { key: string }).key).toBe("Delete");
  });

  test("empty space is a target of null that only '*' hears", () => {
    const { router, log, record } = setup();
    router.on("*", "down", record);
    router.on("o2", "down", record);
    router.pointerDown(at(120, 140));
    expect(log).toEqual(["down@*:-"]);
  });
});
