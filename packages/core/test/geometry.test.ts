import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene, transformOp } from "../src/geometry/scene";
import { applyToPoint } from "../src/math";
import type { Matrix2D, Point, Rect } from "../src/types";
import { record } from "./helpers";

const scene = (draw: (ctx: RecordingContext) => void): Scene => new Scene(record(draw));

const expectRect = (actual: Rect | null, expected: Rect, digits = 6): void => {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, digits);
  expect(actual!.y).toBeCloseTo(expected.y, digits);
  expect(actual!.width).toBeCloseTo(expected.width, digits);
  expect(actual!.height).toBeCloseTo(expected.height, digits);
};

const ids = (s: Scene, p: Point, tolerance = 0): string[] => s.hitTest(p, { tolerance }).map((h) => h.id);

describe("bounds", () => {
  test("a filled rect", () => {
    const s = scene((ctx) => ctx.fillRect(10, 20, 30, 40));
    expectRect(s.bounds("o0"), { x: 10, y: 20, width: 30, height: 40 });
  });

  test("a circle under rotation and non-uniform scale is exact, not its control box", () => {
    const s = scene((ctx) => {
      ctx.rotate(Math.PI / 4);
      ctx.scale(2, 1);
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
    });
    // The ellipse with semi-axes 20 and 10 rotated 45 degrees has half-extent sqrt((400 + 100) / 2).
    const h = Math.sqrt(250);
    expectRect(s.bounds("o0", "geometry"), { x: -h, y: -h, width: 2 * h, height: 2 * h });
  });

  test("a partial arc includes only the extremes it sweeps", () => {
    const s = scene((ctx) => {
      ctx.arc(0, 0, 10, 0, Math.PI / 2);
      ctx.stroke();
    });
    expectRect(s.bounds("o0", "geometry"), { x: 0, y: 0, width: 10, height: 10 });
  });

  test("a counterclockwise arc sweeps the other way round", () => {
    const s = scene((ctx) => {
      ctx.arc(0, 0, 10, 0, Math.PI / 2, true);
      ctx.stroke();
    });
    expectRect(s.bounds("o0", "geometry"), { x: -10, y: -10, width: 20, height: 20 });
  });

  test("cubic bounds use the curve's extrema", () => {
    const s = scene((ctx) => {
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(0, 100, 100, 100, 100, 0);
      ctx.stroke();
    });
    expectRect(s.bounds("o0", "geometry"), { x: 0, y: 0, width: 100, height: 75 });
  });

  test("stroke paint bounds follow width, caps and the stroke transform", () => {
    const butt = scene((ctx) => {
      ctx.lineWidth = 4;
      ctx.moveTo(0, 0);
      ctx.lineTo(10, 0);
      ctx.stroke();
    });
    expectRect(butt.bounds("o0"), { x: 0, y: -2, width: 10, height: 4 });

    const square = scene((ctx) => {
      ctx.lineWidth = 4;
      ctx.lineCap = "square";
      ctx.moveTo(0, 0);
      ctx.lineTo(10, 0);
      ctx.stroke();
    });
    expectRect(square.bounds("o0"), { x: -2, y: -2, width: 14, height: 4 });

    // The line is built untransformed, then stroked under scale(4, 1): the width stretches in x only.
    const scaled = scene((ctx) => {
      ctx.lineWidth = 2;
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 10);
      ctx.scale(4, 1);
      ctx.stroke();
    });
    expectRect(scaled.bounds("o0"), { x: -4, y: 0, width: 8, height: 10 });
  });

  test("a miter join reaches its tip", () => {
    const s = scene((ctx) => {
      ctx.lineWidth = 2;
      ctx.moveTo(0, 10);
      ctx.lineTo(10, 0);
      ctx.lineTo(20, 10);
      ctx.stroke();
    });
    // A right-angle miter tip lies sqrt(2) half-widths above the vertex.
    expect(s.bounds("o0")!.y).toBeCloseTo(-Math.SQRT2, 6);
  });
});

