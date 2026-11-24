import { describe, expect, test } from "bun:test";
import { closeBox, edgePoint, fromMeta, inBox, route, toMeta, type Connector } from "../src/index";

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
