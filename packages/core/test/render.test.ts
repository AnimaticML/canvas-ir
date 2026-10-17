import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { Renderer, type Surface } from "../src/render";
import type { ImageRef, Op } from "../src/types";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const measureText = (text: string) => ({
  width: text.length * 5,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: text.length * 5,
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 9,
  fontBoundingBoxDescent: 3,
});

/** Layers and image copies are recording contexts too; drawing one records an image op with its id. */
const surfaces: { context: RecordingContext; image: { src: string } }[] = [];
const describeImage = (image: unknown): ImageRef => ({ src: (image as { src?: string }).src ?? "canvas", width: 10, height: 10 });
const target = (): RecordingContext => new RecordingContext({ width: 200, height: 100, measureText, describeImage });
const createSurface = (): Surface & { context: RecordingContext } => {
  const image = { src: `surface-${surfaces.length}` };
  const surface = { context: target(), image };
  surfaces.push(surface);
  return surface;
};

/** Five boxes in a row, 30 apart; the last one is off the 200 x 100 canvas. */
const board = (draw?: (ctx: RecordingContext) => void): Scene => {
  const ctx = target();
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = ["red", "green", "blue", "gray"][i]!;
    ctx.fillRect(10 + i * 30, 10, 20, 20);
  }
  ctx.fillRect(500, 10, 20, 20);
  draw?.(ctx);
  return new Scene(ctx.getDocument());
};

const painted = (ctx: RecordingContext): Op[] => ctx.getDocument().ops.filter((op) => op.kind !== "clear");

