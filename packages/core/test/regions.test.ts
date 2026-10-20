import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { labelRegions, regionRings, traceBorders, traceRegion, traceRegionPath } from "../src/geometry/regions";
import { traceMask } from "../src/geometry/trace";
import type { Point } from "../src/types";

/** Nonzero winding of a point by rings. */
const winding = (rings: readonly (readonly Point[])[], p: Point): number => {
  let w = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y && b.y > p.y && cross > 0) w++;
      else if (a.y > p.y && b.y <= p.y && cross < 0) w--;
    }
  }
  return w;
};

/** A picture from rows of characters, one value per character; "." is empty. */
const picture = (rows: string[]): { width: number; height: number; values: Int32Array } => {
  const width = rows[0]!.length;
  const height = rows.length;
  const values = new Int32Array(width * height);
  rows.forEach((row, y) => [...row].forEach((c, x) => (values[y * width + x] = c === "." ? -1 : c.charCodeAt(0) - 97)));
  return { width, height, values };
};

/** Overlapping blobs in four values: curved borders, junctions where three meet, islands and holes. */
const blobs = (width = 64, height = 48): { width: number; height: number; values: Int32Array } => {
  const values = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      if (Math.hypot(x - 20, y - 20) < 14) v = 1;
      if (Math.hypot(x - 36, y - 24) < 12) v = 2;
      if (Math.hypot(x - 28, y - 30) < 6) v = 3;
      if (Math.hypot(x - 50, y - 10) < 4) v = 1;
      if (Math.hypot(x - 20, y - 18) < 3) v = 0;
      values[y * width + x] = v;
    }
  }
  return { width, height, values };
};

describe("labelRegions", () => {
  test("4-connectivity keeps areas that touch at a corner apart; 8 joins them", () => {
    const { width, height, values } = picture(["aab", "aab", "bba"]);
    const four = labelRegions(width, height, values);
    // The two a's, the b's on the right, the b's below: corner contacts don't join.
    expect(four.regions.map((r) => [r.value, r.area])).toEqual([
      [0, 4],
      [1, 2],
      [1, 2],
      [0, 1],
    ]);
    const eight = labelRegions(width, height, values, { connectivity: 8 });
    // With corners joining, the lone a joins the big one and the two b's join each other.
    expect(eight.regions.map((r) => [r.value, r.area])).toEqual([
      [0, 5],
      [1, 4],
    ]);
  });

  test("regions know their bounds and neighbours, with border lengths; empty pixels belong to none", () => {
    const { width, height, values } = picture(["aaaa", "abba", "aaa.", "...."]);
    const map = labelRegions(width, height, values);
    expect(map.regions).toHaveLength(2);
    const [a, b] = map.regions;
    expect(b!.bounds).toEqual({ x: 1, y: 1, width: 2, height: 1 });
    expect(a!.bounds).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    // b is surrounded by a: 2 above, 2 below, one each side.
    expect([...b!.neighbors]).toEqual([[0, 6]]);
    expect(map.labels[15]).toBe(-1);
    expect(a!.neighbors.get(-1)).toBeGreaterThan(0);
  });

  test("ids follow the scan order, so the same values give the same ids", () => {
    const { width, height, values } = blobs();
    const one = labelRegions(width, height, values);
    const two = labelRegions(width, height, values);
    expect(two.regions.map((r) => [r.value, r.area, r.bounds])).toEqual(one.regions.map((r) => [r.value, r.area, r.bounds]));
  });
});

describe("tracing", () => {
  test("a region traced within its bounds fills exactly its pixels, holes included", () => {
    const { width, height, values } = blobs();
    const map = labelRegions(width, height, values);
    for (const region of map.regions) {
      const rings = traceRegion(map, region.id);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          expect(winding(rings, { x: x + 0.5, y: y + 0.5 }) !== 0).toBe(map.labels[y * width + x] === region.id);
        }
      }
    }
  });

  test("traceMask in a box matches tracing the whole image", () => {
    const { width, height, values } = blobs();
    const inside = (x: number, y: number) => values[y * width + x] === 2;
    const whole = traceMask(width, height, inside);
    const boxed = traceMask(width, height, inside, { bounds: { x: 20, y: 10, width: 30, height: 30 } });
    const area = (rings: Point[][]) => rings.reduce((s, r) => s + r.reduce((t, p, i) => t + p.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * p.y, 0) / 2, 0);
    expect(area(boxed)).toBe(area(whole));
    expect(traceMask(width, height, inside, { bounds: { x: 0, y: 0, width: 0, height: 5 } })).toEqual([]);
  });
});

