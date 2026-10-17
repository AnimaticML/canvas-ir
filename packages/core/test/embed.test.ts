import { describe, expect, test } from "bun:test";
import { type EmbedOp, RecordingContext, Scene, deserializeDocument, morph, replayDocument, serializeDocument, toSVG } from "../src";

const board = () => {
  const ctx = new RecordingContext();
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 200, 200);
  ctx.save();
  ctx.translate(50, 50);
  ctx.beginGroup({ id: "player" });
  const id = ctx.embed(0, 0, 100, 60, { type: "video", src: "clip.mp4" });
  ctx.endGroup();
  ctx.restore();
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(120, 90, 50, 50);
  return { doc: ctx.getDocument(), id };
};

describe("embed", () => {
  test("records its place, content, transform and group", () => {
    const { doc, id } = board();
    const op = doc.ops[1] as EmbedOp;
    expect(op).toMatchObject({ kind: "embed", id, rect: { x: 0, y: 0, width: 100, height: 60 }, content: { type: "video", src: "clip.mp4" }, group: "player" });
    expect(op.transform.e).toBe(50);
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
  });

  test("replays as a hole onto a canvas, and as itself into a recorder", () => {
    const { doc } = board();
    const calls: string[] = [];
    const canvas = new Proxy(
      {},
      {
        get: (_, key) => (typeof key === "string" && /^[a-z]/.test(key) && !["fillStyle", "strokeStyle", "canvas", "embed", "beginGroup", "endGroup"].includes(key) ? (...args: unknown[]) => calls.push(`${key}(${args.join(",")})`) : undefined),
        set: () => true,
      },
    );
    replayDocument(canvas as never, doc);
    expect(calls).toContain("clearRect(0,0,100,60)");
    const again = new RecordingContext();
    replayDocument(again, doc);
    expect(again.getDocument().ops.map((o) => o.kind)).toEqual(["fill", "embed", "fill"]);
    expect(again.getDocument().ops[1]).toMatchObject({ content: { src: "clip.mp4" }, transform: { e: 50, f: 50 } });
  });

  test("covers what was drawn before it in hit tests, and is a target itself", () => {
    const { doc, id } = board();
    const scene = new Scene(doc);
    expect(scene.hitTest({ x: 60, y: 60 }).map((h) => h.id)).toEqual([id]);
    expect(scene.hitTest({ x: 140, y: 100 }).map((h) => h.op.kind)).toEqual(["fill", "embed"]);
    expect(scene.hitTest({ x: 10, y: 10 }).map((h) => h.op.kind)).toEqual(["fill"]);
    expect(scene.bounds(id)).toEqual({ x: 50, y: 50, width: 100, height: 60 });
    scene.transform("player", { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
    expect(scene.bounds(id)!.x).toBe(60);
  });

  test("exports to SVG as a hole with the element in it", () => {
    const svg = toSVG(board().doc, { width: 200, height: 200 });
    expect(svg).toContain("<mask");
    expect(svg).toContain(`<foreignObject data-op="o1"`);
    expect(svg).toContain(`<iframe xmlns="http://www.w3.org/1999/xhtml" src="clip.mp4"`);
    // The blue square drawn after the embed is outside the mask, on top.
    expect(svg.lastIndexOf("#0000ff")).toBeGreaterThan(svg.indexOf("foreignObject"));
  });

  test("morphs its place and keeps its content", () => {
    const at = (x: number) => {
      const ctx = new RecordingContext();
      ctx.embed(x, 0, 100, 50, { type: "video" });
      return ctx.getDocument();
    };
    const op = morph(at(0), at(100)).at(0.5).ops[0] as EmbedOp;
    expect(op.kind).toBe("embed");
    expect(op.rect.x).toBeCloseTo(50, 9);
  });
});