describe("renderer", () => {
  test("the first render draws what is in view, and then nothing until something changes", () => {
    const scene = board();
    const out = target();
    const renderer = new Renderer(scene, out);
    renderer.setView(IDENTITY, 200, 100);
    expect(renderer.render()).toMatchObject({ mode: "full", ops: 4 });
    expect(renderer.render().mode).toBe("idle");
  });

  test("a move redraws where the op was and where it is, with only the ops there", () => {
    const scene = board();
    const renderer = new Renderer(scene, target());
    renderer.setView(IDENTITY, 200, 100);
    renderer.render();
    const out = target();
    const partial = new Renderer(scene, out);
    partial.setView(IDENTITY, 200, 100);
    partial.render();
    const [first] = scene.document.ops;
    // Over the second box.
    scene.transform(first!.id, { a: 1, b: 0, c: 0, d: 1, e: 25, f: 0 });
    const stats = partial.render();
    expect(stats.mode).toBe("partial");
    // One merged rect from the old place to the new, grown by the bleed.
    expect(stats.rects).toEqual([{ x: 8, y: 8, width: 49, height: 24 }]);
    expect(stats.ops).toBe(2);
  });

  test("a pan by whole pixels moves the pixels and redraws the strip it uncovers", () => {
    const scene = board();
    const out = target();
    const renderer = new Renderer(scene, out, { createSurface });
    renderer.setView(IDENTITY, 200, 100);
    renderer.render();
    renderer.setView({ ...IDENTITY, e: -30, f: 4 }, 200, 100);
    // Everything moves 30 left and 4 down: the right and top strips are new.
    const stats = renderer.render();
    expect(stats.mode).toBe("partial");
    expect(stats.rects).toEqual([
      { x: 170, y: 0, width: 30, height: 100 },
      { x: 0, y: 0, width: 170, height: 4 },
    ]);
    // A zoom redraws everything.
    renderer.setView({ ...IDENTITY, a: 2, d: 2 }, 200, 100);
    expect(renderer.render().mode).toBe("full");
  });

  test("a shadow that reaches into the damage brings its op in", () => {
    const scene = board((ctx) => {
      ctx.shadowColor = "black";
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 40;
      ctx.shadowBlur = 2;
      ctx.fillRect(100, 0, 10, 10);
    });
    const renderer = new Renderer(scene, target());
    renderer.setView(IDENTITY, 200, 100);
    renderer.render();
    const [, , blue] = scene.document.ops;
    // The blue box at 70..90 moves to 95..115, under the shadow at y 40..50.
    scene.transform(blue!.id, { a: 1, b: 0, c: 0, d: 1, e: 25, f: 30 });
    const stats = renderer.render();
    expect(stats.mode).toBe("partial");
    expect(stats.ops).toBe(2);
  });

  test("changes the renderer can't bound redraw everything", () => {
    for (const draw of [
      (ctx: RecordingContext) => {
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillRect(0, 60, 10, 10);
      },
      (ctx: RecordingContext) => {
        ctx.filter = "url(#warp)";
        ctx.fillRect(0, 60, 10, 10);
      },
    ]) {
      const scene = board(draw);
      const renderer = new Renderer(scene, target());
      renderer.setView(IDENTITY, 200, 100);
      // An unbounded op is drawn in every render, wherever the damage is.
      expect(renderer.render()).toMatchObject({ mode: "full", ops: 5 });
      const ops = scene.document.ops;
      scene.transform(ops[0]!.id, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
      expect(renderer.render()).toMatchObject({ mode: "partial", ops: 2 });
      scene.transform(ops.at(-1)!.id, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
      expect(renderer.render().mode).toBe("full");
    }
  });

  test("lifted ops draw between two cached layers", () => {
    surfaces.length = 0;
    const scene = board();
    const out = target();
    const renderer = new Renderer(scene, out, { createSurface });
    renderer.setView(IDENTITY, 200, 100);
    renderer.render();
    const [red, green, blue] = scene.document.ops;
    expect(renderer.lift([green!.id])).toBe(true);
    // The lower layer holds red, the upper blue and gray.
    expect(painted(surfaces[0]!.context).length).toBe(1);
    expect(painted(surfaces[1]!.context).length).toBe(2);
    // The first frame composites the whole canvas.
    expect(renderer.render()).toMatchObject({ mode: "layers", ops: 1, rects: [{ x: 0, y: 0, width: 200, height: 100 }] });
    scene.transform(green!.id, { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 });
    const before = out.getDocument().ops.length;
    expect(renderer.render()).toMatchObject({ mode: "layers", ops: 1 });
    const names = (ops: readonly Op[]) => ops.map((op) => (op.kind === "image" ? op.image.src : op.kind));
    // Where green was and is: on the scratch canvas, the lower layer, green, the upper layer; then copied over.
    expect(names(surfaces[2]!.context.getDocument().ops)).toEqual(["clear", "surface-0", "fill", "surface-1"]);
    expect(names(out.getDocument().ops.slice(before))).toEqual(["clear", "surface-2"]);
    // A change below redraws that part of the lower layer only.
    scene.transform(red!.id, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 40 });
    // Red is redrawn into the lower layer, and only where it was and is gets composited again.
    expect(renderer.render()).toEqual({
      mode: "layers",
      ops: 1,
      rects: [
        { x: 8, y: 8, width: 24, height: 24 },
        { x: 8, y: 48, width: 24, height: 24 },
      ],
    });
    // Drawn on the scratch canvas, then copied into the lower layer.
    expect(painted(surfaces[0]!.context).map((op) => op.kind)).toEqual(["fill", "image", "image"]);
    renderer.drop();
    expect(renderer.render().mode).toBe("full");
    expect(blue).toBeDefined();
  });

  test("a clear above the lifted ops keeps them unlayered", () => {
    const scene = board((ctx) => ctx.clearRect(0, 0, 5, 5));
    const renderer = new Renderer(scene, target(), { createSurface });
    renderer.setView(IDENTITY, 200, 100);
    expect(renderer.lift([scene.document.ops[0]!.id])).toBe(false);
    expect(renderer.render().mode).toBe("full");
  });

  test("level of detail greeks tiny text and skips specks", () => {
    const ctx = target();
    ctx.font = "10px sans-serif";
    ctx.fillText("tiny", 10, 50);
    ctx.fillRect(100, 50, 0.2, 0.2);
    ctx.fillRect(120, 50, 20, 20);
    const scene = new Scene(ctx.getDocument());
    const out = target();
    const renderer = new Renderer(scene, out);
    // At 20%, the text is 2 px tall.
    renderer.setView({ a: 0.2, b: 0, c: 0, d: 0.2, e: 0, f: 0 }, 200, 100);
    renderer.render();
    expect(painted(out).map((op) => op.kind)).toEqual(["fill", "fill"]);
    const plain = target();
    const exact = new Renderer(scene, plain, { lod: false });
    exact.setView({ a: 0.2, b: 0, c: 0, d: 0.2, e: 0, f: 0 }, 200, 100);
    exact.render();
    expect(painted(plain).map((op) => op.kind)).toEqual(["text", "fill", "fill"]);
  });
});