describe("hitTest", () => {
  test("fill rules", () => {
    const draw = (rule: CanvasFillRule) => (ctx: RecordingContext) => {
      ctx.rect(0, 0, 100, 100);
      ctx.rect(25, 25, 50, 50);
      ctx.fill(rule);
    };
    expect(ids(scene(draw("nonzero")), { x: 50, y: 50 })).toEqual(["o0"]);
    expect(ids(scene(draw("evenodd")), { x: 50, y: 50 })).toEqual([]);
    expect(ids(scene(draw("evenodd")), { x: 10, y: 50 })).toEqual(["o0"]);
  });

  test("topmost first, and tolerance reaches nearby shapes", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 50, 50);
      ctx.fillRect(25, 25, 50, 50);
    });
    expect(ids(s, { x: 30, y: 30 })).toEqual(["o1", "o0"]);
    expect(ids(s, { x: 78, y: 50 })).toEqual([]);
    expect(ids(s, { x: 78, y: 50 }, 3)).toEqual(["o1"]);
  });

  test("a stroke hits within half its width, and caps extend it", () => {
    const s = scene((ctx) => {
      ctx.lineWidth = 10;
      ctx.moveTo(0, 0);
      ctx.lineTo(100, 0);
      ctx.stroke();
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 50);
      ctx.lineTo(100, 50);
      ctx.stroke();
    });
    expect(ids(s, { x: 50, y: 4.9 })).toEqual(["o0"]);
    expect(ids(s, { x: 50, y: 5.1 })).toEqual([]);
    expect(ids(s, { x: -1, y: 0 })).toEqual([]);
    expect(ids(s, { x: -4, y: 50 })).toEqual(["o1"]);
    expect(ids(s, { x: -4, y: 54 })).toEqual([]);
  });

  test("dash gaps are not hit", () => {
    const s = scene((ctx) => {
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 10]);
      ctx.moveTo(0, 0);
      ctx.lineTo(100, 0);
      ctx.stroke();
    });
    expect(ids(s, { x: 5, y: 0 })).toEqual(["o0"]);
    expect(ids(s, { x: 15, y: 0 })).toEqual([]);
    expect(ids(s, { x: 25, y: 0 })).toEqual(["o0"]);
  });

  test("the dash offset shifts the pattern", () => {
    const s = scene((ctx) => {
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 10]);
      ctx.lineDashOffset = 10;
      ctx.moveTo(0, 0);
      ctx.lineTo(100, 0);
      ctx.stroke();
    });
    expect(ids(s, { x: 5, y: 0 })).toEqual([]);
    expect(ids(s, { x: 15, y: 0 })).toEqual(["o0"]);
  });

  test("miter joins beyond the limit become bevels", () => {
    const draw = (miterLimit: number) => (ctx: RecordingContext) => {
      ctx.lineWidth = 2;
      ctx.miterLimit = miterLimit;
      ctx.moveTo(0, 10);
      ctx.lineTo(10, 0);
      ctx.lineTo(20, 10);
      ctx.stroke();
    };
    const nearTip = { x: 10, y: -1.3 };
    expect(ids(scene(draw(10)), nearTip)).toEqual(["o0"]);
    expect(ids(scene(draw(1.2)), nearTip)).toEqual([]);
  });

  test("clearRect hides what was drawn before it", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 100, 100);
      ctx.clearRect(40, 40, 20, 20);
      ctx.fillRect(45, 45, 5, 5);
    });
    expect(ids(s, { x: 10, y: 10 })).toEqual(["o0"]);
    expect(ids(s, { x: 55, y: 55 })).toEqual([]);
    expect(ids(s, { x: 47, y: 47 })).toEqual(["o2"]);
  });

  test("ops drawn with zero alpha are skipped unless asked for", () => {
    const s = scene((ctx) => {
      ctx.globalAlpha = 0;
      ctx.fillRect(0, 0, 10, 10);
    });
    expect(ids(s, { x: 5, y: 5 })).toEqual([]);
    expect(s.hitTest({ x: 5, y: 5 }, { includeInvisible: true }).map((h) => h.id)).toEqual(["o0"]);
  });

  test("ops in a group with hit: false are never hit, so what lies under them is", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.beginGroup({ id: "roads", meta: { hit: false } });
      ctx.beginGroup({ id: "road" });
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(10, 5);
      ctx.stroke();
      ctx.endGroup();
      ctx.endGroup();
    });
    expect(ids(s, { x: 5, y: 5 })).toEqual(["o0"]);
    expect(s.queryRect({ x: 4, y: 4, width: 2, height: 2 })).toEqual(["o0", "o1"]);
  });

  test("nothing is painted under a singular transform", () => {
    const s = scene((ctx) => {
      ctx.rect(0, 0, 10, 10);
      ctx.scale(0, 1);
      ctx.fill();
    });
    expect(ids(s, { x: 5, y: 5 })).toEqual([]);
  });
});

