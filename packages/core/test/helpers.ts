import { RecordingContext } from "../src/context";
import type { FillOp, IRDocument, Op, PathGeometry } from "../src/types";

export const record = (draw: (ctx: RecordingContext) => void): IRDocument => {
  const ctx = new RecordingContext();
  draw(ctx);
  return ctx.getDocument();
};

export const onlyOp = (doc: IRDocument): Op => {
  if (doc.ops.length !== 1) throw new Error(`expected 1 op, got ${doc.ops.length}`);
  return doc.ops[0]!;
};

/** Fills the path the callback builds and returns its geometry. */
export const pathOf = (build: (ctx: RecordingContext) => void): PathGeometry => {
  const op = onlyOp(
    record((ctx) => {
      build(ctx);
      ctx.fill();
    }),
  );
  return (op as FillOp).path;
};
