import type { Box } from "./bounds";

/** Levels above the base cell size, each twice as coarse. */
const LEVELS = 96;

/** Mixes a level and a cell into a 31-bit key. Two cells sharing a key only cost extra candidates. */
const key = (level: number, cx: number, cy: number): number => {
  let h = Math.imul(level + 1, 0x27d4eb2d) ^ Math.imul(cx | 0, 0x165667b1) ^ Math.imul(cy | 0, 0x9e3779b1);
  // Coordinates past 2^31 cells fold their high part in instead of overflowing.
  h ^= Math.imul(Math.floor(cx / 2 ** 31) | 0, 0x85ebca6b) ^ Math.imul(Math.floor(cy / 2 ** 31) | 0, 0xc2b2ae35);
  return h >>> 1;
};

interface Placement {
  readonly level: number;
  readonly keys: readonly number[];
}

/**
 * A hierarchical grid over world space, used as the broad phase for every
 * query. Level k has cells `cellSize * 2^k` wide, and each item is stored at
 * the finest level where its box covers at most 2 x 2 cells, so tiny and huge
 * items alike sit in a few cells and an update is constant time. Cells are
 * hashed, so the world has no edge. A query visits a level's cells, or, when
 * that level holds fewer items than the query covers cells, its items.
 */
export class Grid<T> {
  private readonly cells = new Map<number, T[]>();
  /** Every item, by level, with its box: what a query scans when a level has fewer items than cells to visit. */
  private readonly levels: Map<T, Box>[] = Array.from({ length: LEVELS + 1 }, () => new Map());
  /** Items with a box no level holds, such as an infinite one. Always candidates. */
  private readonly unbounded = new Set<T>();
  private readonly placed = new Map<T, Placement | "unbounded">();

  constructor(private readonly cellSize: number) {}

  insert(item: T, box: Box): void {
    if (this.stays(item, box)) return;
    this.remove(item);
    if (!(box.minX <= box.maxX && box.minY <= box.maxY)) return;
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY);
    if (!(span <= this.cellSize * 2 ** LEVELS) || !Number.isFinite(box.minX) || !Number.isFinite(box.minY)) {
      this.unbounded.add(item);
      this.placed.set(item, "unbounded");
      return;
    }
    // A box no wider than one cell covers at most 2 x 2 cells.
    const level = span <= this.cellSize ? 0 : Math.min(LEVELS, Math.ceil(Math.log2(span / this.cellSize)));
    const size = this.cellSize * 2 ** level;
    const x0 = Math.floor(box.minX / size);
    const y0 = Math.floor(box.minY / size);
    const x1 = Math.floor(box.maxX / size);
    const y1 = Math.floor(box.maxY / size);
    const keys: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(level, cx, cy);
        const cell = this.cells.get(k);
        if (!cell) this.cells.set(k, [item]);
        else if (!cell.includes(item)) cell.push(item);
        else continue;
        keys.push(k);
      }
    }
    this.levels[level]!.set(item, box);
    this.placed.set(item, { level, keys });
  }

  /** Whether a moved item keeps its level and cells, as after a small drag: then only its box is updated. */
  private stays(item: T, box: Box): boolean {
    const where = this.placed.get(item);
    if (where === undefined || where === "unbounded") return false;
    const old = this.levels[where.level]!.get(item)!;
    const size = this.cellSize * 2 ** where.level;
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY);
    if (!(span <= size) || (where.level > 0 && span <= size / 2)) return false;
    const same =
      Math.floor(box.minX / size) === Math.floor(old.minX / size) &&
      Math.floor(box.minY / size) === Math.floor(old.minY / size) &&
      Math.floor(box.maxX / size) === Math.floor(old.maxX / size) &&
      Math.floor(box.maxY / size) === Math.floor(old.maxY / size);
    if (same) this.levels[where.level]!.set(item, box);
    return same;
  }

  remove(item: T): void {
    const where = this.placed.get(item);
    if (where === undefined) return;
    if (where === "unbounded") {
      this.unbounded.delete(item);
    } else {
      for (const k of where.keys) {
        const cell = this.cells.get(k)!;
        if (cell.length === 1) {
          this.cells.delete(k);
          continue;
        }
        const at = cell.indexOf(item);
        cell[at] = cell[cell.length - 1]!;
        cell.pop();
      }
      this.levels[where.level]!.delete(item);
    }
    this.placed.delete(item);
  }

  /** Items whose cells overlap the box. A superset: callers still test each item's own box. */
  query(box: Box): Set<T> {
    const found = new Set<T>(this.unbounded);
    let size = this.cellSize;
    for (let level = 0; level <= LEVELS; level++, size *= 2) {
      const items = this.levels[level]!;
      if (items.size === 0) continue;
      const x0 = Math.floor(box.minX / size);
      const y0 = Math.floor(box.minY / size);
      const x1 = Math.floor(box.maxX / size);
      const y1 = Math.floor(box.maxY / size);
      const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (!(cellCount <= items.size)) {
        for (const [item, b] of items) {
          if (b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY) found.add(item);
        }
        continue;
      }
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const cell = this.cells.get(key(level, cx, cy));
          if (cell) for (const item of cell) found.add(item);
        }
      }
    }
    return found;
  }
}