describe("queryRect", () => {
  const s = scene((ctx) => {
    ctx.fillRect(0, 0, 10, 10);
    ctx.lineWidth = 2;
    ctx.moveTo(20, 0);
    ctx.lineTo(40, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(100, 100, 100, 100);
    ctx.rect(120, 120, 60, 60);
    ctx.fill("evenodd");
  });

  test("intersects", () => {
    expect(s.queryRect({ x: 5, y: 5, width: 20, height: 1 })).toEqual(["o0"]);
    expect(s.queryRect({ x: 5, y: -0.5, width: 20, height: 1 })).toEqual(["o0", "o1"]);
    // A stroke is touched by its width, not just its centerline.
    expect(s.queryRect({ x: 25, y: 0.5, width: 2, height: 2 })).toEqual(["o1"]);
    expect(s.queryRect({ x: 25, y: 1.5, width: 2, height: 2 })).toEqual([]);
  });

  test("a rect inside a hole touches nothing; one inside the ring does", () => {
    expect(s.queryRect({ x: 130, y: 130, width: 10, height: 10 })).toEqual([]);
    expect(s.queryRect({ x: 105, y: 105, width: 5, height: 5 })).toEqual(["o2"]);
  });

  test("enclosed", () => {
    expect(s.queryRect({ x: -1, y: -2, width: 50, height: 20 }, "enclosed")).toEqual(["o0", "o1"]);
    expect(s.queryRect({ x: -1, y: -0.5, width: 50, height: 20 }, "enclosed")).toEqual(["o0"]);
  });
});

describe("closestPoint", () => {
  test("on a circle, with tangent and normal", () => {
    const s = new Scene(
      record((ctx) => {
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.stroke();
      }),
      { tolerance: 0.001 },
    );
    const found = s.closestPoint({ x: 20, y: 0.001 })!;
    expect(found.id).toBe("o0");
    expect(found.point.x).toBeCloseTo(10, 2);
    expect(found.distance).toBeCloseTo(10, 2);
    expect(Math.abs(found.tangent.y)).toBeCloseTo(1, 3);
  });

  test("the nearest of several ops, and maxDistance", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(100, 0, 10, 10);
    });
    expect(s.closestPoint({ x: 80, y: 5 })!.id).toBe("o1");
    expect(s.closestPoint({ x: 80, y: 5 }, { maxDistance: 5 })).toBeNull();
  });
});

