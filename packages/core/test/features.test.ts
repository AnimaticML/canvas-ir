import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { normalizeRings, offsetRings, outlineBand } from "../src/geometry/offset";
import { distanceToRing, insideFill } from "../src/geometry/predicates";
import type { Point } from "../src/types";

const scene = (draw: (ctx: RecordingContext) => void) => {
  const ctx = new RecordingContext();
  draw(ctx);
  return new Scene(ctx.getDocument());
};

describe("transparent paints", () => {
  test("fills in a fully transparent color don't hit or block, unless asked for", () => {
    const s = scene((ctx) => {
      ctx.fillStyle = "#08f";
      ctx.fillRect(0, 0, 100, 100);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.beginPath();
      ctx.arc(50, 50, 30, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(0, 0, 100, 0);
      g.addColorStop(0, "transparent");
      g.addColorStop(1, "rgba(255, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 10, 10);
    });
    expect(s.hitTest({ x: 50, y: 50 }).map((h) => h.id)).toEqual(["o0"]);
    expect(s.hitTest({ x: 50, y: 50 }, { includeInvisible: true }).map((h) => h.id)).toEqual(["o1", "o0"]);
    expect(s.hitTest({ x: 5, y: 5 }).map((h) => h.id)).toEqual(["o0"]);
    expect(s.queryRect({ x: 40, y: 40, width: 20, height: 20 })).toEqual(["o0"]);
  });

  test("a transparent paint drawn with copy still counts, since it clears", () => {
    const s = scene((ctx) => {
      ctx.globalCompositeOperation = "copy";
      ctx.fillStyle = "transparent";
      ctx.fillRect(0, 0, 10, 10);
    });
    expect(s.hitTest({ x: 5, y: 5 })).toHaveLength(1);
  });
});

describe("anchors", () => {
  test("a rect has its corners, edge midpoints and box points", () => {
    const s = scene((ctx) => ctx.strokeRect(0, 0, 40, 20));
    const of = (kind: string) => s.anchors("o0").filter((a) => a.kind === kind).map((a) => [a.point.x, a.point.y]);
    expect(of("vertex")).toEqual([[0, 0], [40, 0], [40, 20], [0, 20]]);
    expect(of("midpoint")).toEqual([[20, 0], [40, 10], [20, 20], [0, 10]]);
    expect(of("bounds")).toContainEqual([20, 10]);
  });

  test("arcs give their center and the extremes inside their sweep, under a transform", () => {
    const s = scene((ctx) => {
      ctx.translate(100, 100);
      ctx.scale(2, 1);
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI); // the lower half, drawn clockwise on screen
      ctx.stroke();
    });
    const anchors = s.anchors("o0");
    expect(anchors.find((a) => a.kind === "center")!.point).toEqual({ x: 100, y: 100 });
    const extremes = anchors.filter((a) => a.kind === "extreme").map((a) => a.point);
    expect(extremes).toHaveLength(1);
    expect(extremes[0]!.x).toBeCloseTo(100, 9);
    expect(extremes[0]!.y).toBeCloseTo(110, 9);
  });

  test("a cubic's extremes are where its tangent is level", () => {
    const s = scene((ctx) => {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(0, 40, 40, 40, 40, 0);
      ctx.stroke();
    });
    const extreme = s.anchors("o0").filter((a) => a.kind === "extreme");
    expect(extreme).toHaveLength(1);
    expect(extreme[0]!.point.x).toBeCloseTo(20, 9);
    expect(extreme[0]!.point.y).toBeCloseTo(30, 9);
  });

  test("a group has its ops' anchors and its own bounds", () => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: "g" });
    ctx.fillRect(0, 0, 10, 10);
    ctx.fillRect(20, 0, 10, 10);
    ctx.endGroup();
    const s = new Scene(ctx.getDocument());
    expect(s.anchors("g").filter((a) => a.kind === "bounds").map((a) => a.point)).toContainEqual({ x: 15, y: 5 });
  });
});

describe("intersections", () => {
  test("two crossing rects meet at two points, exactly", () => {
    const s = scene((ctx) => {
      ctx.strokeRect(0, 0, 40, 40);
      ctx.strokeRect(20, 10, 40, 20);
    });
    const points = s.intersections("o0", "o1").sort((a, b) => a.y - b.y);
    expect(points).toEqual([{ x: 40, y: 10 }, { x: 40, y: 30 }]);
  });

  test("a circle and a line meet within the scene's tolerance", () => {
    const s = scene((ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-100, 30);
      ctx.lineTo(100, 30);
      ctx.stroke();
    });
    const points = s.intersections("o0", "o1").sort((a, b) => a.x - b.x);
    expect(points).toHaveLength(2);
    expect(Math.abs(points[0]!.x + 40)).toBeLessThan(0.2);
    expect(Math.abs(points[1]!.x - 40)).toBeLessThan(0.2);
  });
});

