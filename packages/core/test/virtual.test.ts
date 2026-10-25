import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { EventRouter } from "../src/interaction";
import { VirtualGroup } from "../src/virtual";

const ROW = 20;
const ROWS = 1_000_000;

/** A million rows, each its own group keyed by its index; counts the rows it records. */
const table = () => {
  const scene = new Scene({ version: 1, ops: [] });
  let drawnRows = 0;
  const rows = new VirtualGroup(scene, {
    id: "table",
    extent: { x: 0, y: 0, width: 300, height: ROWS * ROW },
    draw: (ctx, window) => {
      const first = Math.floor(window.y / ROW);
      const last = Math.min(ROWS - 1, Math.ceil((window.y + window.height) / ROW) - 1);
      for (let r = first; r <= last; r++) {
        ctx.beginGroup({ id: `r${r}`, meta: { row: r } });
        ctx.fillStyle = r % 2 ? "#eeeeee" : "#ffffff";
        ctx.fillRect(0, r * ROW, 300, ROW);
        ctx.endGroup();
        drawnRows++;
      }
    },
  });
  return { scene, rows, drawn: () => drawnRows };
};

describe("VirtualGroup", () => {
  test("records only the rows that show, and some past them", () => {
    const { scene, rows } = table();
    rows.show({ visible: { x: 0, y: 0, width: 300, height: 400 } });
    // 20 rows show; half as much again past each side, clamped at the top.
    expect(scene.groupOps("table").length).toBe(30);
    expect(rows.window).toEqual({ x: 0, y: 0, width: 300, height: 600 });
    expect(rows.bounds.height).toBe(ROWS * ROW);
  });

  test("a small move reuses what was drawn; a big one draws again", () => {
    const { rows, drawn } = table();
    rows.show({ visible: { x: 0, y: 4000, width: 300, height: 400 } });
    const before = drawn();
    expect(rows.show({ visible: { x: 0, y: 4100, width: 300, height: 400 } })).toBe(false);
    expect(drawn()).toBe(before);
    expect(rows.show({ visible: { x: 0, y: 9000, width: 300, height: 400 } })).toBe(true);
    expect(drawn()).toBeGreaterThan(before);
  });

  test("scrolled through a transform and clipped, it draws exactly what shows, at the bottom of a million rows too", () => {
    const { scene, rows } = table();
    const scroll = ROWS * ROW - 400;
    rows.show({ transform: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 100 - scroll }, visible: { x: 50, y: 100, width: 300, height: 400 }, clip: true });
    const ids = scene.groupOps("table");
    expect(ids.length).toBe(20);
    expect(scene.getGroup(`table/r${ROWS - 1}`)?.meta).toEqual({ row: ROWS - 1 });
    // The last row is drawn at the bottom of the box, and nothing paints outside it.
    const hit = scene.hitTest({ x: 60, y: 495 });
    expect(hit[0]?.groups[0]).toBe(`table/r${ROWS - 1}`);
    expect(scene.hitTest({ x: 60, y: 99 })).toEqual([]);
  });

  test("clipped, only the rows crossing the edge carry the clip", () => {
    const { scene, rows } = table();
    rows.show({ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: -10 }, visible: { x: 0, y: 0, width: 300, height: 400 }, clip: true });
    const clipped = scene.groupOps("table").filter((id) => scene.get(id)!.clip);
    // Row 0 sticks out at the top and row 20 at the bottom.
    expect(clipped.map((id) => scene.groupChain(id)[0])).toEqual(["table/r0", "table/r20"]);
  });

  test("rows keep their ids across redraws, so events reach the same row", () => {
    const { scene, rows } = table();
    const view = (scroll: number) => ({ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: -scroll }, visible: { x: 0, y: 0, width: 300, height: 400 }, clip: true });
    rows.show(view(0));
    const router = new EventRouter(scene);
    const clicked: string[] = [];
    router.on("*", "click", (e) => clicked.push(e.path[1]!));
    rows.show(view(ROW * 10));
    router.pointerDown({ x: 10, y: 5, button: 0 });
    router.pointerUp({ x: 10, y: 5, button: 0 });
    expect(clicked).toEqual(["table/r10"]);
  });

  test("bind draws into a rebuilt scene", () => {
    const { scene, rows } = table();
    rows.show({ visible: { x: 0, y: 0, width: 300, height: 400 } });
    const copy = new Scene({ version: 1, ops: [] });
    rows.bind(copy);
    expect(copy.groupOps("table").length).toBe(scene.groupOps("table").length);
  });

  test("a group under a parent stays in it", () => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "frame" });
    ctx.fillRect(0, 0, 10, 10);
    ctx.endGroup();
    const scene = new Scene(ctx.getDocument());
    const rows = new VirtualGroup(scene, { id: "rows", parent: "frame", extent: { x: 0, y: 0, width: 10, height: 1000 }, draw: (c, w) => c.fillRect(0, w.y, 10, w.height) });
    rows.show({ visible: { x: 0, y: 0, width: 10, height: 10 } });
    expect(scene.groupChain("rows")).toEqual(["frame"]);
    expect(scene.getGroup("rows")?.meta).toEqual({ virtual: true });
  });
});
