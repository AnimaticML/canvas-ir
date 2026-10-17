import { describe, expect, test } from "bun:test";
import { type FillOp, type IRDocument, RecordingContext, keyByMeta, mixColors, morph, pathRings, replayDocument } from "../src";
import { parseColor } from "../src/color";

const record = (draw: (ctx: RecordingContext) => void): IRDocument => {
  const ctx = new RecordingContext();
  draw(ctx);
  return ctx.getDocument();
};

const box = (doc: IRDocument, i = 0) => {
  const ring = pathRings((doc.ops[i] as FillOp).path, 0.01).flat();
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

const square = record((ctx) => {
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 100, 100);
});
const circle = record((ctx) => {
  ctx.fillStyle = "#0000ff";
  ctx.beginPath();
  ctx.arc(250, 50, 40, 0, Math.PI * 2);
  ctx.fill();
});

describe("morph", () => {
  test("returns the drawings themselves at the ends", () => {
    const m = morph(square, circle);
    expect(m.at(0)).toBe(square);
    expect(m.at(1)).toBe(circle);
    expect(m.paired).toBe(1);
  });

  test("moves a path smoothly from one shape to the other", () => {
    const m = morph(square, circle);
    const near0 = box(m.at(0.001));
    const near1 = box(m.at(0.999));
    expect(near0.minX).toBeCloseTo(0, 0);
    expect(near0.maxY).toBeCloseTo(100, 0);
    expect(near1.minX).toBeCloseTo(210, 0);
    expect(near1.maxX).toBeCloseTo(290, 0);
    const mid = box(m.at(0.5));
    expect(mid.minX).toBeGreaterThan(50);
    expect(mid.minX).toBeLessThan(160);
    const op = m.at(0.5).ops[0] as FillOp;
    expect(op.path.subpaths[0]!.segments.every((s) => s.kind === "cubic")).toBe(true);
  });

  test("blends colors in OKLab", () => {
    expect(mixColors("#ff0000", "#0000ff", 0)).toBe("#ff0000");
    expect(mixColors("#ff0000", "#0000ff", 1)).toBe("#0000ff");
    // The OKLab midpoint is brighter than the sRGB one (#800080).
    const mid = parseColor(mixColors("#ff0000", "#0000ff", 0.5))!;
    expect(mid.r + mid.g + mid.b).toBeGreaterThan(0x80 * 2 + 20);
    // Fading in from transparent keeps the hue rather than passing through gray.
    const fading = parseColor(mixColors("rgba(0, 0, 0, 0)", "#ff0000", 0.5))!;
    expect(fading.r).toBe(255);
    expect(fading.a).toBeCloseTo(0.5, 1);
    expect((morph(square, circle).at(0.5).ops[0] as FillOp).paint).toBe(mixColors("#ff0000", "#0000ff", 0.5));
  });

  test("turns a rotated shape instead of squashing it", () => {
    const at = (angle: number) =>
      record((ctx) => {
        ctx.translate(50, 50);
        ctx.rotate(angle);
        ctx.fillRect(-40, -10, 80, 20);
      });
    const op = morph(at(0), at(Math.PI / 2)).at(0.5).ops[0] as FillOp;
    expect(Math.hypot(op.transform.a, op.transform.b)).toBeCloseTo(1, 6);
    expect(Math.atan2(op.transform.b, op.transform.a)).toBeCloseTo(Math.PI / 4, 6);
    // Still 80 long: its corners sit 41.2 from the center.
    const ring = pathRings(op.path, 0.01).flat();
    const far = Math.max(...ring.map((p) => Math.hypot(p.x - 50, p.y - 50)));
    expect(far).toBeCloseTo(Math.hypot(40, 10), 3);
  });

  test("fades out and in the ops with no partner", () => {
    const two = record((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(20, 0, 10, 10);
    });
    const one = record((ctx) => {
      ctx.fillRect(0, 0, 10, 10);
      ctx.strokeRect(0, 40, 10, 10);
    });
    // Ids: o0 pairs; two's o1 is a fill and one's o1 a stroke, so they cross-fade.
    const m = morph(two, one);
    const frame = m.at(0.25);
    expect(frame.ops.map((o) => [o.kind, o.kind === "clear" || o.kind === "embed" ? 1 : o.compositing.globalAlpha])).toEqual([
      ["fill", 1],
      ["fill", 0.75],
      ["stroke", 0.25],
    ]);
    expect(new Set(frame.ops.map((o) => o.id)).size).toBe(3);
  });

  test("pairs drawings recorded apart by their groups' names", () => {
    const face = (x: number, eyes: number) =>
      record((ctx) => {
        if (eyes === 1) ctx.fillRect(0, 0, 5, 5); // shifts every id
        ctx.beginGroup({ meta: { name: "head" } });
        ctx.beginPath();
        ctx.arc(x, 50, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.endGroup();
      });
    const byId = morph(face(50, 0), face(150, 1));
    const byName = morph(face(50, 0), face(150, 1), { key: keyByMeta("name") });
    expect(byId.paired).toBe(1);
    expect(byName.paired).toBe(1);
    expect(byName.added).toBe(1);
    // Paired by name, the head moves: halfway it is centered at 100.
    const head = byName.at(0.5).ops.find((o) => o.group !== undefined)!;
    const b = box({ version: 1, ops: [head] });
    expect((b.minX + b.maxX) / 2).toBeCloseTo(100, 1);
  });

  test("frames replay like any drawing", () => {
    const m = morph(square, circle);
    const target = new RecordingContext();
    for (let i = 1; i < 10; i++) replayDocument(target, m.at(i / 10));
    expect(target.getDocument().ops.length).toBe(9);
  });
});
