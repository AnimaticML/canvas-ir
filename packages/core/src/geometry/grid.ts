import type { Box } from "./bounds";

const OFFSET = 2 ** 20;
const key = (cx: number, cy: number): number => (cx + OFFSET) * 2 ** 21 + (cy + OFFSET);

/**
 * A uniform grid over world space, used as the broad phase for every query.
 * Items larger than `maxCells` cells skip the grid and are always candidates,
 * so one huge background shape doesn't fill thousands of cells.
 */
export class Grid<T> {
  private readonly cells = new Map<number, Set<T>>();
  private readonly large = new Set<T>();
  private readonly placed = new Map<T, number[] | "large">();

  constructor(
    private readonly cellSize: number,
    private readonly maxCells = 64,
  ) {}

  insert(item: T, box: Box): void {
    this.remove(item);
    if (!(box.minX <= box.maxX && box.minY <= box.maxY)) return;
    const x0 = Math.floor(box.minX / this.cellSize);
    const y0 = Math.floor(box.minY / this.cellSize);
    const x1 = Math.floor(box.maxX / this.cellSize);
    const y1 = Math.floor(box.maxY / this.cellSize);
    const spanX = x1 - x0 + 1;
    const spanY = y1 - y0 + 1;
    if (!Number.isFinite(spanX * spanY) || spanX * spanY > this.maxCells || Math.abs(x0) >= OFFSET || Math.abs(x1) >= OFFSET) {
      this.large.add(item);
      this.placed.set(item, "large");
      return;
    }
    const keys: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) {
          cell = new Set();
          this.cells.set(k, cell);
        }
        cell.add(item);
        keys.push(k);
      }
    }
    this.placed.set(item, keys);
  }

  remove(item: T): void {
    const where = this.placed.get(item);
    if (where === undefined) return;
    if (where === "large") {
      this.large.delete(item);
    } else {
      for (const k of where) {
        const cell = this.cells.get(k)!;
        cell.delete(item);
        if (cell.size === 0) this.cells.delete(k);
      }
    }
    this.placed.delete(item);
  }

  /** Items whose cells overlap the box. A superset: callers still test each item's own box. */
  query(box: Box): Set<T> {
    const found = new Set<T>(this.large);
    const x0 = Math.floor(box.minX / this.cellSize);
    const y0 = Math.floor(box.minY / this.cellSize);
    const x1 = Math.floor(box.maxX / this.cellSize);
    const y1 = Math.floor(box.maxY / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const cell of this.cells.values()) for (const item of cell) found.add(item);
      return found;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(key(cx, cy));
        if (cell) for (const item of cell) found.add(item);
      }
    }
    return found;
  }
}