describe("snapping", () => {
  const s = scene((ctx) => {
    ctx.strokeRect(0, 0, 40, 40);
    ctx.strokeRect(20, 10, 40, 20);
  });

  test("a vertex within the radius beats a nearer crossing, and the outline is the last resort", () => {
    expect(s.snap({ x: 41, y: 12 }, { radius: 5 })).toMatchObject({ kind: "intersection", point: { x: 40, y: 10 } });
    const snap = s.snap({ x: 39, y: 8 }, { radius: 12 })!;
    expect(snap.kind).toBe("vertex");
    expect(snap.point).toEqual({ x: 40, y: 0 });
    expect(s.snap({ x: 5, y: 1 }, { radius: 2 })).toMatchObject({ kind: "path", point: { x: 5, y: 0 } });
    expect(s.snap({ x: 100, y: 100 }, { radius: 2 })).toBeNull();
  });

  test("kinds and exclusions narrow the candidates", () => {
    expect(s.snap({ x: 39, y: 8 }, { radius: 12, kinds: ["intersection"] })).toMatchObject({ point: { x: 40, y: 10 } });
    expect(s.snap({ x: 41, y: 12 }, { radius: 5, exclude: ["o1"] })).toMatchObject({ kind: "path", ids: ["o0"] });
  });
});

describe("lasso", () => {
  test("a polygon selects what it touches, or only what it encloses", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(30, 0, 10, 10);
      ctx.fillRect(0, 30, 10, 10);
    });
    const triangle: Point[] = [{ x: -5, y: -5 }, { x: 80, y: -5 }, { x: -5, y: 36 }];
    expect(s.queryPolygon(triangle)).toEqual(["o0", "o1", "o2"]);
    expect(s.queryPolygon(triangle, "enclosed")).toEqual(["o0", "o1"]);
    // A polygon wholly inside an op touches it.
    expect(s.queryPolygon([{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 5, y: 8 }])).toEqual(["o0"]);
  });
});

describe("offsetting", () => {
  const square: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const hole: Point[] = [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }];

  test("normalizing makes an even-odd hole a nonzero hole", () => {
    const rings = normalizeRings([square, hole], "evenodd");
    expect(insideFill({ x: 50, y: 50 }, rings, "nonzero")).toBe(false);
    expect(insideFill({ x: 20, y: 20 }, rings, "nonzero")).toBe(true);
    // Same-direction nested rings under nonzero: the inner one isn't a hole, so it's dropped.
    expect(normalizeRings([square, hole], "nonzero")).toHaveLength(1);
  });

  test("a grown region holds exactly the points within the distance, away from the edge by the tolerance", () => {
    const rings = [square, hole];
    const grown = offsetRings(rings, 12, { fillRule: "evenodd", tolerance: 0.1 });
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 160 - 30;
    for (let i = 0; i < 4000; i++) {
      const p = { x: random(), y: random() };
      const d = Math.min(...rings.map((r) => distanceToRing(p, r)));
      if (Math.abs(d - 12) < 0.15) continue;
      const expected = insideFill(p, rings, "evenodd") || d <= 12;
      if (insideFill(p, grown, "nonzero") !== expected) throw new Error(`(${p.x}, ${p.y}) at distance ${d}`);
    }
  });

  test("the band along an outline is the points near it, both sides", () => {
    const band = outlineBand([square], 5, 0.1);
    expect(insideFill({ x: 50, y: 3 }, band, "nonzero")).toBe(true);
    expect(insideFill({ x: 50, y: -3 }, band, "nonzero")).toBe(true);
    expect(insideFill({ x: 50, y: 7 }, band, "nonzero")).toBe(false);
    expect(insideFill({ x: 103, y: 103 }, band, "nonzero")).toBe(true);
    expect(insideFill({ x: 104, y: 104 }, band, "nonzero")).toBe(false);
  });
});

describe("intersections against a fine oracle", () => {
  test("random curves under random transforms cross where a 100x finer flattening says", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const between = (lo: number, hi: number) => lo + (hi - lo) * random();
    let checked = 0;
    for (let round = 0; round < 60; round++) {
      const ctx = new RecordingContext();
      for (let k = 0; k < 2; k++) {
        ctx.save();
        ctx.translate(between(80, 120), between(80, 120));
        ctx.rotate(between(0, Math.PI * 2));
        ctx.scale(between(0.5, 2), between(0.5, 2));
        ctx.beginPath();
        switch ((round + k) % 4) {
          case 0:
            ctx.arc(between(-10, 10), between(-10, 10), between(20, 60), between(0, 3), between(3, 7));
            break;
          case 1:
            ctx.moveTo(between(-60, 0), between(-60, 60));
            ctx.bezierCurveTo(between(-60, 60), between(-60, 60), between(-60, 60), between(-60, 60), between(0, 60), between(-60, 60));
            break;
          case 2:
            ctx.ellipse(0, 0, between(20, 60), between(10, 40), between(0, 3), 0, Math.PI * 2);
            break;
          case 3:
            ctx.moveTo(between(-60, 60), between(-60, 60));
            ctx.quadraticCurveTo(between(-60, 60), between(-60, 60), between(-60, 60), between(-60, 60));
            ctx.lineTo(between(-60, 60), between(-60, 60));
            break;
        }
        ctx.stroke();
        ctx.restore();
      }
      const doc = ctx.getDocument();
      const coarse = new Scene(doc).intersections("o0", "o1");
      const fine = new Scene(doc, { tolerance: 0.001 }).intersections("o0", "o1");
      // Every crossing found one way is found the other way too, nearby.
      const near = (p: Point, others: Point[]) => others.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5);
      for (const p of fine) expect(near(p, coarse)).toBe(true);
      for (const p of coarse) expect(near(p, fine)).toBe(true);
      checked += fine.length;
    }
    expect(checked).toBeGreaterThan(30);
  });
});