describe("shared borders", () => {
  const sample = (width: number, height: number, count: number): Point[] => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: count }, () => ({ x: random() * width, y: random() * height }));
  };

  test("exact borders rebuild every region pixel for pixel", () => {
    const { width, height, values } = blobs();
    const map = labelRegions(width, height, values);
    const outlines = traceBorders(map, { tolerance: 0 });
    for (const region of map.regions) {
      const rings = regionRings(outlines, region.id);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          expect(winding(rings, { x: x + 0.5, y: y + 0.5 }) !== 0).toBe(map.labels[y * width + x] === region.id);
        }
      }
    }
  });

  test("simplified borders still tile the image: every point is in exactly one region", () => {
    const { width, height, values } = blobs();
    const map = labelRegions(width, height, values);
    const outlines = traceBorders(map, { tolerance: 1 });
    const rings = map.regions.map((r) => regionRings(outlines, r.id));
    for (const p of sample(width, height, 4000)) {
      const inside = rings.filter((r) => winding(r, p) !== 0).length;
      expect(inside).toBe(1);
    }
    // And they are simpler than the pixel edges.
    const points = outlines.borders.reduce((n, b) => n + b.points.length, 0);
    const exact = outlines.borders.reduce((n, b) => n + b.exact.length, 0);
    expect(points).toBeLessThan(exact / 2);
  });

  test("on noise, where borders run close, they still tile; below 0.5 every pixel's center stays its own", () => {
    let seed = 3;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const width = 60;
    const height = 40;
    const values = new Int32Array(width * height).map(() => Math.floor(random() * 4));
    const map = labelRegions(width, height, values);
    for (const tolerance of [0.4, 1.5]) {
      const outlines = traceBorders(map, { tolerance });
      const rings = map.regions.map((r) => regionRings(outlines, r.id));
      for (const p of sample(width, height, 3000)) expect(rings.filter((r) => winding(r, p) !== 0).length).toBe(1);
      let wrong = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) if (winding(rings[map.labels[y * width + x]!]!, { x: x + 0.5, y: y + 0.5 }) === 0) wrong++;
      }
      if (tolerance < 0.5) expect(wrong).toBe(0);
    }
  });

  test("borders that would cross are smoothed less, not dropped to pixel staircases", () => {
    let seed = 3;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const width = 160;
    const height = 120;
    const values = new Int32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = Math.floor((Math.sin(x / 9 + random() * 0.6) + Math.cos(y / 7 + x / 13) + 2) * 2);
    const map = labelRegions(width, height, values);
    const outlines = traceBorders(map, { tolerance: 0.75, curves: true });
    // Borders keep curves, at worst with their pixel corners cut; hardly any is left a staircase.
    expect(outlines.borders.filter((b) => !b.pieces).length).toBeLessThan(outlines.borders.length / 500);
    const rings = map.regions.map((r) => regionRings(outlines, r.id));
    for (const p of sample(width, height, 1000)) expect(rings.filter((r) => winding(r, p) !== 0).length).toBe(1);
  });

  test("each border separates two regions, and both walk it", () => {
    const { width, height, values } = blobs();
    const map = labelRegions(width, height, values);
    const outlines = traceBorders(map);
    for (const border of outlines.borders) {
      expect(border.left).not.toBe(border.right);
      for (const side of [border.left, border.right]) {
        if (side < 0) continue;
        expect(outlines.rings[side]!.some((ring) => ring.some((use) => use.border === border.id))).toBe(true);
      }
    }
    // The island inside region 1's hole is a closed border with no junction.
    expect(outlines.borders.some((b) => b.closed)).toBe(true);
  });

  test("curved borders, drawn as paths, still tile the image", () => {
    const { width, height, values } = blobs();
    const map = labelRegions(width, height, values);
    const outlines = traceBorders(map, { curves: true });
    expect(outlines.borders.some((b) => b.pieces?.some((p) => p.c1.x !== p.from.x || p.c1.y !== p.from.y))).toBe(true);
    const ctx = new RecordingContext();
    for (const region of map.regions) {
      ctx.beginGroup({ id: `r${region.id}` });
      ctx.beginPath();
      traceRegionPath(ctx, outlines, region.id);
      ctx.fill();
      ctx.endGroup();
    }
    const scene = new Scene(ctx.getDocument());
    let misses = 0;
    for (const p of sample(width, height, 3000)) if (scene.hitTest(p).length !== 1) misses++;
    // Only points within a flattening tolerance of a border can land in two or none.
    expect(misses).toBeLessThan(15);
  });
});
