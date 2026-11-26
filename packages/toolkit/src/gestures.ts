// Pointers turned into gestures: a tap, a drag, a two-finger pinch and twist. It decides only what kind of gesture the pointers
// make; what a tap selects, what a drag moves and what a pinch zooms is the host's, which handles them in its own
// coordinates and commits what they mean. It knows nothing of the DOM: `bindGestures` (dom.ts) feeds it a canvas's
// pointer events, and tests feed it points.
//
// The rules every board ended up writing by hand:
// - A press becomes a drag only once it has moved past a few pixels; until then its release is a tap.
// - A second finger turns the press into a pinch: the press is cancelled (no tap, no drag end), so whatever it began,
//   such as a pressed button, can let go.
// - After a pinch, the finger left on the screen does nothing until every finger is up: it must not resume a drag or
//   tap on release.
// - A cancelled pointer (the browser took it for scrolling, or the window lost it) ends the gesture without a tap.
import type { Point } from "canvas-ir";

export interface DragEvent {
  readonly pointerId: number;
  /** Where the pointer is now and where the press began, in the coordinates it was fed in. */
  readonly point: Point;
  readonly start: Point;
  /** The movement since the last drag event, and since the press began. */
  readonly delta: Point;
  readonly total: Point;
}

export interface PinchEvent {
  /** The middle of the two fingers, and how far apart they are. */
  readonly center: Point;
  readonly distance: number;
  /** The direction from the first finger to the second, in radians, clockwise on screen from the x axis. */
  readonly angle: number;
  /** Since the last pinch event: the change in their spread as a factor, and how far their middle moved. */
  readonly scale: number;
  readonly pan: Point;
  /** Since the last pinch event, how far the fingers turned, in radians, clockwise on screen; never more than half a turn. */
  readonly twist: number;
}

/** An angle brought within half a turn either way (from -π up to π), so a twist across the ±π seam is the short way round. */
export const wrapAngle = (a: number): number => a - Math.floor((a + Math.PI) / (2 * Math.PI)) * 2 * Math.PI;

export interface GestureHandlers {
  /** A first pointer went down: a press began. */
  press?(point: Point, pointerId: number): void;
  /** A pointer moved with nothing pressed, as a mouse hovering. */
  hover?(point: Point): void;
  dragStart?(e: DragEvent): void;
  drag?(e: DragEvent): void;
  dragEnd?(e: DragEvent): void;
  /** A press let go where it began. */
  tap?(point: Point, pointerId: number): void;
  pinchStart?(e: PinchEvent): void;
  pinch?(e: PinchEvent): void;
  pinchEnd?(): void;
  /** A press or drag ended without a tap or drag end: a second finger came, or the pointer was cancelled. */
  cancel?(): void;
}

export interface GestureOptions {
  /** How far a press moves, in pixels, before it is a drag rather than a tap. Default 6. */
  readonly slop?: number;
}

export class Gestures {
  private readonly pointers = new Map<number, Point>();
  private readonly slop: number;
  /** The single press under way, if any. */
  private press: { id: number; start: Point; last: Point; dragging: boolean } | null = null;
  /** More than one finger has been down since the screen was last clear: nothing taps or drags until it is. */
  private multi = false;
  private spread: { ids: [number, number]; distance: number; center: Point; angle: number } | null = null;

  constructor(
    private readonly on: GestureHandlers,
    options: GestureOptions = {},
  ) {
    this.slop = options.slop ?? 6;
  }

  /** How many pointers are down. */
  get active(): number {
    return this.pointers.size;
  }

  get pinching(): boolean {
    return this.spread !== null;
  }

  /** Whether more than one finger has been down since the screen was last clear: a host stops routing the press. */
  get multiTouch(): boolean {
    return this.multi;
  }

  get dragging(): boolean {
    return !!this.press?.dragging;
  }

  down(id: number, point: Point): void {
    this.pointers.set(id, point);
    if (this.pointers.size === 1 && !this.multi) {
      this.press = { id, start: point, last: point, dragging: false };
      this.on.press?.(point, id);
      return;
    }
    this.multi = true;
    if (this.press) {
      this.press = null;
      this.on.cancel?.();
    }
    if (!this.spread && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.keys()] as [number, number];
      const s = this.measure(a, b);
      this.spread = { ids: [a, b], ...s };
      this.on.pinchStart?.({ ...s, scale: 1, pan: { x: 0, y: 0 }, twist: 0 });
    }
  }

  move(id: number, point: Point): void {
    if (!this.pointers.has(id)) {
      if (this.pointers.size === 0) this.on.hover?.(point);
      return;
    }
    this.pointers.set(id, point);
    if (this.spread) {
      if (!this.spread.ids.includes(id)) return;
      const s = this.measure(...this.spread.ids);
      const was = this.spread;
      this.spread = { ids: was.ids, ...s };
      this.on.pinch?.({
        ...s,
        scale: s.distance / Math.max(1, was.distance),
        pan: { x: s.center.x - was.center.x, y: s.center.y - was.center.y },
        twist: wrapAngle(s.angle - was.angle),
      });
      return;
    }
    const p = this.press;
    if (!p || p.id !== id) return;
    if (!p.dragging) {
      if (Math.hypot(point.x - p.start.x, point.y - p.start.y) <= this.slop) return;
      p.dragging = true;
      this.on.dragStart?.(this.dragEvent(p, p.start));
    }
    this.on.drag?.(this.dragEvent(p, point));
    p.last = point;
  }

  up(id: number, point?: Point): void {
    if (!this.pointers.has(id)) return;
    const at = point ?? this.pointers.get(id)!;
    this.pointers.delete(id);
    this.endSpread(id);
    const p = this.press;
    if (p && p.id === id) {
      this.press = null;
      if (p.dragging) this.on.dragEnd?.(this.dragEvent(p, at));
      else this.on.tap?.(at, id);
    }
    if (this.pointers.size === 0) this.multi = false;
  }

  /** A pointer the browser cancelled; with no id, every pointer (the window lost them all). */
  cancel(id?: number): void {
    const ids = id === undefined ? [...this.pointers.keys()] : this.pointers.has(id) ? [id] : [];
    for (const i of ids) {
      this.pointers.delete(i);
      this.endSpread(i);
      if (this.press?.id === i) {
        this.press = null;
        this.on.cancel?.();
      }
    }
    if (this.pointers.size > 0) this.multi = true;
    else this.multi = false;
  }

  private endSpread(id: number): void {
    if (this.spread?.ids.includes(id)) {
      this.spread = null;
      this.on.pinchEnd?.();
    }
  }

  private measure(a: number, b: number): { distance: number; center: Point; angle: number } {
    const p = this.pointers.get(a)!;
    const q = this.pointers.get(b)!;
    return { distance: Math.hypot(p.x - q.x, p.y - q.y), center: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, angle: Math.atan2(q.y - p.y, q.x - p.x) };
  }

  private dragEvent(p: { id: number; start: Point; last: Point }, point: Point): DragEvent {
    return {
      pointerId: p.id,
      point,
      start: p.start,
      delta: { x: point.x - p.last.x, y: point.y - p.last.y },
      total: { x: point.x - p.start.x, y: point.y - p.start.y },
    };
  }
}
