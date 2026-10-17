import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src";

const drawBadge = (ctx: RecordingContext): void => {
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 10, 10);
};

describe("captureSource", () => {
  test("keeps the line of the call that drew each op", () => {
    const ctx = new RecordingContext({ captureSource: true });
    drawBadge(ctx);
    ctx.beginPath();
    ctx.arc(5, 5, 4, 0, Math.PI * 2);
    ctx.fill();
    const [badge, dot] = ctx.getDocument().ops;
    const sources = ctx.getSources();
    expect(sources.get(badge!.id)).toMatch(/^drawBadge \(.*source\.test\.ts:6:\d+\)$/);
    expect(sources.get(dot!.id)).toMatch(/source\.test\.ts:15:\d+/);
  });

  test("is empty without the option, and the proxy still records the same document", () => {
    const plain = new RecordingContext();
    const traced = new RecordingContext({ captureSource: true });
    for (const ctx of [plain, traced]) {
      ctx.save();
      ctx.translate(3, 4);
      drawBadge(ctx);
      ctx.restore();
      ctx.font = "12px sans-serif";
      expect(ctx.font).toBe("12px sans-serif");
    }
    expect(plain.getSources().size).toBe(0);
    expect(traced.getDocument()).toEqual(plain.getDocument());
    expect(traced instanceof RecordingContext).toBe(true);
  });
});
