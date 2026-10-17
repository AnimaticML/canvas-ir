import { describe, expect, test } from "bun:test";
import { EventRouter, RecordingContext, Scene, accessibilityTree } from "../src";

const board = () => {
  // Text 8 units an em wide, 16 tall: enough for bounds.
  const ctx = new RecordingContext({
    measureText: (text) => ({
      width: text.length * 8,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 8,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 4,
      fontBoundingBoxAscent: 13,
      fontBoundingBoxDescent: 4,
    }),
  });
  ctx.font = "16px sans-serif";
  ctx.fillText("Quarterly report", 10, 20);
  ctx.fillText("for the board", 10, 40);
  ctx.beginGroup({ id: "chart", meta: { role: "figure", label: "Sales by month" } });
  ctx.fillRect(0, 60, 200, 100);
  ctx.beginGroup({ id: "bar-jan", meta: { role: "img", label: "January: 42" } });
  ctx.fillRect(10, 100, 20, 60);
  ctx.endGroup();
  ctx.beginGroup({ id: "decoration" });
  ctx.fillText("Jan", 10, 175);
  ctx.endGroup();
  ctx.endGroup();
  ctx.beginGroup({ id: "ok", meta: { role: "button" } });
  ctx.fillRect(220, 60, 80, 30);
  ctx.fillText("Save", 240, 80);
  ctx.endGroup();
  ctx.beginGroup({ id: "size", meta: { role: "slider", label: "Size", value: 14, min: 10, max: 20 } });
  ctx.fillRect(220, 100, 80, 6);
  ctx.endGroup();
  ctx.embed(0, 200, 100, 50, { type: "video", label: "Intro video" });
  return new Scene(ctx.getDocument());
};

describe("accessibilityTree", () => {
  test("reads roles, labels, values and text in drawing order", () => {
    const tree = accessibilityTree(board());
    const brief = (n: (typeof tree)[number]): unknown => [n.role, n.label, ...(n.value !== undefined ? [n.value, n.min, n.max] : []), ...(n.children.length ? [n.children.map(brief)] : [])];
    expect(tree.map(brief)).toEqual([
      ["text", "Quarterly report for the board"],
      ["figure", "Sales by month", [["img", "January: 42"], ["text", "Jan"]]],
      // A button with no label is named by its text, which isn't read again.
      ["button", "Save"],
      ["slider", "Size", 14, 10, 20],
      ["group", "Intro video"],
    ]);
    expect(tree[2]!.bounds).toEqual({ x: 220, y: 60, width: 80, height: 30 });
  });

  test("keyboard focus moves through the router to components", () => {
    const scene = board();
    const router = new EventRouter(scene);
    const seen: (string | null)[] = [];
    router.on("*", "focus", (e) => seen.push(e.target));
    router.focusOn("ok");
    const keys: string[] = [];
    router.on("ok", "keydown", (e) => keys.push((e.input as { key: string }).key));
    router.keyDown({ key: "Enter" });
    router.focusOn(null);
    expect(seen).toEqual(["ok", null]);
    expect(keys).toEqual(["Enter"]);
    expect(router.focused).toBeNull();
  });
});
