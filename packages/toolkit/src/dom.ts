// Browser wiring for a board on a canvas: sizing it to the device's pixels, drawing once a frame however many changes
// come before it, and feeding its pointer and wheel events to gestures in the canvas's own CSS pixels. Everything here
// needs a DOM; the view and gesture logic (viewport.ts, gestures.ts) doesn't.
import type { Point } from "canvas-ir";
import type { Gestures } from "./gestures";
import { wheelPixels } from "./viewport";

export interface Frame {
  /** The canvas's size in CSS pixels, and canvas pixels per CSS pixel. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** Whether the canvas's pixel size changed since the last frame, so a renderer needs its view set again. */
  readonly resized: boolean;
}

export interface CanvasHostOptions {
  /** Draws a frame: set the renderer's view from the viewport at `frame.pixelRatio`, then render. */
  readonly draw: (frame: Frame) => void;
  /** The most canvas pixels per CSS pixel: 2 keeps a 3× phone's canvas a little lighter. Default: the device's. */
  readonly maxPixelRatio?: number;
  /** The CSS size to draw at. Default: the canvas's own laid-out size. */
  readonly measure?: () => { width: number; height: number };
  /** Draw on resize. Default true. */
  readonly observeResize?: boolean;
}

export interface CanvasHost {
  /** Asks for a frame; several asks before it come to one. */
  schedule(): void;
  /** Draws now, if a frame was asked for or the size changed. */
  flush(): void;
  readonly size: { width: number; height: number; pixelRatio: number };
  dispose(): void;
}

/** Keeps a canvas at its laid-out size in device pixels and draws it at most once a frame. */
export const mountCanvas = (canvas: HTMLCanvasElement, options: CanvasHostOptions): CanvasHost => {
  let frame = 0;
  let wanted = false;
  let alive = true;
  const size = { width: 0, height: 0, pixelRatio: 1 };
  const draw = (): void => {
    frame = 0;
    if (!alive) return;
    wanted = false;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, options.maxPixelRatio ?? Infinity);
    const m = options.measure?.() ?? canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(m.width * ratio));
    const h = Math.max(1, Math.round(m.height * ratio));
    const resized = canvas.width !== w || canvas.height !== h || size.pixelRatio !== ratio || size.width !== m.width || size.height !== m.height;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    size.width = m.width;
    size.height = m.height;
    size.pixelRatio = ratio;
    options.draw({ width: m.width, height: m.height, pixelRatio: ratio, resized });
  };
  const schedule = (): void => {
    wanted = true;
    if (alive && !frame) frame = requestAnimationFrame(draw);
  };
  const observer = options.observeResize === false || typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(canvas);
  schedule();
  return {
    schedule,
    flush: () => {
      if (!wanted) return;
      if (frame) cancelAnimationFrame(frame);
      draw();
    },
    size,
    dispose: () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
    },
  };
};

export interface WheelInput {
  /** Where the wheel turned, in the element's CSS pixels, and how far, in pixels whatever the device counted in. */
  readonly point: Point;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly timeStamp: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Something drawn over the board that takes its own pointers, such as a layer of cards: a press on it, and a pointer
 * hovering over it, go to it instead of the gestures. `CardLayer` is one.
 */
export interface PointerLayer {
  /** Whether it has something under a point, in the element's CSS pixels. */
  hits(point: Point): boolean;
  down(point: Point, e: PointerEvent): void;
  move(point: Point, e: PointerEvent): void;
  up(point: Point, e: PointerEvent): void;
  cancel(): void;
  /** The pointer moved off it, onto the board or out of the element. */
  leave(point: Point): void;
}

export interface BindOptions {
  /** Keep a pointer that pressed here while it moves elsewhere. Default true. */
  readonly capture?: boolean;
  /** The wheel, already in pixels. Return false to let the page scroll instead. */
  readonly wheel?: (input: WheelInput) => boolean | void;
  /** The pointer left the element with nothing pressed. */
  readonly leave?: () => void;
  /** Every pointer event before the gestures see it, for hosts that also feed an EventRouter its modifier keys. */
  readonly raw?: (e: PointerEvent, point: Point) => void;
  /** A layer over the board that takes the presses and hovers over what it has; the board's gestures get the rest. */
  readonly above?: PointerLayer;
}

/** Feeds an element's pointer and wheel events to gestures, in the element's CSS pixels. Returns what unbinds them. */
export const bindGestures = (element: HTMLElement, gestures: Gestures, options: BindOptions = {}): (() => void) => {
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = element.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const above = options.above;
  // Pointers pressed on the layer above, which it keeps until they are up; and whether a pointer hovers over it.
  const claimed = new Set<number>();
  let over = false;
  const down = (e: PointerEvent): void => {
    if (options.capture !== false) {
      // A pointer a host page forwards (an embedding page showing this on a 3D panel) can't be captured.
      try {
        element.setPointerCapture(e.pointerId);
      } catch {}
    }
    const p = at(e);
    options.raw?.(e, p);
    if (above && gestures.active === 0 && above.hits(p)) {
      claimed.add(e.pointerId);
      above.down(p, e);
      return;
    }
    gestures.down(e.pointerId, p);
  };
  const move = (e: PointerEvent): void => {
    const p = at(e);
    options.raw?.(e, p);
    if (claimed.has(e.pointerId)) return above!.move(p, e);
    if (above && gestures.active === 0) {
      const hit = above.hits(p);
      if (hit) {
        over = true;
        return above.move(p, e);
      }
      if (over) {
        over = false;
        above.leave(p);
      }
    }
    gestures.move(e.pointerId, p);
  };
  const up = (e: PointerEvent): void => {
    const p = at(e);
    options.raw?.(e, p);
    if (claimed.delete(e.pointerId)) return above!.up(p, e);
    gestures.up(e.pointerId, p);
  };
  const cancel = (e: PointerEvent): void => {
    options.raw?.(e, at(e));
    if (claimed.delete(e.pointerId)) return above!.cancel();
    gestures.cancel(e.pointerId);
  };
  const leave = (e: PointerEvent): void => {
    if (over && claimed.size === 0) {
      over = false;
      above!.leave(at(e));
    }
    if (gestures.active === 0) options.leave?.();
  };
  const wheel = (e: WheelEvent): void => {
    if (!options.wheel) return;
    const d = wheelPixels(e, element.clientHeight);
    const used = options.wheel({ point: at(e), deltaX: d.x, deltaY: d.y, timeStamp: e.timeStamp, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
    if (used !== false) e.preventDefault();
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("pointerleave", leave);
  element.addEventListener("wheel", wheel, { passive: false });
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancel);
    element.removeEventListener("pointerleave", leave);
    element.removeEventListener("wheel", wheel);
  };
};
