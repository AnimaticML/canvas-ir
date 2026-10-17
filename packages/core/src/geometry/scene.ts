import { IDENTITY, multiply } from "../math";
import type { Group, IRDocument, JsonValue, Matrix2D, Op, PathGeometry, Point, Rect } from "../types";
import { type Box, boxToRect, expandBox, isEmptyBox, pathBounds, rectToBox } from "./bounds";
import { maxScale } from "./flatten";
import { Grid } from "./grid";
import {
  type ClosestPoint,
  type Shape,
  buildShape,
  buildUnclipped,
  shapeClosestPoint,
  shapeContains,
  shapeEnclosedBy,
  shapeIntersectsBox,
  shapeEnclosedByPolygon,
  shapeTouchesPolygon,
} from "./shape";
import { type Anchor, type AnchorKind, type Edge, boxAnchors, edgeIntersections, opAnchors, outlineEdges } from "./features";
import { segmentClosest } from "./predicates";
import { opIsInvisible } from "./visibility";

export interface SceneOptions {
  /** Maximum distance between a curve and its flattened outline, in world units. Default 0.1. */
  readonly tolerance?: number;
  /** Grid cell size for the spatial index, in world units. Default 128. */
  readonly cellSize?: number;
}

export interface HitTestOptions {
  /** Also hit ops within this world distance of their painted area. Default 0. */
  readonly tolerance?: number;
  /** Include ops that paint nothing visible: `globalAlpha` 0, or a fully transparent paint. Default false. */
  readonly includeInvisible?: boolean;
}

export interface QueryOptions {
  /** Include ops that paint nothing visible, as hit tests can. Default false. */
  readonly includeInvisible?: boolean;
}

export interface Hit {
  readonly id: string;
  readonly op: Op;
  /** The groups the op is in, innermost first. */
  readonly groups: readonly string[];
}

export type RectQueryMode = "intersects" | "enclosed";

/** What a snap landed on: an anchor's kind, a crossing of two outlines, or the nearest point on an outline. */
export type SnapKind = AnchorKind | "intersection" | "path";

export interface SnapOptions {
  /** How far, in world units, a candidate may be from the point. */
  readonly radius: number;
  /** Kinds to consider, in priority order: an earlier kind within the radius beats a nearer later one. Default `SNAP_PRIORITY`. */
  readonly kinds?: readonly SnapKind[];
  /** Op or group ids to ignore, such as what is being dragged. Groups whose meta has `snap: false` are always ignored. */
  readonly exclude?: readonly string[];
  /** Keeps only ops this returns true for, such as ones of chosen kinds or layers. */
  readonly filter?: (op: Op) => boolean;
}

export interface Snap {
  readonly point: Point;
  readonly kind: SnapKind;
  /** The op the anchor or nearest point is on, or the two ops that cross. */
  readonly ids: readonly string[];
  readonly distance: number;
}

/** The default snap priority: vertices first, the nearest point on any outline last. */
export const SNAP_PRIORITY: readonly SnapKind[] = ["vertex", "intersection", "center", "midpoint", "extreme", "baseline", "bounds", "path"];

export interface ClosestPointResult extends ClosestPoint {
  readonly id: string;
}

interface Entry {
  op: Op;
  z: number;
  /** A cheap conservative box for the index, computed without building the shape. */
  coarse: Box;
  shape: Shape | null;
  anchors: Anchor[] | null;
  edges: Edge[] | null;
}

/**
 * Composes `matrix` onto everything the op was drawn with, as if the drawing had
 * happened under `matrix` times its transforms. Nothing is re-recorded.
 */
export const transformOp = (op: Op, matrix: Matrix2D): Op => {
  const moveGeometry = (path: PathGeometry): PathGeometry => ({
    ...path,
    matrices: path.matrices.map((m) => multiply(matrix, m)),
  });
  const transform = multiply(matrix, op.transform);
  const clip = op.clip?.map((c) => ({ ...c, transform: multiply(matrix, c.transform), path: moveGeometry(c.path) }));
  const moved = { ...op, transform, ...(clip ? { clip } : {}) };
  return moved.kind === "fill" || moved.kind === "stroke" ? { ...moved, path: moveGeometry(moved.path) } : moved;
};

/** Geometry bounds grown by the farthest a stroke can reach past its path: joins, caps and width. */
const coarseBox = (op: Op): Box => {
  let box: Box;
  if (op.kind === "fill") {
    box = pathBounds(op.path, IDENTITY);
  } else if (op.kind === "stroke") {
    const { lineWidth, lineJoin, lineCap, miterLimit } = op.stroke;
    const reach = Math.max(1, lineJoin === "miter" ? miterLimit : 1, lineCap === "square" ? Math.SQRT2 : 1);
    box = expandBox(pathBounds(op.path, IDENTITY), (lineWidth / 2) * reach * maxScale(op.transform));
  } else {
    // Clears, images and text are boxes; their unclipped shape is as cheap as a bound.
    box = buildUnclipped(op, 1).paintBox;
  }
  for (const c of op.clip ?? []) {
    const b = pathBounds(c.path, IDENTITY);
    box = { minX: Math.max(box.minX, b.minX), minY: Math.max(box.minY, b.minY), maxX: Math.min(box.maxX, b.maxX), maxY: Math.min(box.maxY, b.maxY) };
  }
  return box;
};

