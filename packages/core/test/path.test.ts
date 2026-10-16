import { describe, expect, test } from "bun:test";
import { IDENTITY } from "../src/math";
import { pathOf, record } from "./helpers";

describe("ensure there is a subpath", () => {
  test("lineTo with no subpath acts as moveTo", () => {
    const path = pathOf((ctx) => {
      ctx.lineTo(5, 5);
      ctx.lineTo(10, 5);
    });
    expect(path.subpaths).toEqual([
      { m: 0, start: { x: 5, y: 5 }, segments: [{ kind: "line", m: 0, to: { x: 10, y: 5 } }], closed: false },
    ]);
  });

  test("bezierCurveTo with no subpath starts at its first control point", () => {
    const path = pathOf((ctx) => ctx.bezierCurveTo(1, 2, 3, 4, 5, 6));
    expect(path.subpaths[0]!.start).toEqual({ x: 1, y: 2 });
    expect(path.subpaths[0]!.segments[0]!.kind).toBe("cubic");
  });

  test("quadraticCurveTo with no subpath starts at its control point", () => {
    const path = pathOf((ctx) => ctx.quadraticCurveTo(7, 8, 9, 10));
    expect(path.subpaths[0]!.start).toEqual({ x: 7, y: 8 });
  });
});

describe("arc and ellipse", () => {
  test("with no subpath, the path starts at the arc's start point and adds no line", () => {
    const path = pathOf((ctx) => ctx.arc(0, 0, 10, 0, Math.PI));
    expect(path.subpaths[0]!.start).toEqual({ x: 10, y: 0 });
    expect(path.subpaths[0]!.segments.map((s) => s.kind)).toEqual(["ellipse"]);
  });

  test("after a point elsewhere, a line connects it to the arc's start", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(-20, 0);
      ctx.arc(0, 0, 10, 0, Math.PI);
    });
    const segments = path.subpaths[0]!.segments;
    expect(segments.map((s) => s.kind)).toEqual(["line", "ellipse"]);
    expect(segments[0]).toEqual({ kind: "line", m: 0, to: { x: 10, y: 0 } });
  });

  test("starting exactly at the current point adds no line", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(10, 0);
      ctx.arc(0, 0, 10, 0, Math.PI);
    });
    expect(path.subpaths[0]!.segments.map((s) => s.kind)).toEqual(["ellipse"]);
  });

  test("a sweep past a full turn ends where it started", () => {
    // If the arc ended at 3π, the second arc would need a connecting line from (-10, 0).
    const path = pathOf((ctx) => {
      ctx.arc(0, 0, 10, 0, 3 * Math.PI);
      ctx.arc(0, 0, 10, 0, Math.PI / 2);
    });
    expect(path.subpaths[0]!.segments.map((s) => s.kind)).toEqual(["ellipse", "ellipse"]);
  });

  test("is stored as called, with rx === ry", () => {
    const path = pathOf((ctx) => ctx.arc(1, 2, 3, 0.5, 1.5, true));
    expect(path.subpaths[0]!.segments[0]).toEqual({
      kind: "ellipse",
      m: 0,
      center: { x: 1, y: 2 },
      rx: 3,
      ry: 3,
      rotation: 0,
      startAngle: 0.5,
      endAngle: 1.5,
      counterclockwise: true,
    });
  });

  test("a negative radius throws IndexSizeError", () => {
    expect(() => pathOf((c) => c.arc(0, 0, -1, 0, 1))).toThrow(expect.objectContaining({ name: "IndexSizeError" }));
    expect(() => pathOf((c) => c.ellipse(0, 0, 1, -1, 0, 0, 1))).toThrow(
      expect.objectContaining({ name: "IndexSizeError" }),
    );
  });
});

describe("arcTo", () => {
  test("rounds a corner with a line to the first tangent point and an arc to the second", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.arcTo(10, 0, 10, 10, 2);
    });
    const [line, arc] = path.subpaths[0]!.segments;
    expect(line).toEqual({ kind: "line", m: 0, to: { x: 8, y: 0 } });
    if (arc?.kind !== "ellipse") throw new Error("expected an ellipse segment");
    expect(arc.center.x).toBeCloseTo(8);
    expect(arc.center.y).toBeCloseTo(2);
    expect(arc.rx).toBe(2);
    expect(arc.startAngle).toBeCloseTo(-Math.PI / 2);
    expect(arc.endAngle).toBeCloseTo(0);
    expect(arc.counterclockwise).toBe(false);
  });

  test("bends the other way for a left turn", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.arcTo(10, 0, 10, -10, 2);
    });
    const arc = path.subpaths[0]!.segments[1]!;
    expect(arc.kind === "ellipse" && arc.counterclockwise).toBe(true);
  });

  test.each([
    ["collinear points", [20, 0, 2]],
    ["radius 0", [10, 10, 0]],
    ["P1 equal to P2", [10, 0, 2]],
  ] as const)("%s add a straight line to P1", (_name, [x2, y2, r]) => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.arcTo(10, 0, x2, y2, r);
    });
    expect(path.subpaths[0]!.segments).toEqual([{ kind: "line", m: 0, to: { x: 10, y: 0 } }]);
  });

  test("with no subpath, starts at P1", () => {
    const path = pathOf((ctx) => {
      ctx.arcTo(10, 0, 10, 10, 2);
      ctx.lineTo(20, 20);
    });
    expect(path.subpaths[0]!.start).toEqual({ x: 10, y: 0 });
  });
});

