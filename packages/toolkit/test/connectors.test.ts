import { describe, expect, test } from "bun:test";
import { RecordingContext, type TextMeasure } from "canvas-ir";
import { arrowPath, closeBox, drawArrow, edgePoint, fromMeta, inBox, route, toMeta, type Connector } from "../src/index";

const measureText = (text: string): TextMeasure => ({
  width: text.length * 6,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: text.length * 6,
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 9,
  fontBoundingBoxDescent: 3,
});

const box = { x: 0, y: 0, width: 100, height: 50 };

describe("connectors", () => {
  test("an end leaves its box on the side facing the other end, a gap past the edge", () => {
    expect(edgePoint(box, { x: 500, y: 25 }, 10)).toEqual({ x: 110, y: 25 });
    expect(edgePoint(box, { x: 50, y: -300 }, 0)).toEqual({ x: 50, y: 0 });
    expect(edgePoint(box, { x: 50, y: 25 })).toEqual({ x: 50, y: 25 });
  });

  test("an arrow's ends follow what they hold, and a loose end stays where it is", () => {
    const c: Connector = { kind: "arrow", from: { key: "a", x: 0, y: 0 }, to: { x: 400, y: 25 }, bend: 0, color: "#000", seed: 1 };
    const boxes: Record<string, typeof box> = { a: box };
    const first = route(c, (k) => boxes[k] ?? null);
    expect(first.to).toEqual({ x: 400, y: 25 });
    expect(first.from.x).toBeCloseTo(116);
    boxes["a"] = { ...box, y: 200 };
    const moved = route(c, (k) => boxes[k] ?? null);
    expect(moved.from.y).toBeGreaterThan(150);
    // Gone from the board: the end is left where it was last drawn.
    expect(route(c, () => null).from).toMatchObject({ x: 0, y: 0 });
  });

  test("a bow turns where the ends leave their boxes", () => {
    const c: Connector = { kind: "arrow", from: { key: "a", x: 0, y: 0 }, to: { key: "b", x: 0, y: 0 }, bend: 0.4, color: "#000", seed: 1 };
    const boxes: Record<string, typeof box> = { a: box, b: { ...box, x: 400 } };
    const bowed = route(c, (k) => boxes[k] ?? null);
    const straight = route({ ...c, bend: 0 }, (k) => boxes[k] ?? null);
    expect(straight.from.y).toBeCloseTo(25);
    expect(bowed.from.y).not.toBeCloseTo(25);
  });

  test("a connector goes into group meta and comes back, and anything else doesn't", () => {
    const c: Connector = { kind: "ring", from: { key: "board:x", x: 1, y: 2 }, bend: 0, color: "#f00", seed: 3, word: "look" };
    expect(fromMeta({ connector: toMeta(c) })).toEqual(c);
    expect(fromMeta({ connector: { kind: "line" } })).toBeNull();
    expect(fromMeta(undefined)).toBeNull();
    const styled: Connector = { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, bend: 0, color: "#000", seed: 1, style: { look: "clean", path: "elbow", dash: [6, 4], tail: "dot" } };
    expect(fromMeta({ connector: toMeta(styled) })).toEqual(styled);
  });

  test("a right-angled arrow leaves the middles of the sides that face each other", () => {
    const c: Connector = { kind: "arrow", from: { key: "a", x: 0, y: 0 }, to: { key: "b", x: 0, y: 0 }, bend: 0.3, color: "#000", seed: 1, style: { path: "elbow", gap: 4 } };
    const boxes: Record<string, typeof box> = { a: box, b: { ...box, x: 300, y: 200 } };
    const { from, to, across } = route(c, (k) => boxes[k] ?? null);
    expect(from).toEqual({ x: 104, y: 25 });
    expect(to).toEqual({ x: 296, y: 225 });
    // The ends are almost as far apart down as across, but they face across, so the path leaves across.
    const p = arrowPath(from, to, c, across);
    expect(p.points).toEqual([from, { x: 200, y: 25 }, { x: 200, y: 225 }, to]);
    // It arrives going right, and leaves going right (its tail points back, left).
    expect(p.headAngle).toBeCloseTo(0);
    expect(Math.abs(p.tailAngle)).toBeCloseTo(Math.PI);
    expect(p.middle).toEqual({ x: 200, y: 125 });
  });

  test("a straight arrow ignores its bow", () => {
    const c: Connector = { kind: "arrow", from: { key: "a", x: 0, y: 0 }, to: { key: "b", x: 0, y: 0 }, bend: 0.4, color: "#000", seed: 1, style: { path: "straight" } };
    const boxes: Record<string, typeof box> = { a: box, b: { ...box, x: 400 } };
    const { from, to } = route(c, (k) => boxes[k] ?? null);
    expect(from.y).toBeCloseTo(25);
    expect(to.y).toBeCloseTo(25);
    expect(arrowPath(from, to, c).curve).toBeNull();
  });

  test("a clean arrow is drawn dashed and thin, with a filled head, a dot for a tail and its label on a pill", () => {
    const ctx = new RecordingContext({ measureText });
    drawArrow(ctx, { x: 0, y: 0 }, { x: 200, y: 0 }, { bend: 0, color: "#123456", seed: 1, word: "sends", style: { look: "clean", path: "straight", dash: [6, 4], head: "filled", tail: "dot", labelBackground: "#eeeeee" } });
    const ops = ctx.getDocument().ops;
    const strokes = ops.filter((o) => o.kind === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ stroke: { lineWidth: 2, lineDash: [6, 4] } });
    const fills = ops.filter((o) => o.kind === "fill");
    // The head, the tail's dot and the label's pill.
    expect(fills).toHaveLength(3);
    expect(fills.some((f) => JSON.stringify(f).includes("#eeeeee"))).toBe(true);
    expect(ops.find((o) => o.kind === "text")).toMatchObject({ text: "sends", x: 100, y: 0 });
  });

  test("the hand-drawn arrow is unchanged without a style: thick, with an open head", () => {
    const ctx = new RecordingContext({ measureText });
    drawArrow(ctx, { x: 0, y: 0 }, { x: 200, y: 0 }, { bend: 0.1, color: "#000", seed: 3 });
    const ops = ctx.getDocument().ops;
    expect(ops.map((o) => o.kind)).toEqual(["stroke", "stroke"]);
    expect(ops[0]).toMatchObject({ stroke: { lineWidth: 7 } });
  });
});

describe("window parts", () => {
  test("the close button sits in the middle of the title bar, and points inside it hit it", () => {
    const b = closeBox(40);
    expect(b.y + b.height / 2).toBe(20);
    expect(inBox({ x: b.x + 1, y: b.y + 1 }, b)).toBe(true);
    expect(inBox({ x: b.x - 1, y: b.y }, b)).toBe(false);
  });
});