describe("editing", () => {
  test("transform moves an op and only that op", () => {
    const s = scene((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(20, 0, 10, 10);
    });
    s.transform("o0", { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
    expect(ids(s, { x: 5, y: 5 })).toEqual([]);
    expect(ids(s, { x: 105, y: 5 })).toEqual(["o0"]);
    expect(ids(s, { x: 25, y: 5 })).toEqual(["o1"]);
  });

  test("insert and remove keep drawing order", () => {
    const doc = record((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(0, 0, 10, 10);
    });
    const s = new Scene(doc);
    const extra = transformOp({ ...doc.ops[0]!, id: "x" }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    s.insert(extra, 1);
    expect(ids(s, { x: 5, y: 5 })).toEqual(["o1", "x", "o0"]);
    s.remove("o1");
    expect(ids(s, { x: 5, y: 5 })).toEqual(["x", "o0"]);
    expect(s.document.ops.map((op) => op.id)).toEqual(["o0", "x"]);
  });
});

describe("transforming then querying equals querying then transforming", () => {
  // A small deterministic generator, so failures reproduce.
  let seed = 12345;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const between = (lo: number, hi: number): number => lo + (hi - lo) * random();

  const drawings: ((ctx: RecordingContext) => void)[] = [
    (ctx) => {
      ctx.translate(50, 50);
      ctx.rotate(0.4);
      ctx.ellipse(0, 0, 40, 20, 0.3, 0.5, 5);
      ctx.closePath();
      ctx.fill("evenodd");
    },
    (ctx) => {
      ctx.lineWidth = 9;
      ctx.lineJoin = "round";
      ctx.lineCap = "square";
      ctx.moveTo(10, 90);
      ctx.bezierCurveTo(10, 0, 90, 100, 90, 10);
      ctx.lineTo(50, 50);
      ctx.scale(1.5, 0.8);
      ctx.stroke();
    },
    (ctx) => {
      ctx.lineWidth = 6;
      ctx.setLineDash([15, 5]);
      ctx.arcTo(80, 10, 80, 80, 25);
      ctx.lineTo(80, 80);
      ctx.stroke();
    },
  ];
  const matrices: Matrix2D[] = [
    { a: 1, b: 0, c: 0, d: 1, e: 30, f: -20 },
    { a: 0.6, b: 0.8, c: -0.8, d: 0.6, e: 5, f: 5 },
    { a: 2, b: 0.3, c: -0.5, d: 0.7, e: -10, f: 40 },
  ];

  test.each(drawings.map((d, i) => [i, d] as const))("drawing %d", (_i, draw) => {
    const doc = record(draw);
    const before = new Scene(doc, { tolerance: 0.01 });
    for (const matrix of matrices) {
      const after = new Scene({ version: 1, ops: doc.ops.map((op) => transformOp(op, matrix)) }, { tolerance: 0.01 });
      let compared = 0;
      for (let k = 0; k < 400; k++) {
        const p = { x: between(-20, 120), y: between(-20, 120) };
        const hit = (q: Point): boolean => before.hitTest(q).length > 0;
        // Skip points within 0.5 of an edge, where flattening may legitimately differ.
        const here = hit(p);
        const nearEdge = [
          [0.5, 0],
          [-0.5, 0],
          [0, 0.5],
          [0, -0.5],
        ].some(([dx, dy]) => hit({ x: p.x + dx!, y: p.y + dy! }) !== here);
        if (nearEdge) continue;
        compared++;
        expect(after.hitTest(applyToPoint(matrix, p.x, p.y)).length > 0).toBe(here);
      }
      expect(compared).toBeGreaterThan(300);
    }
  });
});

describe("replaceGroup", () => {
  const drawn = (color: string, count: number) =>
    record((ctx) => {
      ctx.beginGroup({ id: "card", meta: { v: count } });
      ctx.fillStyle = color;
      for (let i = 0; i < count; i++) ctx.fillRect(i * 20, 0, 10, 10);
      ctx.beginGroup({ id: "label" });
      ctx.fillRect(0, 20, 50, 5);
      ctx.endGroup();
      ctx.endGroup();
    });

  test("swaps a group's ops in place, keeping drawing order and parent", () => {
    const s = scene((ctx) => {
      ctx.beginGroup({ id: "board" });
      ctx.fillRect(-100, -100, 5, 5);
      ctx.beginGroup({ id: "card" });
      ctx.fillRect(0, 0, 10, 10);
      ctx.endGroup();
      ctx.fillRect(100, 100, 5, 5);
      ctx.endGroup();
    });
    const [before, , after] = s.document.ops.map((op) => op.id);
    const ids = s.replaceGroup("card", drawn("red", 3));
    expect(ids).toHaveLength(4);
    expect(ids.every((id) => id.startsWith("card/"))).toBe(true);
    expect(s.document.ops.map((op) => op.id)).toEqual([before!, ...ids, after!]);
    const groups = s.document.groups!;
    expect(groups.find((g) => g.id === "card")).toEqual({ id: "card", parent: "board", meta: { v: 3 } });
    expect(groups.find((g) => g.id === "card/label")?.parent).toBe("card");
    expect(s.hitTest({ x: 45, y: 5 })[0]?.groups).toEqual(["card", "board"]);
    expect(s.hitTest({ x: 5, y: 22 })[0]?.groups).toEqual(["card/label", "card", "board"]);
    // Again with fewer ops: nothing of the old drawing is left.
    const again = s.replaceGroup("card", drawn("blue", 1));
    expect(s.document.ops.map((op) => op.id)).toEqual([before!, ...again, after!]);
    expect(s.hitTest({ x: 45, y: 5 })).toEqual([]);
    expect(s.document.groups!.filter((g) => g.id.startsWith("card")).length).toBe(2);
  });

  test("a new group goes after its parent's ops", () => {
    const s = scene((ctx) => {
      ctx.beginGroup({ id: "board" });
      ctx.fillRect(0, 0, 5, 5);
      ctx.endGroup();
      ctx.fillRect(100, 100, 5, 5);
    });
    const ids = s.replaceGroup("card", drawn("red", 1), { parent: "board" });
    expect(s.document.ops.map((op) => op.id).indexOf(ids[0]!)).toBe(1);
    expect(s.groupChain(ids[0]!)).toEqual(["card", "board"]);
  });

  test("removing a group removes groups nested several deep", () => {
    const s = scene((ctx) => {
      ctx.beginGroup({ id: "a" });
      ctx.beginGroup({ id: "b" });
      ctx.beginGroup({ id: "c" });
      ctx.fillRect(0, 0, 1, 1);
      ctx.endGroup();
      ctx.endGroup();
      ctx.endGroup();
    });
    s.remove("a");
    expect(s.document.groups ?? []).toEqual([]);
  });

  test("refuses ops outside the group", () => {
    const s = scene((ctx) => ctx.fillRect(0, 0, 5, 5));
    expect(() => s.replaceGroup("card", record((ctx) => ctx.fillRect(0, 0, 1, 1)))).toThrow("is not inside card");
  });
});