describe("closePath and rect", () => {
  test("closePath marks the subpath closed and the next segment starts at its first point", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(10, 0);
      ctx.lineTo(10, 10);
      ctx.closePath();
      ctx.lineTo(0, 20);
    });
    expect(path.subpaths.map((s) => [s.start, s.closed])).toEqual([
      [{ x: 0, y: 0 }, true],
      [{ x: 0, y: 0 }, false],
    ]);
    expect(path.subpaths[1]!.segments).toEqual([{ kind: "line", m: 0, to: { x: 0, y: 20 } }]);
  });

  test("closePath with no subpath does nothing", () => {
    const path = pathOf((ctx) => {
      ctx.closePath();
      ctx.lineTo(1, 1);
      ctx.lineTo(2, 2);
    });
    expect(path.subpaths).toHaveLength(1);
    expect(path.subpaths[0]!.start).toEqual({ x: 1, y: 1 });
  });

  test("rect adds a closed subpath and leaves the current point at its origin", () => {
    const path = pathOf((ctx) => {
      ctx.rect(1, 2, 3, 4);
      ctx.lineTo(0, 0);
    });
    expect(path.subpaths[0]).toEqual({
      m: 0,
      start: { x: 1, y: 2 },
      segments: [
        { kind: "line", m: 0, to: { x: 4, y: 2 } },
        { kind: "line", m: 0, to: { x: 4, y: 6 } },
        { kind: "line", m: 0, to: { x: 1, y: 6 } },
      ],
      closed: true,
    });
    expect(path.subpaths[1]).toEqual({
      m: 0,
      start: { x: 1, y: 2 },
      segments: [{ kind: "line", m: 0, to: { x: 0, y: 0 } }],
      closed: false,
    });
  });
});

describe("arguments the spec ignores", () => {
  test.each([NaN, Infinity, -Infinity])("calls with %p are ignored", (bad) => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(bad, 1);
      ctx.quadraticCurveTo(1, bad, 2, 2);
      ctx.bezierCurveTo(1, 1, 2, 2, bad, 3);
      ctx.arc(0, 0, bad, 0, 1);
      ctx.arcTo(1, 1, 2, 2, bad);
      ctx.rect(0, 0, bad, 1);
      ctx.moveTo(bad, 0);
      ctx.lineTo(5, 5);
    });
    expect(path.subpaths).toEqual([
      { m: 0, start: { x: 0, y: 0 }, segments: [{ kind: "line", m: 0, to: { x: 5, y: 5 } }], closed: false },
    ]);
  });
});

describe("transforms inside a path", () => {
  test("coordinates keep the matrix they were given under", () => {
    const path = pathOf((ctx) => {
      ctx.moveTo(0, 0);
      ctx.translate(10, 0);
      ctx.lineTo(0, 0);
      ctx.resetTransform();
      ctx.lineTo(0, 10);
    });
    expect(path.matrices).toEqual([IDENTITY, { ...IDENTITY, e: 10 }]);
    expect(path.subpaths[0]!.segments.map((s) => s.m)).toEqual([1, 0]);
  });

  test("the op's transform is the one in effect when it was painted", () => {
    const doc = record((ctx) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(1, 1);
      ctx.scale(2, 2);
      ctx.stroke();
    });
    expect(doc.ops[0]!.transform).toEqual({ ...IDENTITY, a: 2, d: 2 });
    expect(doc.ops[0]!.kind === "stroke" && doc.ops[0]!.path.matrices).toEqual([IDENTITY]);
  });

  test("an arc's connecting line is found in world space", () => {
    // (0, 0) under translate(10, 0) is world (10, 0), the arc's start: no line.
    const path = pathOf((ctx) => {
      ctx.translate(10, 0);
      ctx.moveTo(0, 0);
      ctx.resetTransform();
      ctx.arc(0, 0, 10, 0, 1);
    });
    expect(path.subpaths[0]!.segments.map((s) => s.kind)).toEqual(["ellipse"]);
  });
});

describe("painting", () => {
  test("fill and stroke snapshot the same path, which beginPath clears", () => {
    const doc = record((ctx) => {
      ctx.rect(0, 0, 10, 10);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fill();
    });
    expect(doc.ops.map((op) => op.kind)).toEqual(["fill", "stroke"]);
  });

  test("fillRect and strokeRect leave the current path alone", () => {
    const doc = record((ctx) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(5, 5);
      ctx.fillRect(10, 10, 2, 2);
      ctx.strokeRect(20, 20, 2, 2);
      ctx.stroke();
    });
    expect(doc.ops.map((op) => op.kind)).toEqual(["fill", "stroke", "stroke"]);
    const last = doc.ops[2]!;
    expect(last.kind === "stroke" && last.path.subpaths[0]!.start).toEqual({ x: 0, y: 0 });
  });

  test("an empty fillRect draws nothing and a flat strokeRect is a line", () => {
    const doc = record((ctx) => {
      ctx.fillRect(0, 0, 0, 10);
      ctx.strokeRect(0, 0, 10, 0);
      ctx.strokeRect(0, 0, 0, 0);
    });
    expect(doc.ops).toHaveLength(1);
    const op = doc.ops[0]!;
    expect(op.kind === "stroke" && op.path.subpaths[0]!.segments).toEqual([{ kind: "line", m: 0, to: { x: 10, y: 0 } }]);
  });

  test("clearRect records a clear op", () => {
    const doc = record((ctx) => ctx.clearRect(0, 0, 5, 5));
    expect(doc.ops[0]).toEqual({ kind: "clear", id: "o0", transform: IDENTITY, rect: { x: 0, y: 0, width: 5, height: 5 } });
  });

  test("an invalid fill rule throws TypeError", () => {
    expect(() => record((ctx) => ctx.fill("bogus" as "nonzero"))).toThrow(TypeError);
  });
});
