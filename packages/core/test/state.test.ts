import { describe, expect, test } from "bun:test";
import { RecordingContext, UnsupportedCanvasCallError } from "../src/context";
import { IDENTITY } from "../src/math";
import { onlyOp, record } from "./helpers";

describe("save and restore", () => {
  test("restore brings back transform and styles", () => {
    const ctx = new RecordingContext();
    ctx.save();
    ctx.translate(5, 5);
    ctx.fillStyle = "red";
    ctx.lineWidth = 4;
    ctx.restore();
    expect(ctx.getTransform()).toMatchObject({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(ctx.fillStyle).toBe("#000000");
    expect(ctx.lineWidth).toBe(1);
  });

  test("restore with an empty stack does nothing", () => {
    const ctx = new RecordingContext();
    ctx.fillStyle = "blue";
    ctx.restore();
    expect(ctx.fillStyle).toBe("blue");
  });

  test("the path is not part of the saved state", () => {
    const doc = record((ctx) => {
      ctx.save();
      ctx.rect(0, 0, 1, 1);
      ctx.restore();
      ctx.fill();
    });
    expect(doc.ops).toHaveLength(1);
  });
});

describe("line dashes", () => {
  test("an odd-length list is repeated", () => {
    const ctx = new RecordingContext();
    ctx.setLineDash([5, 10, 15]);
    expect(ctx.getLineDash()).toEqual([5, 10, 15, 5, 10, 15]);
  });

  test("lists with negative or non-finite values are ignored", () => {
    const ctx = new RecordingContext();
    ctx.setLineDash([4, 2]);
    ctx.setLineDash([4, -1]);
    ctx.setLineDash([4, NaN]);
    expect(ctx.getLineDash()).toEqual([4, 2]);
  });

  test("getLineDash returns a copy", () => {
    const ctx = new RecordingContext();
    ctx.setLineDash([1, 2]);
    ctx.getLineDash().push(99);
    expect(ctx.getLineDash()).toEqual([1, 2]);
  });
});

describe("invalid property values are ignored", () => {
  test.each([
    ["lineWidth", [0, -1, NaN, Infinity], 1],
    ["miterLimit", [0, -2, NaN], 10],
    ["globalAlpha", [-0.1, 1.5, NaN], 1],
    ["shadowBlur", [-1, NaN], 0],
    ["lineDashOffset", [NaN, Infinity], 0],
  ] as const)("%s", (property, values, expected) => {
    const ctx = new RecordingContext();
    for (const value of values) (ctx as unknown as Record<string, number>)[property] = value;
    expect((ctx as unknown as Record<string, number>)[property]).toBe(expected);
  });

  test("unknown keywords", () => {
    const ctx = new RecordingContext();
    (ctx as unknown as Record<string, string>).lineCap = "flat";
    (ctx as unknown as Record<string, string>).lineJoin = "sharp";
    ctx.globalCompositeOperation = "add";
    expect([ctx.lineCap, ctx.lineJoin, ctx.globalCompositeOperation]).toEqual(["butt", "miter", "source-over"]);
  });
});

describe("transforms", () => {
  test("compose like Canvas: later calls apply first", () => {
    const ctx = new RecordingContext();
    ctx.translate(10, 0);
    ctx.scale(2, 3);
    expect(ctx.getTransform()).toMatchObject({ a: 2, b: 0, c: 0, d: 3, e: 10, f: 0 });
  });

  test("rotate", () => {
    const ctx = new RecordingContext();
    ctx.rotate(Math.PI / 2);
    const m = ctx.getTransform();
    expect(m.a).toBeCloseTo(0);
    expect(m.b).toBeCloseTo(1);
    expect(m.c).toBeCloseTo(-1);
    expect(m.d).toBeCloseTo(0);
  });

  test("setTransform takes six numbers, a matrix init, or nothing", () => {
    const ctx = new RecordingContext();
    ctx.setTransform(1, 2, 3, 4, 5, 6);
    expect(ctx.getTransform()).toMatchObject({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    ctx.setTransform({ a: 2, d: 2, e: 7 });
    expect(ctx.getTransform()).toMatchObject({ a: 2, b: 0, c: 0, d: 2, e: 7, f: 0 });
    ctx.setTransform();
    expect(ctx.getTransform()).toMatchObject(IDENTITY);
  });

  test("calls with non-finite numbers are ignored", () => {
    const ctx = new RecordingContext();
    ctx.translate(NaN, 1);
    ctx.scale(Infinity, 1);
    ctx.rotate(NaN);
    ctx.transform(1, 0, 0, 1, NaN, 0);
    ctx.setTransform(1, 0, 0, 1, Infinity, 0);
    expect(ctx.getTransform()).toMatchObject(IDENTITY);
  });
});

describe("snapshots", () => {
  test("ops keep the state from when they were drawn", () => {
    const op = onlyOp(
      record((ctx) => {
        ctx.strokeStyle = "green";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.setLineDash([2, 1]);
        ctx.globalAlpha = 0.5;
        ctx.rect(0, 0, 1, 1);
        ctx.stroke();
        ctx.lineWidth = 9;
      }),
    );
    expect(op.kind).toBe("stroke");
    if (op.kind !== "stroke") return;
    expect(op.stroke).toEqual({
      paint: "green",
      lineWidth: 3,
      lineCap: "round",
      lineJoin: "miter",
      miterLimit: 10,
      lineDash: [2, 1],
      lineDashOffset: 0,
    });
    expect(op.compositing.globalAlpha).toBe(0.5);
  });

  test("ids are assigned in record order", () => {
    const doc = record((ctx) => {
      ctx.fillRect(0, 0, 1, 1);
      ctx.clearRect(0, 0, 1, 1);
      ctx.strokeRect(0, 0, 1, 1);
    });
    expect(doc.ops.map((op) => op.id)).toEqual(["o0", "o1", "o2"]);
  });

  test("reset clears the drawing, path and state", () => {
    const ctx = new RecordingContext();
    ctx.fillStyle = "red";
    ctx.save();
    ctx.fillRect(0, 0, 1, 1);
    ctx.moveTo(0, 0);
    ctx.reset();
    ctx.lineTo(5, 5);
    ctx.lineTo(6, 6);
    ctx.fill();
    const doc = ctx.getDocument();
    expect(doc.ops.map((op) => op.id)).toEqual(["o0"]);
    expect(ctx.fillStyle).toBe("#000000");
  });
});

describe("unsupported calls", () => {
  test.each(["clip", "fillText", "measureText", "drawImage", "getImageData", "createLinearGradient", "roundRect"])(
    "%s throws UnsupportedCanvasCallError",
    (method) => {
      const ctx = new RecordingContext() as unknown as Record<string, () => unknown>;
      expect(() => ctx[method]!()).toThrow(UnsupportedCanvasCallError);
    },
  );

  test("a gradient fillStyle throws", () => {
    const ctx = new RecordingContext();
    expect(() => {
      (ctx as unknown as Record<string, unknown>).fillStyle = {};
    }).toThrow(UnsupportedCanvasCallError);
  });

  test("ctx.canvas reports a size", () => {
    expect(new RecordingContext().canvas).toEqual({ width: 300, height: 150 });
    expect(new RecordingContext({ width: 10, height: 20 }).canvas).toEqual({ width: 10, height: 20 });
  });
});
