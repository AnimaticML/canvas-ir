import { IDENTITY, multiply } from "../math";
import type { IRDocument, Matrix2D, Op, Point, Rect } from "../types";
import { type Box, boxToRect, expandBox, isEmptyBox, pathBounds, rectToBox } from "./bounds";
import { maxScale } from "./flatten";
import { Grid } from "./grid";
import {
  type ClosestPoint,
  type Shape,
  buildShape,
  shapeClosestPoint,
  shapeContains,
  shapeEnclosedBy,
  shapeIntersectsBox,
} from "./shape";

export interface SceneOptions {
  /** Maximum distance between a curve and its flattened outline, in world units. Default 0.1. */
  readonly tolerance?: number;
  /** Grid cell size for the spatial index, in world units. Default 128. */
  readonly cellSize?: number;
}

export interface HitTestOptions {
  /** Also hit ops within this world distance of their painted area. Default 0. */
  readonly tolerance?: number;
  /** Include ops drawn with `globalAlpha` 0. Default false. */
  readonly includeInvisible?: boolean;
}

export interface Hit {
  readonly id: string;
  readonly op: Op;
}

export type RectQueryMode = "intersects" | "enclosed";

export interface ClosestPointResult extends ClosestPoint {
  readonly id: string;
}

interface Entry {
  op: Op;
  z: number;
  /** A cheap conservative box for the index, computed without building the shape. */
  coarse: Box;
  shape: Shape | null;
}

/**
 * Composes `matrix` onto everything the op was drawn with, as if the drawing had
 * happened under `matrix` times its transforms. Nothing is re-recorded.
 */
export const transformOp = (op: Op, matrix: Matrix2D): Op => {
  const transform = multiply(matrix, op.transform);
  if (op.kind === "clear") return { ...op, transform };
  return { ...op, transform, path: { ...op.path, matrices: op.path.matrices.map((m) => multiply(matrix, m)) } };
};