const boxDistance = (b: Box, p: Point): number => {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
};

const segmentDistance = (p: Point, a: Point, b: Point): number => segmentClosest(p, a, b).distance;

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
  private readonly groups = new Map<string, Group>();

  constructor(document: IRDocument, options: SceneOptions = {}) {
    this.tolerance = options.tolerance ?? 0.1;
    this.grid = new Grid(options.cellSize ?? 128);
    for (const group of document.groups ?? []) this.groups.set(group.id, group);
    document.ops.forEach((op) => this.place(op, this.entries.length));
  }

  /** The current ops and groups, in drawing order. */
  get document(): IRDocument {
    const ops = this.entries.map((e) => e.op);
    return this.groups.size > 0 ? { version: 1, ops, groups: [...this.groups.values()] } : { version: 1, ops };
  }

  getGroup(id: string): Group | undefined {
    return this.groups.get(id);
  }

  /** The groups an op or group is in, innermost first. */
  groupChain(id: string): string[] {
    const chain: string[] = [];
    let current = this.byId.get(id)?.op.group ?? this.groups.get(id)?.parent;
    while (current !== undefined) {
      chain.push(current);
      current = this.groups.get(current)?.parent;
    }
    return chain;
  }

  /** Ids of the ops in a group or any group nested in it, in drawing order. */
  groupOps(groupId: string): string[] {
    return this.entries.filter((e) => e.op.group !== undefined && (e.op.group === groupId || this.groupChain(e.op.id).includes(groupId))).map((e) => e.op.id);
  }

  /** Adds a group, so ops inserted later can belong to it. */
  addGroup(group: Group): void {
    if (this.groups.has(group.id) || this.byId.has(group.id)) throw new Error(`duplicate id ${group.id}`);
    if (group.parent !== undefined && !this.groups.has(group.parent)) throw new Error(`no group ${group.parent}`);
    this.groups.set(group.id, group);
  }

  get(id: string): Op | undefined {
    return this.byId.get(id)?.op;
  }

  /** Geometry bounds (the path, curve extrema exact) or paint bounds (what is painted, stroke included). */
  bounds(id: string, kind: "geometry" | "paint" = "paint"): Rect | null {
    const box = this.boxOf(id, kind);
    return box === null || isEmptyBox(box) ? null : boxToRect(box);
  }

  private boxOf(id: string, kind: "geometry" | "paint"): Box | null {
    const entry = this.byId.get(id);
    if (entry) {
      const shape = this.shape(entry);
      return kind === "geometry" ? shape.geometryBox : shape.paintBox;
    }
    if (!this.groups.has(id)) return null;
    // A group's bounds are the union of its ops'; clears paint nothing of their own.
    let box: Box | null = null;
    for (const opId of this.groupOps(id)) {
      if (this.byId.get(opId)!.op.kind === "clear") continue;
      const b = this.boxOf(opId, kind)!;
      if (isEmptyBox(b)) continue;
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
    }
    return box;
  }

  /**
   * Ops whose painted area contains the point, topmost first. A `clearRect`
   * covering the point hides everything drawn before it. Invisible ops are
   * skipped, unless they are in a group whose meta has `hitArea: true`: a
   * transparent shape there is a deliberate target, such as a slider's grip.
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
      if (!options.includeInvisible && opIsInvisible(entry.op) && !this.flagged(entry.op.id, "hitArea", true)) continue;
      if (shapeContains(shape, point, tolerance)) hits.push({ id: entry.op.id, op: entry.op, groups: this.groupChain(entry.op.id) });
    }
    return hits;
  }

  /** Ids of ops whose painted area touches (`intersects`) or lies inside (`enclosed`) the rect, in drawing order. */
  queryRect(rect: Rect, mode: RectQueryMode = "intersects", options: QueryOptions = {}): string[] {
    const box = rectToBox(rect);
    return [...this.grid.query(box)]
      .filter((entry) => {
        if (entry.op.kind === "clear") return false;
        if (!options.includeInvisible && opIsInvisible(entry.op)) return false;
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

  /** Ids of ops whose painted area touches or lies inside a polygon (a lasso), in drawing order. */
  queryPolygon(polygon: readonly Point[], mode: RectQueryMode = "intersects", options: QueryOptions = {}): string[] {
    if (polygon.length < 3) return [];
    const box = polygon.reduce(
      (b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    return [...this.grid.query(box)]
      .filter((entry) => {
        if (entry.op.kind === "clear") return false;
        if (!options.includeInvisible && opIsInvisible(entry.op)) return false;
        const shape = this.shape(entry);
        return mode === "intersects" ? shapeTouchesPolygon(shape, polygon) : shapeEnclosedByPolygon(shape, polygon);
      })
      .sort((a, b) => a.z - b.z)
      .map((entry) => entry.op.id);
  }

  /**
   * Snap points of an op, or of every op in a group plus the group's bounds:
   * vertices, midpoints, centers, curve extremes, text baselines and bounding-box
   * points, in world space. Curves are exact, not flattened.
   */
  anchors(id: string): Anchor[] {
    const entry = this.byId.get(id);
    if (entry) return this.anchorsOf(entry);
    if (!this.groups.has(id)) return [];
    const ops = this.groupOps(id).map((opId) => this.byId.get(opId)!).filter((e) => e.op.kind !== "clear");
    const box = this.boxOf(id, "geometry");
    return [...ops.flatMap((e) => this.anchorsOf(e)), ...(box ? boxAnchors(box) : [])];
  }

  /**
   * Where the outlines of two ops cross: a fill's or stroke's path, or the box of
   * text and images. Exact for straight edges, within the scene's tolerance for curves.
   */
  intersections(a: string, b: string): Point[] {
    const ea = this.byId.get(a);
    const eb = this.byId.get(b);
    if (!ea || !eb) return [];
    return edgeIntersections(this.edgesOf(ea), this.edgesOf(eb), this.tolerance / 100);
  }

  /**
   * The best place near `point` to snap to: anchors, crossings of two outlines,
   * and the nearest point on an outline, within `radius`. The kind earliest in
   * `kinds` wins; among the same kind, the nearest.
   */
  snap(point: Point, options: SnapOptions): Snap | null {
    const { radius } = options;
    const kinds = options.kinds ?? SNAP_PRIORITY;
    const rank = (kind: SnapKind): number => kinds.indexOf(kind);
    const excluded = new Set<string>();
    for (const id of options.exclude ?? []) {
      if (this.groups.has(id)) for (const opId of this.groupOps(id)) excluded.add(opId);
      else excluded.add(id);
    }
    const probe = expandBox({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, radius);
    const pool = [...this.grid.query(probe)]
      .filter(
        (e) =>
          e.op.kind !== "clear" &&
          !excluded.has(e.op.id) &&
          !opIsInvisible(e.op) &&
          boxDistance(e.coarse, point) <= radius &&
          !this.flagged(e.op.id, "snap", false) &&
          (!options.filter || options.filter(e.op)),
      )
      .sort((a, b) => b.z - a.z);
    let best: Snap | null = null;
    const offer = (candidate: Snap): void => {
      const r = rank(candidate.kind);
      if (r < 0 || candidate.distance > radius) return;
      if (!best || r < rank(best.kind) || (r === rank(best.kind) && candidate.distance < best.distance)) best = candidate;
    };
    const near = (p: Point) => Math.hypot(p.x - point.x, p.y - point.y);
    for (const e of pool) {
      for (const a of this.anchorsOf(e)) offer({ point: a.point, kind: a.kind, ids: [e.op.id], distance: near(a.point) });
    }
    if (rank("intersection") >= 0) {
      // Only edges near the point can cross near it.
      const local = pool.map((e) => ({
        id: e.op.id,
        edges: this.edgesOf(e).filter((edge) => segmentDistance(point, edge.a, edge.b) <= radius),
      }));
      for (let i = 0; i < local.length; i++) {
        for (let j = i + 1; j < local.length; j++) {
          for (const p of edgeIntersections(local[i]!.edges, local[j]!.edges, this.tolerance / 100)) {
            offer({ point: p, kind: "intersection", ids: [local[i]!.id, local[j]!.id], distance: near(p) });
          }
        }
      }
    }
    if (rank("path") >= 0) {
      const found = this.closestPoint(point, { maxDistance: radius, ids: pool.map((e) => e.op.id) });
      if (found) offer({ point: found.point, kind: "path", ids: [found.id], distance: found.distance });
    }
    return best;
  }

  /** Whether a group the op is in has `meta[key] === value`. */
  private flagged(opId: string, key: string, value: JsonValue): boolean {
    return this.groupChain(opId).some((g) => this.groups.get(g)?.meta?.[key] === value);
  }

  private anchorsOf(entry: Entry): Anchor[] {
    entry.anchors ??= opAnchors(entry.op, this.shape(entry));
    return entry.anchors;
  }

  private edgesOf(entry: Entry): Edge[] {
    entry.edges ??= outlineEdges(this.shape(entry));
    return entry.edges;
  }

  /** Replaces the op with the same id. */
  replace(op: Op): void {
    const entry = this.byId.get(op.id);
    if (!entry) throw new Error(`no op with id ${op.id}`);
    this.byId.delete(entry.op.id);
    entry.op = op;
    entry.shape = null;
    entry.anchors = null;
    entry.edges = null;
    entry.coarse = coarseBox(op);
    this.byId.set(op.id, entry);
    this.grid.insert(entry, entry.coarse);
  }

  /** Composes `matrix` onto the transforms of an op, or of every op in a group; see `transformOp`. */
  transform(id: string, matrix: Matrix2D): void {
    if (this.groups.has(id)) {
      for (const opId of this.groupOps(id)) this.replace(transformOp(this.get(opId)!, matrix));
      return;
    }
    const op = this.get(id);
    if (!op) throw new Error(`no op with id ${id}`);
    this.replace(transformOp(op, matrix));
  }

  /** Inserts an op at `index` in drawing order (default: on top). */
  insert(op: Op, index = this.entries.length): void {
    if (this.byId.has(op.id)) throw new Error(`duplicate op id ${op.id}`);
    if (op.group !== undefined && !this.groups.has(op.group)) throw new Error(`no group ${op.group}`);
    this.place(op, index);
  }

  /**
   * Swaps a group's contents for newly recorded ones, in place in drawing order:
   * how a component that drew itself into a group redraws after a change. The
   * document must hold the group (under its id) and only groups nested in it,
   * and its ops must all belong to them. Nested group and op ids are prefixed
   * with `id/` so they can't collide with the rest of the scene. The group keeps
   * its parent unless `parent` names another; a new group's ops go after its
   * parent's. Returns the new op ids.
   */
  replaceGroup(id: string, document: IRDocument, options: { parent?: string } = {}): string[] {
    const groups = document.groups ?? [];
    const root = groups.find((g) => g.id === id);
    const inside = (g: Group): boolean => {
      for (let p: string | undefined = g.parent; p !== undefined; p = groups.find((x) => x.id === p)?.parent) if (p === id) return true;
      return false;
    };
    for (const g of groups) if (g.id !== id && !inside(g)) throw new Error(`group ${g.id} is not inside ${id}`);
    for (const op of document.ops) if (op.group === undefined || (op.group !== id && !inside(groups.find((g) => g.id === op.group)!))) {
      throw new Error(`op ${op.id} is not inside ${id}`);
    }
    const rename = (x: string): string => (x === id || x.startsWith(`${id}/`) ? x : `${id}/${x}`);
    const old = this.groups.get(id);
    const firstOp = this.entries.findIndex((e) => e.op.group === id || (e.op.group !== undefined && this.groupChain(e.op.id).includes(id)));
    if (old) this.remove(id);
    const parent = options.parent ?? old?.parent;
    // A new group goes after the rest of its parent's ops, or last.
    let after = -1;
    if (parent !== undefined && firstOp < 0) {
      for (let i = this.entries.length - 1; i >= 0 && after < 0; i--) {
        const op = this.entries[i]!.op;
        if (op.group === parent || (op.group !== undefined && this.groupChain(op.id).includes(parent))) after = i;
      }
    }
    const index = firstOp >= 0 ? firstOp : after >= 0 ? after + 1 : this.entries.length;
    const meta = root?.meta ?? old?.meta;
    this.addGroup({ id, ...(parent !== undefined ? { parent } : {}), ...(meta !== undefined ? { meta } : {}) });
    for (const g of groups) if (g.id !== id) this.addGroup({ ...g, id: rename(g.id), parent: rename(g.parent!) });
    return document.ops.map((op, i) => {
      const renamed = { ...op, id: rename(op.id), group: rename(op.group!) } as Op;
      this.insert(renamed, index + i);
      return renamed.id;
    });
  }

  /** Removes an op, or a group with its ops and nested groups. */
  remove(id: string): void {
    if (this.groups.has(id)) {
      for (const opId of this.groupOps(id)) this.remove(opId);
      // Find every nested group before deleting any, since deleting a parent cuts its children's chains.
      const nested = [...this.groups.values()].filter((g) => g.id === id || this.groupChain(g.id).includes(id));
      for (const g of nested) this.groups.delete(g.id);
      return;
    }
    const entry = this.byId.get(id);
    if (!entry) return;
    this.grid.remove(entry);
    this.byId.delete(id);
    this.entries.splice(entry.z, 1);
    this.renumber(entry.z);
  }

  private place(op: Op, index: number): void {
    if (this.byId.has(op.id)) throw new Error(`duplicate op id ${op.id}`);
    const entry: Entry = { op, z: index, coarse: coarseBox(op), shape: null, anchors: null, edges: null };
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
