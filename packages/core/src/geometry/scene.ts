import { IDENTITY, multiply } from "../math";
import type { FillRule, Group, IRDocument, JsonValue, Matrix2D, Op, PathGeometry, Point, Rect } from "../types";
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
  /** The finest cell size of the spatial index, in world units: smaller objects share cells. Default 1/64. */
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

/**
 * One op added, changed or removed: what it was and what it is, each with the
 * conservative world box the index keeps for it (null when it paints nowhere).
 * A renderer redraws where either box was.
 */
export interface SceneChange {
  readonly id: string;
  readonly before: { readonly op: Op; readonly box: Rect | null } | null;
  readonly after: { readonly op: Op; readonly box: Rect | null } | null;
}

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
  /** Each group's own ops, and its child groups, so a group's contents are found without scanning the board. */
  private readonly members = new Map<string, Set<Entry>>();
  private readonly children = new Map<string, Set<string>>();
  private readonly listeners = new Set<(change: SceneChange) => void>();

  constructor(document: IRDocument, options: SceneOptions = {}) {
    this.tolerance = options.tolerance ?? 0.1;
    this.grid = new Grid(options.cellSize ?? 1 / 64);
    for (const group of document.groups ?? []) this.groups.set(group.id, group);
    for (const group of this.groups.values()) this.link(group);
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
    return this.groupEntries(groupId).map((e) => e.op.id);
  }

  /** The group and every group nested in it. */
  private subtree(groupId: string): string[] {
    const out: string[] = [];
    const stack = [groupId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (!this.groups.has(id)) continue;
      out.push(id);
      for (const child of this.children.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  private groupEntries(groupId: string): Entry[] {
    const found: Entry[] = [];
    for (const id of this.subtree(groupId)) for (const e of this.members.get(id) ?? []) found.push(e);
    return found.sort((a, b) => a.z - b.z);
  }

  /**
   * Listens for ops being added, changed and removed, with where they were and
   * are: what a renderer needs to redraw only what changed. Returns a function
   * that stops listening.
   */
  onChange(listener: (change: SceneChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Ids of ops whose index box meets the rect, in drawing order: a cheap
   * superset of what paints there, found without building shapes, for culling.
   */
  opsIn(rect: Rect): string[] {
    const box = rectToBox(rect);
    return [...this.grid.query(box)]
      .filter((e) => {
        const c = e.coarse;
        return c.minX <= box.maxX && c.maxX >= box.minX && c.minY <= box.maxY && c.maxY >= box.minY;
      })
      .sort((a, b) => a.z - b.z)
      .map((e) => e.op.id);
  }

  /** The op's position in drawing order, or -1. */
  indexOf(id: string): number {
    return this.byId.get(id)?.z ?? -1;
  }

  private emit(id: string, before: Entry["op"] | null, beforeBox: Box | null, after: Entry | null): void {
    if (this.listeners.size === 0) return;
    const rect = (b: Box | null): Rect | null => (b === null || isEmptyBox(b) ? null : boxToRect(b));
    const change: SceneChange = {
      id,
      before: before ? { op: before, box: rect(beforeBox) } : null,
      after: after ? { op: after.op, box: rect(after.coarse) } : null,
    };
    for (const listener of this.listeners) listener(change);
  }

  private link(group: Group): void {
    if (group.parent === undefined) return;
    let set = this.children.get(group.parent);
    if (!set) this.children.set(group.parent, (set = new Set()));
    set.add(group.id);
  }

  private join(entry: Entry): void {
    if (entry.op.group === undefined) return;
    let set = this.members.get(entry.op.group);
    if (!set) this.members.set(entry.op.group, (set = new Set()));
    set.add(entry);
  }

  private leave(entry: Entry): void {
    if (entry.op.group !== undefined) this.members.get(entry.op.group)?.delete(entry);
  }

  /** Adds a group, so ops inserted later can belong to it. */
  addGroup(group: Group): void {
    if (this.groups.has(group.id) || this.byId.has(group.id)) throw new Error(`duplicate id ${group.id}`);
    if (group.parent !== undefined && !this.groups.has(group.parent)) throw new Error(`no group ${group.parent}`);
    this.groups.set(group.id, group);
    this.link(group);
  }

  get(id: string): Op | undefined {
    return this.byId.get(id)?.op;
  }

  /**
   * Geometry bounds (the path, curve extrema exact), paint bounds (what is
   * painted, stroke included), or the index's box: a cheap conservative paint
   * box computed without building the shape, as culling uses.
   */
  bounds(id: string, kind: "geometry" | "paint" | "index" = "paint"): Rect | null {
    const box = this.boxOf(id, kind);
    return box === null || isEmptyBox(box) ? null : boxToRect(box);
  }

  private boxOf(id: string, kind: "geometry" | "paint" | "index"): Box | null {
    const entry = this.byId.get(id);
    if (entry) {
      if (kind === "index") return entry.coarse;
      const shape = this.shape(entry);
      return kind === "geometry" ? shape.geometryBox : shape.paintBox;
    }
    if (!this.groups.has(id)) return null;
    // A group's bounds are the union of its ops'; clears paint nothing of their own.
    let box: Box | null = null;
    for (const entry of this.groupEntries(id)) {
      if (entry.op.kind === "clear") continue;
      const b = this.boxOf(entry.op.id, kind)!;
      if (isEmptyBox(b)) continue;
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
    }
    return box;
  }

  /**
   * Ops whose painted area contains the point, topmost first. A `clearRect`
   * or an embed covering the point hides everything drawn before it. Invisible ops are
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
      // An embed's element covers what was drawn before it.
      if (entry.op.kind === "embed" && shapeContains(shape, point, 0)) {
        hits.push({ id: entry.op.id, op: entry.op, groups: this.groupChain(entry.op.id) });
        break;
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

  /**
   * The area an op covers, as world-space rings and their fill rule: a fill's
   * outline, an image's silhouette (or box), a text op's box. Text layout flows
   * around these. Null for strokes, whose area is pieces, and for ops that
   * paint nothing. Clips are not applied.
   */
  region(id: string): { rings: Point[][]; fillRule: FillRule } | null {
    const entry = this.byId.get(id);
    if (!entry || entry.op.kind === "stroke" || entry.op.kind === "clear") return null;
    const shape = this.shape(entry);
    if (shape.rings.length === 0) return null;
    return { rings: shape.rings.map((r) => [...r]), fillRule: entry.op.kind === "fill" ? entry.op.fillRule : "nonzero" };
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
    this.update(entry, op, coarseBox(op));
  }

  private update(entry: Entry, op: Op, coarse: Box): void {
    if (op.group !== undefined && !this.groups.has(op.group)) throw new Error(`no group ${op.group}`);
    const before = entry.op;
    const beforeBox = entry.coarse;
    const regroup = before.group !== op.group;
    if (regroup) this.leave(entry);
    entry.op = op;
    entry.shape = null;
    entry.anchors = null;
    entry.edges = null;
    entry.coarse = coarse;
    if (regroup) this.join(entry);
    this.grid.insert(entry, entry.coarse);
    this.emit(op.id, before, beforeBox, entry);
  }

  /** Composes `matrix` onto the transforms of an op, or of every op in a group; see `transformOp`. */
  transform(id: string, matrix: Matrix2D): void {
    const entries = this.groups.has(id) ? this.groupEntries(id) : [this.byId.get(id)];
    // A translation, as in a drag, moves the index box as is.
    const shift = matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1;
    for (const entry of entries) {
      if (!entry) throw new Error(`no op with id ${id}`);
      const op = transformOp(entry.op, matrix);
      const c = entry.coarse;
      this.update(entry, op, shift ? { minX: c.minX + matrix.e, minY: c.minY + matrix.f, maxX: c.maxX + matrix.e, maxY: c.maxY + matrix.f } : coarseBox(op));
    }
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
    const firstOp = this.groups.has(id) ? (this.groupEntries(id)[0]?.z ?? -1) : -1;
    if (old) this.remove(id);
    const parent = options.parent ?? old?.parent;
    // A new group goes after the rest of its parent's ops, or last.
    let after = -1;
    if (parent !== undefined && firstOp < 0) after = this.groupEntries(parent).at(-1)?.z ?? -1;
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
      const doomed = this.groupEntries(id);
      // Remove from the top down, so each splice renumbers only what is above it.
      for (let i = doomed.length - 1; i >= 0; i--) this.remove(doomed[i]!.op.id);
      // Find every nested group before deleting any, since deleting a parent cuts its children's chains.
      const nested = this.subtree(id);
      const parent = this.groups.get(id)!.parent;
      if (parent !== undefined) this.children.get(parent)?.delete(id);
      for (const g of nested) {
        this.groups.delete(g);
        this.children.delete(g);
        this.members.delete(g);
      }
      return;
    }
    const entry = this.byId.get(id);
    if (!entry) return;
    this.grid.remove(entry);
    this.byId.delete(id);
    this.leave(entry);
    this.entries.splice(entry.z, 1);
    this.renumber(entry.z);
    this.emit(id, entry.op, entry.coarse, null);
  }

  private place(op: Op, index: number): void {
    if (this.byId.has(op.id)) throw new Error(`duplicate op id ${op.id}`);
    const entry: Entry = { op, z: index, coarse: coarseBox(op), shape: null, anchors: null, edges: null };
    this.entries.splice(index, 0, entry);
    if (index < this.entries.length - 1) this.renumber(index);
    this.byId.set(op.id, entry);
    this.join(entry);
    this.grid.insert(entry, entry.coarse);
    this.emit(op.id, null, null, entry);
  }

  private renumber(from: number): void {
    for (let i = from; i < this.entries.length; i++) this.entries[i]!.z = i;
  }

  private shape(entry: Entry): Shape {
    entry.shape ??= buildShape(entry.op, this.tolerance);
    return entry.shape;
  }
}