/** Geometry bounds grown by the farthest a stroke can reach past its path: joins, caps and width. */
const coarseBox = (op: Op): Box => {
  if (op.kind === "clear") {
    const { x, y, width, height } = op.rect;
    const corners = [
      [x, y],
      [x + width, y],
      [x, y + height],
      [x + width, y + height],
    ].map(([px, py]) => ({
      x: op.transform.a * px! + op.transform.c * py! + op.transform.e,
      y: op.transform.b * px! + op.transform.d * py! + op.transform.f,
    }));
    return {
      minX: Math.min(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxX: Math.max(...corners.map((c) => c.x)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };
  }
  const geometry = pathBounds(op.path, IDENTITY);
  if (op.kind === "fill") return geometry;
  const { lineWidth, lineJoin, lineCap, miterLimit } = op.stroke;
  const reach = Math.max(1, lineJoin === "miter" ? miterLimit : 1, lineCap === "square" ? Math.SQRT2 : 1);
  return expandBox(geometry, (lineWidth / 2) * reach * maxScale(op.transform));
};

const boxDistance = (b: Box, p: Point): number => {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
};

/**
 * Geometry queries over a document: bounds, hit tests, rect queries and closest
 * points, all in world space. Shapes are derived lazily per op and cached; a
 * spatial grid narrows every query to nearby ops. Replacing or transforming an op
 * recomputes only that op.
 */
export class Scene {
  private readonly tolerance: number;
  private readonly grid: Grid<Entry>;
  private entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();

  constructor(document: IRDocument, options: SceneOptions = {}) {
    this.tolerance = options.tolerance ?? 0.1;
    this.grid = new Grid(options.cellSize ?? 128);
    document.ops.forEach((op) => this.place(op, this.entries.length));
  }

  /** The current ops, in drawing order. */
  get document(): IRDocument {
    return { version: 1, ops: this.entries.map((e) => e.op) };
  }

  get(id: string): Op | undefined {
    return this.byId.get(id)?.op;
  }

  /** Geometry bounds (the path, curve extrema exact) or paint bounds (what is painted, stroke included). */
  bounds(id: string, kind: "geometry" | "paint" = "paint"): Rect | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    const shape = this.shape(entry);
    const box = kind === "geometry" ? shape.geometryBox : shape.paintBox;
    return isEmptyBox(box) ? null : boxToRect(box);
  }

  /**
   * Ops whose painted area contains the point, topmost first. A `clearRect`
   * covering the point hides everything drawn before it.
   */
  hitTest(point: Point, options: HitTestOptions = {}): Hit[] {
    const tolerance = options.tolerance ?? 0;
    const probe = expandBox({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, tolerance);
    const candidates = [...this.grid.query(probe)].sort((a, b) => b.z - a.z);
    const hits: Hit[] = [];
    for (const entry of candidates) {
      if (boxDistance(entry.coarse, point) > tolerance) continue;
      const shape = this.shape(entry);
      if (entry.op.kind === "clear") {
        if (shapeContains(shape, point, 0)) break;
        continue;
      }
      if (!options.includeInvisible && entry.op.compositing.globalAlpha === 0) continue;
      if (shapeContains(shape, point, tolerance)) hits.push({ id: entry.op.id, op: entry.op });
    }
    return hits;
  }

  /** Ids of ops whose painted area touches (`intersects`) or lies inside (`enclosed`) the rect, in drawing order. */
  queryRect(rect: Rect, mode: RectQueryMode = "intersects"): string[] {
    const box = rectToBox(rect);
    return [...this.grid.query(box)]
      .filter((entry) => {
        if (entry.op.kind === "clear") return false;
        const c = entry.coarse;
        if (c.minX > box.maxX || c.maxX < box.minX || c.minY > box.maxY || c.maxY < box.minY) return false;
        const shape = this.shape(entry);
        return mode === "intersects" ? shapeIntersectsBox(shape, box) : shapeEnclosedBy(shape, box);
      })
      .sort((a, b) => a.z - b.z)
      .map((entry) => entry.op.id);
  }

  /** The closest point on any op's path (not its stroke outline), optionally within `maxDistance`. */
  closestPoint(point: Point, options: { maxDistance?: number; ids?: readonly string[] } = {}): ClosestPointResult | null {
    const max = options.maxDistance ?? Infinity;
    let pool: Entry[];
    if (options.ids) pool = options.ids.map((id) => this.byId.get(id)).filter((e): e is Entry => e !== undefined);
    else if (Number.isFinite(max)) pool = [...this.grid.query(expandBox({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, max))];
    else pool = this.entries;
    const ranked = pool
      .filter((e) => e.op.kind !== "clear")
      .map((e) => ({ e, d: boxDistance(e.coarse, point) }))
      .sort((a, b) => a.d - b.d);
    let best: ClosestPointResult | null = null;
    for (const { e, d } of ranked) {
      if (d > max || (best && d > best.distance)) break;
      const found = shapeClosestPoint(this.shape(e), point);
      if (found && found.distance <= max && (!best || found.distance < best.distance)) best = { ...found, id: e.op.id };
    }
    return best;
  }

  /** Replaces the op with the same id. */
  replace(op: Op): void {
    const entry = this.byId.get(op.id);
    if (!entry) throw new Error(`no op with id ${op.id}`);
    this.byId.delete(entry.op.id);
    entry.op = op;
    entry.shape = null;
    entry.coarse = coarseBox(op);
    this.byId.set(op.id, entry);
    this.grid.insert(entry, entry.coarse);
  }

  /** Composes `matrix` onto the op's transforms; see `transformOp`. */
  transform(id: string, matrix: Matrix2D): void {
    const op = this.get(id);
    if (!op) throw new Error(`no op with id ${id}`);
    this.replace(transformOp(op, matrix));
  }

  /** Inserts an op at `index` in drawing order (default: on top). */
  insert(op: Op, index = this.entries.length): void {
    if (this.byId.has(op.id)) throw new Error(`duplicate op id ${op.id}`);
    this.place(op, index);
  }

  remove(id: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.grid.remove(entry);
    this.byId.delete(id);
    this.entries.splice(entry.z, 1);
    this.renumber(entry.z);
  }

  private place(op: Op, index: number): void {
    if (this.byId.has(op.id)) throw new Error(`duplicate op id ${op.id}`);
    const entry: Entry = { op, z: index, coarse: coarseBox(op), shape: null };
    this.entries.splice(index, 0, entry);
    if (index < this.entries.length - 1) this.renumber(index);
    this.byId.set(op.id, entry);
    this.grid.insert(entry, entry.coarse);
  }

  private renumber(from: number): void {
    for (let i = from; i < this.entries.length; i++) this.entries[i]!.z = i;
  }

  private shape(entry: Entry): Shape {
    entry.shape ??= buildShape(entry.op, this.tolerance);
    return entry.shape;
  }
}
