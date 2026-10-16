import { describe, expect, test } from "bun:test";
import { canvasColor } from "../src/color";
import { RecordingContext, type RecordingContextOptions } from "../src/context";
import { Scene, transformOp } from "../src/geometry/scene";
import { RecordingPath2D } from "../src/path2d";
import { replayDocument } from "../src/replay";
import { deserializeDocument, serializeDocument } from "../src/serialization";
import type { FillOp, ImageOp, IRDocument, Op, TextMeasure, TextOp } from "../src/types";

/** A fixed-width font: every character is 6 wide, ascent 8, descent 2. */
const measureText = (text: string): TextMeasure => ({
  width: text.length * 6,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: text.length * 6,
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 9,
  fontBoundingBoxDescent: 3,
});

const image = { src: "cat.png", naturalWidth: 40, naturalHeight: 20 };
const options: RecordingContextOptions = { measureText };

const record = (draw: (ctx: RecordingContext) => void): IRDocument => {
  const ctx = new RecordingContext(options);
  draw(ctx);
  return ctx.getDocument();
};

const only = <K extends Op["kind"]>(doc: IRDocument, kind: K): Extract<Op, { kind: K }> => {
  expect(doc.ops).toHaveLength(1);
  const op = doc.ops[0]!;
  expect(op.kind).toBe(kind);
  return op as Extract<Op, { kind: K }>;
};

describe("colors", () => {
  test.each([
    ["red", "#ff0000"],
    ["#ABC", "#aabbcc"],
    ["#11223380", "rgba(17, 34, 51, 0.5)"],
    ["rgb(255 0 0 / 50%)", "rgba(255, 0, 0, 0.5)"],
    ["rgba(0, 0, 0, 0.6)", "rgba(0, 0, 0, 0.6)"],
    ["hsl(120, 100%, 25%)", "#008000"],
    ["transparent", "rgba(0, 0, 0, 0)"],
    ["oklch(70% 0.1 200)", "oklch(70% 0.1 200)"],
  ])("%s is %s", (input, expected) => {
    expect(canvasColor(input)).toBe(expected);
  });

  test("invalid colors are ignored, as browsers ignore them", () => {
    const ctx = new RecordingContext();
    ctx.fillStyle = "red";
    ctx.fillStyle = "not a color";
    ctx.fillStyle = "#12";
    expect(ctx.fillStyle).toBe("#ff0000");
  });
});

describe("gradients and patterns", () => {
  test("a gradient is snapshotted when the op is drawn", () => {
    const doc = record((ctx) => {
      const g = ctx.createLinearGradient(0, 0, 10, 0);
      g.addColorStop(0, "red");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 10, 10);
      g.addColorStop(1, "blue");
      ctx.fillRect(0, 0, 10, 10);
    });
    const [first, second] = doc.ops as FillOp[];
    expect(first!.paint).toEqual({ kind: "linear", x0: 0, y0: 0, x1: 10, y1: 0, stops: [{ offset: 0, color: "#ff0000" }] });
    expect(second!.paint).toMatchObject({ stops: [{ offset: 0 }, { offset: 1, color: "#0000ff" }] });
  });

  test("bad stops and radii throw as in the spec", () => {
    const ctx = new RecordingContext();
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 5);
    expect(() => g.addColorStop(1.5, "red")).toThrow(expect.objectContaining({ name: "IndexSizeError" }));
    expect(() => g.addColorStop(0.5, "nope")).toThrow(expect.objectContaining({ name: "SyntaxError" }));
    expect(() => ctx.createRadialGradient(0, 0, -1, 0, 0, 5)).toThrow(expect.objectContaining({ name: "IndexSizeError" }));
    expect(() => ctx.createLinearGradient(0, NaN, 1, 1)).toThrow(TypeError);
  });

  test("a pattern records its image, repetition and transform", () => {
    const doc = record((ctx) => {
      const p = ctx.createPattern(image, "repeat-x")!;
      p.setTransform({ a: 2, d: 2 });
      ctx.fillStyle = p;
      ctx.fillRect(0, 0, 10, 10);
    });
    expect(only(doc, "fill").paint).toEqual({
      kind: "pattern",
      image: { src: "cat.png", width: 40, height: 20 },
      repetition: "repeat-x",
      transform: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 },
    });
  });
});

