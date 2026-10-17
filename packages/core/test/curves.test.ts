import { describe, expect, test } from "bun:test";
import { type CubicPiece, fitCurve, pieceAt, simplifyPolyline, smoothPolyline, traceCurve } from "../src/geometry/curves";
import { RecordingContext } from "../src/context";
import type { Point } from "../src/types";

const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** The distance from p to a curve, by dense sampling. */
const distanceTo = (pieces: readonly CubicPiece[], p: Point): number => {
  let best = Infinity;
  for (const piece of pieces) for (let k = 0; k <= 400; k++) {
    const q = pieceAt(piece, k / 400);
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
};

describe("simplifyPolyline", () => {
  test("drops points on straight stretches and stays within tolerance", () => {
    const next = random(5);
    const line = Array.from({ length: 300 }, (_, i) => ({ x: i, y: 20 * Math.sin(i / 30) + (next() - 0.5) }));
    const simple = simplifyPolyline(line, 1);
    expect(simple.length).toBeLessThan(40);
    expect(simple[0]).toEqual(line[0]!);
    expect(simple.at(-1)).toEqual(line.at(-1)!);
    const seg = (p: Point, a: Point, b: Point) => {
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
      return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
    };
    for (const p of line) expect(Math.min(...simple.slice(1).map((b, i) => seg(p, simple[i]!, b)))).toBeLessThanOrEqual(1 + 1e-9);
  });

  test("a closed square of many points keeps just its corners", () => {
    const square: Point[] = [];
    for (let i = 0; i < 10; i++) square.push({ x: i, y: 0 });
    for (let i = 0; i < 10; i++) square.push({ x: 10, y: i });
    for (let i = 10; i > 0; i--) square.push({ x: i, y: 10 });
    for (let i = 10; i > 0; i--) square.push({ x: 0, y: i });
    const simple = simplifyPolyline(square, 0.1, true);
    expect(simple).toHaveLength(4);
    expect(new Set(simple.map((p) => `${p.x},${p.y}`))).toEqual(new Set(["0,0", "10,0", "10,10", "0,10"]));
  });
});

describe("fitCurve", () => {
  test("a noisy freehand stroke becomes a few pieces within tolerance", () => {
    const next = random(9);
    const stroke = Array.from({ length: 200 }, (_, i) => {
      const t = i / 199;
      return { x: 300 * t + (next() - 0.5) * 0.6, y: 80 * Math.sin(t * Math.PI * 2) + 30 * t * t + (next() - 0.5) * 0.6 };
    });
    const pieces = fitCurve(stroke, 1.5);
    expect(pieces.length).toBeLessThanOrEqual(8);
    for (const p of stroke) expect(distanceTo(pieces, p)).toBeLessThanOrEqual(1.5 + 0.05);
    // Pieces join end to end, with matching tangents away from corners.
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.from).toEqual(pieces[i - 1]!.to);
      const a = { x: pieces[i - 1]!.to.x - pieces[i - 1]!.c2.x, y: pieces[i - 1]!.to.y - pieces[i - 1]!.c2.y };
      const b = { x: pieces[i]!.c1.x - pieces[i]!.from.x, y: pieces[i]!.c1.y - pieces[i]!.from.y };
      expect((a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))).toBeCloseTo(0, 6);
    }
  });

  test("a closed loop fits smoothly, and corners stay corners", () => {
    const circle = Array.from({ length: 64 }, (_, i) => ({ x: 50 * Math.cos((i / 64) * 2 * Math.PI), y: 50 * Math.sin((i / 64) * 2 * Math.PI) }));
    const loop = fitCurve(circle, 0.25, { closed: true });
    expect(loop.length).toBeLessThanOrEqual(6);
    expect(loop.at(-1)!.to).toEqual(loop[0]!.from);
    for (const p of circle) expect(distanceTo(loop, p)).toBeLessThanOrEqual(0.3);
    // A D shape: a straight side and an arc, meeting in two corners.
    const d = [{ x: 0, y: -50 }, ...circle.filter((p) => p.x > 0), { x: 0, y: 50 }];
    const shape = fitCurve(d, 0.25, { closed: true });
    const ends = new Set(shape.map((p) => `${p.from.x},${p.from.y}`));
    expect(ends.has("0,-50") && ends.has("0,50")).toBe(true);
  });
});

describe("corner windows", () => {
  test("pixel staircases read as curves, and box corners as corners", async () => {
    const { traceMask } = await import("../src/geometry/trace");
    const disk = traceMask(60, 60, (x, y) => Math.hypot(x + 0.5 - 30, y + 0.5 - 30) < 22)[0]!;
    const box = traceMask(60, 60, (x, y) => x >= 10 && x < 50 && y >= 15 && y < 45)[0]!;
    const fit = (ring: Point[]) => fitCurve(ring, 1, { closed: true, cornerAngle: 50, cornerWindow: 3 });
    const round = fit(disk);
    expect(round.length).toBeLessThanOrEqual(12);
    // No corners: every join is smooth.
    round.forEach((piece, i) => {
      const prev = round[(i + round.length - 1) % round.length]!;
      const a = { x: prev.to.x - prev.c2.x, y: prev.to.y - prev.c2.y };
      const b = { x: piece.c1.x - piece.from.x, y: piece.c1.y - piece.from.y };
      expect((a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))).toBeCloseTo(0, 6);
    });
    for (const p of disk) expect(distanceTo(round, p)).toBeLessThanOrEqual(1.05);
    // Without the window, every pixel step is a 90° corner.
    expect(fitCurve(disk, 1, { closed: true, cornerAngle: 50 }).length).toBeGreaterThan(40);
    const square = fit(box);
    expect(new Set(square.map((p) => `${p.from.x},${p.from.y}`))).toEqual(new Set(["10,15", "50,15", "50,45", "10,45"]));
  });
});

describe("smoothPolyline", () => {
  test("passes through every point, and records as curves", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 11, y: 31 }, { x: 60, y: 0 }, { x: 80, y: 40 }];
    const pieces = smoothPolyline(pts);
    expect(pieces).toHaveLength(4);
    pieces.forEach((p, i) => {
      expect(p.from).toEqual(pts[i]!);
      expect(p.to).toEqual(pts[i + 1]!);
    });
    const ctx = new RecordingContext();
    ctx.beginPath();
    traceCurve(ctx, smoothPolyline(pts, true), true);
    ctx.stroke();
    const op = ctx.getDocument().ops[0]!;
    expect(op.kind).toBe("stroke");
  });
});
