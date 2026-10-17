import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { simplifyRing, traceImageOutline, traceMask } from "../src/geometry/trace";
import { distanceToRing, insideFill } from "../src/geometry/predicates";
import type { Point } from "../src/types";

/** A seeded generator, so failures repeat. */
const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** RGBA pixels whose alpha is set by `alpha(x, y)`. */
const pixels = (width: number, height: number, alpha: (x: number, y: number) => number) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = alpha(x, y);
  return { width, height, data };
};

/** Every pixel whose center is farther than `margin` from the rings is inside them exactly when `opaque` says so. */
const expectAgrees = (rings: Point[][], width: number, height: number, opaque: (x: number, y: number) => boolean, margin: number): number => {
  let checked = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = { x: x + 0.5, y: y + 0.5 };
      if (margin > 0 && rings.some((r) => distanceToRing(c, r) <= margin)) continue;
      checked++;
      if (insideFill(c, rings, "nonzero") !== opaque(x, y)) throw new Error(`pixel ${x},${y} disagrees`);
    }
  }
  return checked;
};

describe("tracing", () => {
  test("pixel-edge rings fill exactly the mask, for random masks with holes and corner-touching pixels", () => {
    const next = random(7);
    for (let round = 0; round < 40; round++) {
      const w = 5 + Math.floor(next() * 30);
      const h = 5 + Math.floor(next() * 30);
      const density = 0.2 + next() * 0.6;
      const mask = Array.from({ length: w * h }, () => next() < density);
      const inside = (x: number, y: number) => mask[y * w + x]!;
      const rings = traceMask(w, h, inside);
      expect(expectAgrees(rings, w, h, inside, 0)).toBe(w * h);
    }
  });

  test("outer rings run clockwise and holes counterclockwise", () => {
    // A 6×6 square with a 2×2 hole.
    const rings = traceMask(8, 8, (x, y) => x >= 1 && x < 7 && y >= 1 && y < 7 && !(x >= 3 && x < 5 && y >= 3 && y < 5));
    const area = (r: Point[]) => r.reduce((a, p, i) => a + p.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * p.y, 0) / 2;
    const simple = rings.map((r) => simplifyRing(r, 0.01));
    expect(simple.map((r) => r.length).sort()).toEqual([4, 4]);
    expect(simple.map(area).sort((a, b) => a - b)).toEqual([-4, 36]);
  });

  test("a simplified outline agrees with the alpha channel away from its edge", () => {
    // A ring-shaped blob with soft edges, plus specks.
    const next = random(3);
    const alpha = (x: number, y: number) => {
      const d = Math.hypot(x + 0.5 - 60, y + 0.5 - 50);
      const ring = Math.max(0, Math.min(1, 40 - d)) * Math.max(0, Math.min(1, d - 15));
      return next() < 0.003 ? 255 : Math.round(ring * 255);
    };
    const image = pixels(120, 100, alpha);
    const opaque = (x: number, y: number) => image.data[(y * 120 + x) * 4 + 3]! >= 128;
    for (const tolerance of [0.5, 0.75, 1.5]) {
      const rings = traceImageOutline(image, { tolerance });
      const checked = expectAgrees(rings, 120, 100, opaque, tolerance);
      expect(checked).toBeGreaterThan(120 * 100 * 0.7);
      // Simplifying keeps the shape small: a circle's staircase becomes a polygon.
      const big = rings.filter((r) => r.length > 4);
      expect(big).toHaveLength(2);
      expect(big.map((r) => r.length).every((n) => n < 150)).toBe(true);
    }
    // Specks are dropped by area.
    expect(traceImageOutline(image, { minArea: 4 }).length).toBe(2);
  });
});

describe("images with outlines", () => {
  // A 100×100 image: a disk of radius 40 at its center, with a hole of radius 15.
  const outline = traceImageOutline(
    pixels(100, 100, (x, y) => {
      const d = Math.hypot(x + 0.5 - 50, y + 0.5 - 50);
      return d < 40 && d > 15 ? 255 : 0;
    }),
  );
  const scene = (draw: (ctx: RecordingContext, img: object) => void) => {
    const img = {};
    const ctx = new RecordingContext({ describeImage: () => ({ src: "donut.png", width: 100, height: 100, outline }) });
    draw(ctx, img);
    return new Scene(ctx.getDocument());
  };

  test("hit tests, bounds and regions follow the silhouette under a transform", () => {
    const s = scene((ctx, img) => {
      ctx.translate(200, 100);
      ctx.rotate(Math.PI / 6);
      ctx.drawImage(img as CanvasImageSource, -50, -50, 200, 200); // scaled by 2 around (50, 50)
    });
    const at = (lx: number, ly: number) => {
      const c = Math.cos(Math.PI / 6);
      const sn = Math.sin(Math.PI / 6);
      return { x: 200 + lx * c - ly * sn, y: 100 + lx * sn + ly * c };
    };
    const center = { lx: 50, ly: 50 };
    expect(s.hitTest(at(center.lx, center.ly))).toHaveLength(0); // the hole
    expect(s.hitTest(at(center.lx + 50, center.ly))).toHaveLength(1); // in the ring (radius 25 px → 50 world)
    expect(s.hitTest(at(-45, -45))).toHaveLength(0); // inside the box, outside the disk
    const b = s.bounds("o0")!;
    expect(b.width).toBeCloseTo(160, -1);
    const region = s.region("o0")!;
    expect(region.rings).toHaveLength(2);
    const hit = s.closestPoint(at(center.lx, center.ly))!;
    // The hole's radius is 15 px, scaled by 2; simplifying may cut corners by the tolerance, also scaled.
    expect(Math.abs(hit.distance - 30)).toBeLessThanOrEqual(1.5);
  });

  test("a source crop cuts the silhouette", () => {
    const s = scene((ctx, img) => ctx.drawImage(img as CanvasImageSource, 0, 0, 50, 100, 0, 0, 50, 100));
    expect(s.hitTest({ x: 20, y: 50 })).toHaveLength(1);
    expect(s.hitTest({ x: 52, y: 50 })).toHaveLength(0);
    expect(s.bounds("o0")!.x + s.bounds("o0")!.width).toBeCloseTo(50);
  });

  test("outlines survive serialization", async () => {
    const { serializeDocument, deserializeDocument } = await import("../src/serialization");
    const s = scene((ctx, img) => ctx.drawImage(img as CanvasImageSource, 0, 0));
    const back = deserializeDocument(serializeDocument(s.document));
    expect((back.ops[0] as { image: { outline: unknown } }).image.outline).toEqual(outline);
  });
});