describe("clip", () => {
  test("is saved state, and ops carry the clips in effect", () => {
    const doc = record((ctx) => {
      ctx.save();
      ctx.rect(0, 0, 50, 50);
      ctx.clip();
      ctx.beginPath();
      ctx.arc(25, 25, 20, 0, Math.PI * 2);
      ctx.clip("evenodd");
      ctx.fillRect(0, 0, 100, 100);
      ctx.restore();
      ctx.fillRect(0, 0, 100, 100);
    });
    const [clipped, free] = doc.ops as FillOp[];
    expect(clipped!.clip!.map((c) => c.fillRule)).toEqual(["nonzero", "evenodd"]);
    expect(free!.clip).toBeUndefined();
  });

  test("hit tests and bounds respect the clip", () => {
    const s = new Scene(
      record((ctx) => {
        ctx.rect(0, 0, 50, 50);
        ctx.clip();
        ctx.fillRect(0, 0, 100, 100);
      }),
    );
    expect(s.hitTest({ x: 25, y: 25 })).toHaveLength(1);
    expect(s.hitTest({ x: 75, y: 25 })).toHaveLength(0);
    expect(s.bounds("o0")).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(s.queryRect({ x: 60, y: 0, width: 10, height: 10 })).toEqual([]);
  });

  test("clearRect is clipped too", () => {
    const s = new Scene(
      record((ctx) => {
        ctx.fillRect(0, 0, 100, 100);
        ctx.rect(0, 0, 50, 100);
        ctx.clip();
        ctx.clearRect(0, 0, 100, 100);
      }),
    );
    expect(s.hitTest({ x: 25, y: 25 })).toHaveLength(0);
    expect(s.hitTest({ x: 75, y: 25 })).toHaveLength(1);
  });
});

