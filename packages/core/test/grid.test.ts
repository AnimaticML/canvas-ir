import { describe, expect, test } from "bun:test";
import type { Box } from "../src/geometry/bounds";
import { Grid } from "../src/geometry/grid";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";

let seed = 7;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

const randomBox = (): Box => {
  // Sizes from a hundredth of a unit to a million, anywhere within a billion.
  const size = 10 ** (random() * 8 - 2);
  const x = (random() - 0.5) * 2e9 * random() ** 4;
  const y = (random() - 0.5) * 2e9 * random() ** 4;
  return { minX: x, minY: y, maxX: x + size * random(), maxY: y + size * random() };
};

const meets = (a: Box, b: Box): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

describe("hierarchical grid", () => {
  test("a query finds every item whose box meets it, at any scale, after moves and removals", () => {
    const grid = new Grid<number>(1 / 64);
    const boxes = new Map<number, Box>();
    for (let i = 0; i < 3000; i++) {
      const box = randomBox();
      boxes.set(i, box);
      grid.insert(i, box);
    }
    for (let round = 0; round < 300; round++) {
      // Move some, remove some, add some.
      const id = Math.floor(random() * 3000);
      if (random() < 0.2) {
        grid.remove(id);
        boxes.delete(id);
      } else {
        const b = boxes.get(id) ?? randomBox();
        const dx = (random() - 0.5) * 10 ** (random() * 6);
        const moved = random() < 0.5 ? { minX: b.minX + dx, minY: b.minY - dx, maxX: b.maxX + dx, maxY: b.maxY - dx } : randomBox();
        boxes.set(id, moved);
        grid.insert(id, moved);
      }
      const query = randomBox();
      const found = grid.query(query);
      for (const [i, b] of boxes) if (meets(b, query)) expect(found.has(i)).toBe(true);
      for (const i of found) expect(boxes.has(i)).toBe(true);
    }
  });

  test("infinite boxes are always candidates", () => {
    const grid = new Grid<string>(1);
    grid.insert("everywhere", { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });
    grid.insert("here", { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect([...grid.query({ minX: 1e12, minY: 1e12, maxX: 1e12 + 1, maxY: 1e12 + 1 })]).toEqual(["everywhere"]);
  });
});

describe("scene index", () => {
  const board = (): Scene => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "a" });
    ctx.fillRect(0, 0, 10, 10);
    ctx.beginGroup({ id: "b" });
    ctx.fillRect(20, 0, 10, 10);
    ctx.endGroup();
    ctx.endGroup();
    ctx.fillRect(40, 0, 10, 10);
    return new Scene(ctx.getDocument());
  };

  test("opsIn finds ops by their index box, in drawing order", () => {
    const scene = board();
    expect(scene.opsIn({ x: 5, y: 5, width: 40, height: 1 }).map((id) => scene.indexOf(id))).toEqual([0, 1, 2]);
    expect(scene.opsIn({ x: 12, y: 0, width: 5, height: 5 })).toEqual([]);
  });

  test("changes report where an op was and is", () => {
    const scene = board();
    const seen: string[] = [];
    const off = scene.onChange((c) => seen.push(`${c.id} ${c.before?.box?.x ?? "-"} ${c.after?.box?.x ?? "-"}`));
    const [first, second, third] = scene.document.ops.map((op) => op.id);
    scene.transform("a", { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
    scene.remove(third!);
    off();
    scene.remove(first!);
    expect(seen).toEqual([`${first} 0 100`, `${second} 20 120`, `${third} 40 -`]);
  });

  test("group contents follow inserts, regrouping and removal", () => {
    const scene = board();
    const [first, second] = scene.document.ops.map((op) => op.id);
    expect(scene.groupOps("a")).toEqual([first!, second!]);
    scene.replace({ ...scene.get(second!)!, group: "a" });
    expect(scene.groupOps("b")).toEqual([]);
    scene.remove("a");
    expect(scene.document.ops.length).toBe(1);
    expect(scene.getGroup("b")).toBeUndefined();
  });
});
