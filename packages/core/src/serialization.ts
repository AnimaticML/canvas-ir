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
  .object({ m: matrixIndex, start: point, segments: z.array(segment).min(1), closed: z.boolean() })
  .strict();

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

const strokeStyle = z
  .object({
    paint: z.string(),
    lineWidth: finite.positive(),
    lineCap: z.enum(["butt", "round", "square"]),
    lineJoin: z.enum(["miter", "round", "bevel"]),
    miterLimit: finite.positive(),
    lineDash: z.array(finite.nonnegative()).refine((dash) => dash.length % 2 === 0, "lineDash must have even length"),
    lineDashOffset: finite,
  })
  .strict();

const op = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fill"),
      id: z.string(),
      transform: matrix,
      compositing,
      fillRule: z.enum(["nonzero", "evenodd"]),
      paint: z.string(),
      path: pathGeometry,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stroke"),
      id: z.string(),
      transform: matrix,
      compositing,
      stroke: strokeStyle,
      path: pathGeometry,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clear"),
      id: z.string(),
      transform: matrix,
      rect: z.object({ x: finite, y: finite, width: finite, height: finite }).strict(),
    })
    .strict(),
]);

export const irDocumentSchema = z
  .object({ version: z.literal(1), ops: z.array(op) })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.ops.forEach((entry, i) => {
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

export const parseDocument = (value: unknown): IRDocument => irDocumentSchema.parse(value);