describe("Path2D", () => {
  test("is drawn under the transform at fill time", () => {
    const path = new RecordingPath2D();
    path.rect(0, 0, 10, 10);
    const s = new Scene(
      record((ctx) => {
        ctx.translate(100, 0);
        ctx.fill(path);
      }),
    );
    expect(s.bounds("o0")).toEqual({ x: 100, y: 0, width: 10, height: 10 });
  });

  test("SVG path data, including smooth curves and arcs", () => {
    const path = new RecordingPath2D("M10 10 h80 v20 H10 z m0 40 c0-10 20-10 20 0 s20 10 20 0 A20 20 0 0 1 90 50 l-80 20Z");
    const s = new Scene(record((ctx) => ctx.fill(path)), { tolerance: 0.01 });
    const b = s.bounds("o0", "geometry")!;
    expect(b.x).toBeCloseTo(10, 6);
    expect(b.y).toBeCloseTo(10, 6);
    expect(b.x + b.width).toBeCloseTo(90, 6);
    // The arc from (50, 50) to (90, 50) with radius 20 is a lower half circle bulging to y = 70.
    expect(b.y + b.height).toBeCloseTo(70, 6);
  });

  test("addPath applies its transform", () => {
    const inner = new RecordingPath2D("M0 0 L10 0 L10 10 Z");
    const outer = new RecordingPath2D();
    outer.addPath(inner, { e: 50 });
    expect(new Scene(record((ctx) => ctx.fill(outer))).bounds("o0")).toEqual({ x: 50, y: 0, width: 10, height: 10 });
  });

  test("bad SVG data keeps what parsed before the error", () => {
    const path = new RecordingPath2D("M0 0 L10 0 L10 10 X 50 50");
    expect(new Scene(record((ctx) => ctx.fill(path))).bounds("o0")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe("roundRect", () => {
  test("corners are rounded and oversized radii scale down", () => {
    const s = new Scene(
      record((ctx) => {
        ctx.roundRect(0, 0, 100, 50, [10, 200]);
        ctx.fill();
      }),
    );
    expect(s.bounds("o0", "geometry")).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    // Radii scale by 50 / 210, so the top right corner has radius about 47.6 and (95, 5) is outside it.
    expect(s.hitTest({ x: 95, y: 5 })).toHaveLength(0);
    expect(s.hitTest({ x: 1, y: 1 })).toHaveLength(1);
    expect(s.hitTest({ x: 50, y: 25 })).toHaveLength(1);
  });

  test("radii are validated", () => {
    const ctx = new RecordingContext();
    expect(() => ctx.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5])).toThrow(RangeError);
    expect(() => ctx.roundRect(0, 0, 10, 10, -1)).toThrow(RangeError);
  });
});

describe("drawImage", () => {
  test("all three forms normalize to source and destination rects", () => {
    const doc = record((ctx) => {
      ctx.drawImage(image, 5, 5);
      ctx.drawImage(image, 5, 5, 80, 40);
      ctx.drawImage(image, 10, 0, 10, 20, 50, 50, -20, 40);
    });
    const [a, b, c] = doc.ops as ImageOp[];
    expect(a!.source).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(a!.dest).toEqual({ x: 5, y: 5, width: 40, height: 20 });
    expect(b!.dest).toEqual({ x: 5, y: 5, width: 80, height: 40 });
    expect(c!.dest).toEqual({ x: 30, y: 50, width: 20, height: 40 });
  });

  test("an image that isn't loaded draws nothing", () => {
    expect(record((ctx) => ctx.drawImage({ src: "x.png", naturalWidth: 0, naturalHeight: 0 }, 0, 0)).ops).toEqual([]);
  });

  test("hit tests use the painted part of the destination", () => {
    // The source rect runs past the image's right edge, so only the left half of the destination is painted.
    const s = new Scene(record((ctx) => ctx.drawImage(image, 20, 0, 40, 20, 0, 0, 80, 40)));
    expect(s.hitTest({ x: 30, y: 20 })).toHaveLength(1);
    expect(s.hitTest({ x: 50, y: 20 })).toHaveLength(0);
  });
});

describe("text", () => {
  test("fillText records the text, its style and its measurement", () => {
    const op = only(
      record((ctx) => {
        ctx.font = "bold 12px serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "navy";
        ctx.fillText("Hello", 10, 20, 100);
      }),
      "text",
    );
    expect(op).toMatchObject({ mode: "fill", text: "Hello", x: 10, y: 20, maxWidth: 100, paint: "#000080" });
    expect(op.style.font).toBe("bold 12px serif");
    expect(op.style.textAlign).toBe("center");
    expect(op.metrics.width).toBe(30);
  });

  test("invalid fonts and maxWidth are ignored", () => {
    const ctx = new RecordingContext(options);
    ctx.font = "nonsense";
    expect(ctx.font).toBe("10px sans-serif");
    ctx.fillText("x", 0, 0, 0);
    ctx.fillText("x", 0, NaN);
    expect(ctx.getDocument().ops).toEqual([]);
  });

  test("strokeText carries a line style", () => {
    const op = only(
      record((ctx) => {
        ctx.lineWidth = 4;
        ctx.strokeText("Hi", 0, 10);
      }),
      "text",
    ) as TextOp;
    expect(op.stroke!.lineWidth).toBe(4);
  });

  test("measureText uses the injected measurer", () => {
    expect(new RecordingContext(options).measureText("abc").width).toBe(18);
  });

  test("hit tests use the ink box, squeezed to maxWidth", () => {
    const s = new Scene(
      record((ctx) => {
        ctx.fillText("Hello", 0, 10);
        ctx.fillText("Hello", 0, 40, 15);
      }),
    );
    expect(s.hitTest({ x: 25, y: 5 }).map((h) => h.id)).toEqual(["o0"]);
    expect(s.hitTest({ x: 25, y: 35 })).toHaveLength(0);
    expect(s.hitTest({ x: 10, y: 35 }).map((h) => h.id)).toEqual(["o1"]);
  });
});

describe("isPointInPath and isPointInStroke", () => {
  test("use canvas coordinates and the current state", () => {
    const ctx = new RecordingContext();
    ctx.translate(100, 0);
    ctx.rect(0, 0, 10, 10);
    expect(ctx.isPointInPath(105, 5)).toBe(true);
    expect(ctx.isPointInPath(5, 5)).toBe(false);
    ctx.lineWidth = 4;
    expect(ctx.isPointInStroke(101, 5)).toBe(true);
    expect(ctx.isPointInStroke(105, 5)).toBe(false);
    const path = new RecordingPath2D("M0 0 H20 V20 Z");
    expect(ctx.isPointInPath(path, 115, 5)).toBe(true);
    // They use up no ids and record nothing.
    expect(ctx.getDocument().ops).toEqual([]);
  });
});

describe("documents with every op kind", () => {
  const everything = (): IRDocument =>
    record((ctx) => {
      const g = ctx.createConicGradient(0, 50, 50);
      g.addColorStop(0, "red");
      g.addColorStop(1, "blue");
      ctx.fillStyle = g;
      ctx.save();
      ctx.roundRect(0, 0, 100, 100, 12);
      ctx.clip();
      ctx.fillRect(0, 0, 100, 100);
      ctx.strokeStyle = ctx.createPattern(image, null)!;
      ctx.strokeText("Hi", 10, 50);
      ctx.restore();
      ctx.drawImage(image, 0, 0, 40, 20, 10, 10, 20, 10);
      ctx.fillText("Ok", 0, 0);
      ctx.clearRect(0, 0, 5, 5);
    });

  test("serialize, parse and serialize again gives the same JSON", () => {
    const json = serializeDocument(everything());
    expect(serializeDocument(deserializeDocument(json))).toBe(json);
  });

  test("replaying into a recording context records the same document", () => {
    const doc = everything();
    const again = new RecordingContext({
      measureText,
      describeImage: (img) => (img === image ? { src: "cat.png", width: 40, height: 20 } : null),
    });
    replayDocument(again, doc, { images: (src) => (src === "cat.png" ? image : undefined) });
    expect(again.getDocument()).toEqual(doc);
  });

  test("ops whose image can't be resolved are skipped on replay", () => {
    const again = new RecordingContext({ measureText });
    replayDocument(again, everything(), { images: () => undefined });
    expect(again.getDocument().ops.map((op) => op.kind)).toEqual(["fill", "text", "clear"]);
  });

  test("transformOp moves clips along with the op", () => {
    const doc = everything();
    const moved = transformOp(doc.ops[0]!, { a: 1, b: 0, c: 0, d: 1, e: 1000, f: 0 });
    const s = new Scene({ version: 1, ops: [moved] });
    expect(s.hitTest({ x: 1050, y: 50 })).toHaveLength(1);
    expect(s.hitTest({ x: 50, y: 50 })).toHaveLength(0);
  });
});
