import { z } from "zod";
import type { IRDocument } from "./types";

const finite = z.number().finite();
const point = z.object({ x: finite, y: finite }).strict();
const matrix = z.object({ a: finite, b: finite, c: finite, d: finite, e: finite, f: finite }).strict();
const matrixIndex = z.number().int().nonnegative();

const segment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), m: matrixIndex, to: point }).strict(),
  z.object({ kind: z.literal("quad"), m: matrixIndex, cp: point, to: point }).strict(),
  z.object({ kind: z.literal("cubic"), m: matrixIndex, cp1: point, cp2: point, to: point }).strict(),
  z
    .object({
      kind: z.literal("arc"),
      m: matrixIndex,
      center: point,
      radius: finite.nonnegative(),
      startAngle: finite,
      endAngle: finite,
      counterclockwise: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ellipse"),
      m: matrixIndex,
      center: point,
      rx: finite.nonnegative(),
      ry: finite.nonnegative(),
      rotation: finite,
      startAngle: finite,
      endAngle: finite,
      counterclockwise: z.boolean(),
    })
    .strict(),
]);

const subpath = z
  .object({
    m: matrixIndex,
    start: point,
    segments: z.array(segment),
    closed: z.boolean(),
    startImplied: z.literal(true).optional(),
  })
  .strict()
  .refine((sub) => sub.segments.length > 0 || sub.closed, "an open subpath needs a segment");

const pathGeometry = z
  .object({ matrices: z.array(matrix).min(1), subpaths: z.array(subpath).min(1) })
  .strict()
  .superRefine((path, ctx) => {
    const count = path.matrices.length;
    path.subpaths.forEach((sub, i) => {
      const indices = [sub.m, ...sub.segments.map((s) => s.m)];
      if (indices.some((m) => m >= count)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subpaths", i], message: "matrix index out of range" });
      }
    });
  });

const compositing = z
  .object({
    globalAlpha: finite.min(0).max(1),
    globalCompositeOperation: z.string(),
    filter: z.string(),
    shadowColor: z.string(),
    shadowBlur: finite.nonnegative(),
    shadowOffsetX: finite,
    shadowOffsetY: finite,
  })
  .strict();

const rect = z.object({ x: finite, y: finite, width: finite, height: finite }).strict();
const sizedRect = z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }).strict();
const stops = z.array(z.object({ offset: finite.min(0).max(1), color: z.string() }).strict());
const imageRef = z.object({ src: z.string(), width: finite.positive(), height: finite.positive() }).strict();

const paint = z.union([
  z.string(),
  z.object({ kind: z.literal("linear"), x0: finite, y0: finite, x1: finite, y1: finite, stops }).strict(),
  z
    .object({
      kind: z.literal("radial"),
      x0: finite,
      y0: finite,
      r0: finite.nonnegative(),
      x1: finite,
      y1: finite,
      r1: finite.nonnegative(),
      stops,
    })
    .strict(),
  z.object({ kind: z.literal("conic"), startAngle: finite, x: finite, y: finite, stops }).strict(),
  z
    .object({
      kind: z.literal("pattern"),
      image: imageRef,
      repetition: z.enum(["repeat", "repeat-x", "repeat-y", "no-repeat"]),
      transform: matrix,
    })
    .strict(),
]);

const strokeStyle = z
  .object({
    paint,
    lineWidth: finite.positive(),
    lineCap: z.enum(["butt", "round", "square"]),
    lineJoin: z.enum(["miter", "round", "bevel"]),
    miterLimit: finite.positive(),
    lineDash: z.array(finite.nonnegative()).refine((dash) => dash.length % 2 === 0, "lineDash must have even length"),
    lineDashOffset: finite,
  })
  .strict();

const fillRule = z.enum(["nonzero", "evenodd"]);
const clip = z.array(z.object({ fillRule, transform: matrix, path: pathGeometry }).strict()).min(1).optional();

/** Fields every painting op has, in the order ops are built, so parsed documents serialize to the same JSON. */
const base = { id: z.string(), transform: matrix, compositing, clip };

const textStyle = z
  .object({
    font: z.string(),
    textAlign: z.enum(["start", "end", "left", "right", "center"]),
    textBaseline: z.enum(["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"]),
    direction: z.enum(["ltr", "rtl", "inherit"]),
    letterSpacing: z.string(),
    wordSpacing: z.string(),
    fontKerning: z.string(),
    fontStretch: z.string(),
    fontVariantCaps: z.string(),
    textRendering: z.string(),
  })
  .strict();

const textMeasure = z
  .object({
    width: finite,
    actualBoundingBoxLeft: finite,
    actualBoundingBoxRight: finite,
    actualBoundingBoxAscent: finite,
    actualBoundingBoxDescent: finite,
    fontBoundingBoxAscent: finite,
    fontBoundingBoxDescent: finite,
  })
  .strict();

const op = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fill"), ...base, fillRule, paint, path: pathGeometry }).strict(),
  z.object({ kind: z.literal("stroke"), ...base, stroke: strokeStyle, path: pathGeometry }).strict(),
  z.object({ kind: z.literal("clear"), id: z.string(), transform: matrix, rect, clip }).strict(),
  z
    .object({
      kind: z.literal("image"),
      ...base,
      image: imageRef,
      source: sizedRect,
      dest: sizedRect,
      smoothing: z.object({ enabled: z.boolean(), quality: z.enum(["low", "medium", "high"]) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      ...base,
      mode: z.enum(["fill", "stroke"]),
      text: z.string(),
      x: finite,
      y: finite,
      maxWidth: finite.positive().optional(),
      style: textStyle,
      paint,
      stroke: strokeStyle.optional(),
      metrics: textMeasure,
    })
    .strict(),
]);

export const irDocumentSchema = z
  .object({ version: z.literal(1), ops: z.array(op) })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.ops.forEach((entry, i) => {
      if (entry.kind === "text" && (entry.mode === "stroke") !== (entry.stroke !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ops", i, "stroke"], message: "stroked text, and only that, has a stroke" });
      }
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ops", i, "id"], message: `duplicate op id ${entry.id}` });
      }
      seen.add(entry.id);
    });
  });

/** JSON for a document. Key order is fixed by how ops are built, so equal documents serialize to equal strings. */
export const serializeDocument = (document: IRDocument): string => JSON.stringify(document);

/** Parses and validates a document; throws a `ZodError` that names the bad field. */
export const deserializeDocument = (json: string): IRDocument => parseDocument(JSON.parse(json));

// The cast only narrows optional fields Zod types as `T | undefined`; the schema has checked everything else.
export const parseDocument = (value: unknown): IRDocument => irDocumentSchema.parse(value) as IRDocument;
