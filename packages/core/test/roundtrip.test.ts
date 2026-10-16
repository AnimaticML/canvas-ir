import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { replayDocument, type ReplayTarget } from "../src/replay";
import { deserializeDocument, parseDocument, serializeDocument } from "../src/serialization";
import type { FillOp, IRDocument } from "../src/types";
import { record } from "./helpers";

/** A scene that touches every op kind, segment kind and a mid-path transform change. */
const scene = (ctx: RecordingContext): void => {
  ctx.fillStyle = "#0ea5e9";
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(100, 0);
  ctx.quadraticCurveTo(120, 20, 100, 40);
  ctx.bezierCurveTo(80, 60, 20, 60, 0, 40);
  ctx.closePath();
  ctx.fill("evenodd");

  ctx.save();
  ctx.translate(200, 50);
  ctx.rotate(Math.PI / 6);
  ctx.strokeStyle = "rgb(10, 20, 30)";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.setLineDash([6, 3]);
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 1.5);
  ctx.scale(2, 1);
  ctx.ellipse(0, 50, 20, 10, 0.3, 0, Math.PI, true);
  ctx.arcTo(40, 80, 40, 120, 8);
  ctx.stroke();
  ctx.restore();

  ctx.clearRect(10, 10, 5, 5);
  ctx.strokeRect(300, 300, 20, 10);
};

const sceneDocument = (): IRDocument => record(scene);

describe("serialization", () => {
  test("a document survives JSON unchanged", () => {
    const doc = sceneDocument();
    const json = serializeDocument(doc);
    expect(deserializeDocument(json)).toEqual(doc);
    expect(serializeDocument(deserializeDocument(json))).toBe(json);
  });

  test("the same calls give byte-identical JSON", () => {
    expect(serializeDocument(sceneDocument())).toBe(serializeDocument(sceneDocument()));
  });

  test.each([
    ["an unknown version", (doc: any) => ({ ...doc, version: 2 })],
    ["an unknown op kind", (doc: any) => ({ ...doc, ops: [{ ...doc.ops[0], kind: "blur" }] })],
    ["a duplicate id", (doc: any) => ({ ...doc, ops: [doc.ops[0], doc.ops[0]] })],
    [
      "a matrix index out of range",
      (doc: any) => {
        const op = doc.ops[0];
        const sub = op.path.subpaths[0];
        return { ...doc, ops: [{ ...op, path: { ...op.path, subpaths: [{ ...sub, m: 5 }] } }] };
      },
    ],
    [
      "an odd-length line dash",
      (doc: any) => {
        const op = doc.ops[1];
        return { ...doc, ops: [{ ...op, stroke: { ...op.stroke, lineDash: [1] } }] };
      },
    ],
    ["an extra field", (doc: any) => ({ ...doc, ops: [{ ...doc.ops[0], extra: true }] })],
  ])("rejects %s", (_name, corrupt) => {
    const doc = JSON.parse(serializeDocument(sceneDocument()));
    expect(() => parseDocument(corrupt(doc))).toThrow();
  });
});

describe("replay", () => {
  test("replaying into a recording context records the same document", () => {
    const doc = sceneDocument();
    const again = new RecordingContext();
    replayDocument(again, doc);
    expect(again.getDocument()).toEqual(doc);
  });

  test("makes plain Canvas calls, setting the transform only when it changes", () => {
    const calls: string[] = [];
    const target = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, name) => (...args: unknown[]) => calls.push(`${String(name)}(${args.join(",")})`),
      set: (_t, name, value) => {
        calls.push(`${String(name)}=${String(value)}`);
        return true;
      },
    }) as unknown as ReplayTarget;
    const doc = record((ctx) => {
      ctx.fillStyle = "red";
      ctx.moveTo(0, 0);
      ctx.lineTo(1, 0);
      ctx.translate(5, 0);
      ctx.lineTo(1, 1);
      ctx.lineTo(0, 1);
      ctx.fill();
    });
    replayDocument(target, doc);
    const pathCalls = calls.filter((c) => /^(setTransform|beginPath|moveTo|lineTo|fill)\(/.test(c));
    // The paint transform equals the last path matrix, so it is not set again:
    // Chromium rasterizes differently after any transform change, even to an equal matrix.
    expect(pathCalls).toEqual([
      "setTransform(1,0,0,1,0,0)",
      "beginPath()",
      "moveTo(0,0)",
      "lineTo(1,0)",
      "setTransform(1,0,0,1,5,0)",
      "lineTo(1,1)",
      "lineTo(0,1)",
      "fill(nonzero)",
    ]);
    expect(calls[0]).toBe("save()");
    expect(calls.at(-1)).toBe("restore()");
    expect(calls).toContain("fillStyle=#ff0000");
  });

  const callLog = (): { target: ReplayTarget; calls: string[] } => {
    const calls: string[] = [];
    const values: Record<string | symbol, unknown> = { filter: "none" };
    const target = new Proxy(values, {
      get: (t, name) => (name in t ? t[name] : (...args: unknown[]) => calls.push(`${String(name)}(${args.join(",")})`)),
      set: (t, name, value) => {
        t[name] = value;
        calls.push(`${String(name)}=${String(value)}`);
        return true;
      },
    }) as unknown as ReplayTarget;
    return { target, calls };
  };

  test("a path started by arc or ellipse is replayed without a moveTo", () => {
    const doc = record((ctx) => {
      ctx.ellipse(10, 10, 5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    expect((doc.ops[0] as FillOp).path.subpaths[0]!.startImplied).toBe(true);
    const { target, calls } = callLog();
    replayDocument(target, doc);
    expect(calls.filter((c) => /^(moveTo|ellipse)\(/.test(c))).toEqual([`ellipse(10,10,5,3,0,0,${Math.PI * 2},false)`]);
  });

  test("an explicit moveTo before an arc is kept", () => {
    const doc = record((ctx) => {
      ctx.moveTo(15, 10);
      ctx.arc(10, 10, 5, 0, Math.PI);
      ctx.fill();
    });
    expect((doc.ops[0] as FillOp).path.subpaths[0]!.startImplied).toBeUndefined();
    const { target, calls } = callLog();
    replayDocument(target, doc);
    expect(calls.filter((c) => /^(moveTo|arc)\(/.test(c))).toEqual([
      "moveTo(15,10)",
      `arc(10,10,5,0,${Math.PI},false)`,
    ]);
  });

  test("filter is assigned only when it differs from the target's", () => {
    const { target, calls } = callLog();
    replayDocument(target, record((ctx) => ctx.fillRect(0, 0, 1, 1)));
    expect(calls.some((c) => c.startsWith("filter="))).toBe(false);
    replayDocument(
      target,
      record((ctx) => {
        ctx.filter = "blur(2px)";
        ctx.fillRect(0, 0, 1, 1);
      }),
    );
    expect(calls).toContain("filter=blur(2px)");
  });

  test("a view matrix is applied on top of every recorded transform", () => {
    const doc = record((ctx) => {
      ctx.translate(1, 2);
      ctx.fillRect(0, 0, 1, 1);
    });
    const target = new RecordingContext();
    replayDocument(target, doc, { view: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 0 } });
    const op = target.getDocument().ops[0]!;
    expect(op.transform).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 12, f: 4 });
  });
});
