import type { Scene } from "./geometry/scene";
import { IDENTITY, applyToPoint, invert } from "./math";
import type { Matrix2D, Op, Point } from "./types";

export type RouterEventType =
  | "enter"
  | "leave"
  | "down"
  | "up"
  | "click"
  | "dragstart"
  | "drag"
  | "dragend"
  | "wheel"
  | "keydown"
  | "keyup"
  | "focus";

/** What the host passes in from its DOM event, in the canvas element's pixels. */
export interface PointerInput {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly pointerId?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface WheelInput extends PointerInput {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface KeyInput {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface RouterEvent {
  readonly type: RouterEventType;
  /** The op hit (or, for drag and key events, the op the gesture started on), or null for empty space. */
  readonly target: string | null;
  readonly op: Op | null;
  /** The target and then its groups, innermost first: the bubbling order. */
  readonly path: readonly string[];
  /** The id whose handler is running; "*" for handlers on everything. */
  readonly currentTarget: string;
  /** Where the pointer is, in world space and in the target op's own drawing space. */
  readonly point: Point;
  readonly local: Point | null;
  /** The pointer in the host's pixels. */
  readonly screen: Point;
  /** Drag events: world-space movement since the previous drag event, and since the drag started. */
  readonly delta?: Point;
  readonly total?: Point;
  readonly input: PointerInput | WheelInput | KeyInput;
  stopPropagation(): void;
}

export type RouterHandler = (event: RouterEvent) => void;

export interface EventRouterOptions {
  /** Maps world space to the host's pixels (pan and zoom). Default identity. */
  readonly view?: Matrix2D;
  /** How near, in host pixels, a pointer must be to an op to hit it. Default 0. */
  readonly tolerance?: number;
  /** How far, in host pixels, a pressed pointer moves before a drag starts. Default 3. */
  readonly dragThreshold?: number;
}

interface Listener {
  readonly handler: RouterHandler;
  readonly capture: boolean;
}

interface Press {
  readonly target: string | null;
  /** The target and its groups when pressed: drag events keep going to them even if the op is redrawn under a new id. */
  readonly path: readonly string[];
  readonly startScreen: Point;
  readonly startWorld: Point;
  lastWorld: Point;
  dragging: boolean;
}

/**
 * Turns pointer, wheel and key input into events on ops and their groups. The
 * host owns the DOM listeners and feeds positions in its own pixels; the router
 * hit-tests in world space through the scene and dispatches with capture (outer
 * group first) and bubbling (op first, then its groups), like the DOM.
 * `enter` and `leave` go to each id the pointer entered or left and don't bubble.
 */
export class EventRouter {
  private view: Matrix2D;
  private inverse: Matrix2D;
  private readonly tolerance: number;
  private readonly dragThreshold: number;
  private readonly listeners = new Map<string, Map<RouterEventType, Listener[]>>();
  private hoverPath: string[] = [];
  private press: Press | null = null;
  private focus: string | null = null;
  private focusPath: readonly string[] = [];
  private lastPointer: PointerInput | null = null;

  constructor(
    private readonly scene: Scene,
    options: EventRouterOptions = {},
  ) {
    this.view = options.view ?? IDENTITY;
    this.inverse = invert(this.view) ?? IDENTITY;
    this.tolerance = options.tolerance ?? 0;
    this.dragThreshold = options.dragThreshold ?? 3;
  }

  setView(view: Matrix2D): void {
    const inverse = invert(view);
    if (!inverse) throw new Error("the view matrix is not invertible");
    this.view = view;
    this.inverse = inverse;
  }

  /** Listens on an op id, a group id, or "*" for every event. Returns a function that stops listening. */
  on(id: string, type: RouterEventType, handler: RouterHandler, options: { capture?: boolean } = {}): () => void {
    let byType = this.listeners.get(id);
    if (!byType) this.listeners.set(id, (byType = new Map()));
    let list = byType.get(type);
    if (!list) byType.set(type, (list = []));
    const listener = { handler, capture: options.capture ?? false };
    list.push(listener);
    return () => {
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** The op under the pointer, if any. */
  get hovered(): string | null {
    return this.hoverPath[0] ?? null;
  }

  /** The op under the pointer and its groups, innermost first. */
  get hoveredPath(): readonly string[] {
    return this.hoverPath;
  }

  /** The op the last press landed on; key events go to it, and to its groups as they were then. */
  get focused(): string | null {
    return this.focus;
  }

  /**
   * Hit-tests the last pointer position again, sending enter and leave for what
   * changed under a still pointer, such as an object that moved or was redrawn.
   */
  refreshHover(): void {
    if (this.lastPointer) this.updateHover(this.pick({ x: this.lastPointer.x, y: this.lastPointer.y }).path, this.lastPointer);
  }

  /** The world-space point under a host pixel. */
  toWorld(screen: Point): Point {
    return applyToPoint(this.inverse, screen.x, screen.y);
  }

  /** The topmost op under a host pixel, with its group path. */
  pick(screen: Point): { target: string | null; path: string[] } {
    const world = this.toWorld(screen);
    const scale = Math.sqrt(Math.abs(this.inverse.a * this.inverse.d - this.inverse.b * this.inverse.c));
    const [hit] = this.scene.hitTest(world, { tolerance: this.tolerance * scale });
    return hit ? { target: hit.id, path: [hit.id, ...hit.groups] } : { target: null, path: [] };
  }

  pointerMove(input: PointerInput): void {
    this.lastPointer = input;
    const screen = { x: input.x, y: input.y };
    this.updateHover(this.pick(screen).path, input);
    const press = this.press;
    if (!press) return;
    const world = this.toWorld(screen);
    if (!press.dragging) {
      if (Math.hypot(screen.x - press.startScreen.x, screen.y - press.startScreen.y) < this.dragThreshold) return;
      press.dragging = true;
      this.dispatch("dragstart", press.target, input, screen, { delta: sub(world, press.startWorld), total: sub(world, press.startWorld) }, press.path);
    }
    this.dispatch("drag", press.target, input, screen, { delta: sub(world, press.lastWorld), total: sub(world, press.startWorld) }, press.path);
    press.lastWorld = world;
  }

  pointerDown(input: PointerInput): void {
    this.lastPointer = input;
    const screen = { x: input.x, y: input.y };
    const { target, path } = this.pick(screen);
    this.updateHover(path, input);
    const world = this.toWorld(screen);
    this.press = { target, path, startScreen: screen, startWorld: world, lastWorld: world, dragging: false };
    this.focus = target;
    this.focusPath = path;
    this.dispatch("down", target, input, screen);
  }

  pointerUp(input: PointerInput): void {
    this.lastPointer = input;
    const screen = { x: input.x, y: input.y };
    const { target, path } = this.pick(screen);
    this.updateHover(path, input);
    const press = this.press;
    this.press = null;
    if (press?.dragging) {
      const world = this.toWorld(screen);
      this.dispatch("dragend", press.target, input, screen, { delta: sub(world, press.lastWorld), total: sub(world, press.startWorld) }, press.path);
    }
    this.dispatch("up", target, input, screen);
    if (!press || press.dragging) return;
    // A click goes where the press and release agree: the same op, or else the innermost group both were in,
    // as when a press redrew the op under a new id. A press and release on empty space click empty space.
    if (press.target === target) this.dispatch("click", target, input, screen, {}, path);
    else {
      const common = path.findIndex((id) => press.path.includes(id));
      if (common >= 0) this.dispatch("click", path[common]!, input, screen, {}, path.slice(common));
    }
  }

  /** Cancel a host gesture without synthesizing a click (multi-touch, capture loss). */
  pointerCancel(): void {
    const press = this.press;
    this.press = null;
    if (press) {
      const input = { x: press.startScreen.x, y: press.startScreen.y };
      this.dispatch("up", press.target, input, press.startScreen, {}, press.path);
      this.updateHover([], input);
    }
    this.lastPointer = null;
  }

  /** The pointer left the host element: everything hovered is left. */
  pointerLeave(input: PointerInput): void {
    this.lastPointer = null;
    this.updateHover([], input);
  }

  wheel(input: WheelInput): void {
    const screen = { x: input.x, y: input.y };
    this.dispatch("wheel", this.pick(screen).target, input, screen);
  }

  /**
   * Moves key focus to an op or group without a press, as when the keyboard
   * tabs to it through an accessibility tree; null takes focus away. A `focus`
   * event goes to it (bubbling through its groups) so components can show it.
   */
  focusOn(id: string | null): void {
    this.focus = id;
    this.focusPath = id === null ? [] : [id, ...this.scene.groupChain(id)];
    this.dispatch("focus", id, { key: "" }, null, {}, this.focusPath);
  }

  keyDown(input: KeyInput): void {
    this.dispatch("keydown", this.focus, input, null, {}, this.focusPath);
  }

  keyUp(input: KeyInput): void {
    this.dispatch("keyup", this.focus, input, null, {}, this.focusPath);
  }

  private updateHover(path: string[], input: PointerInput): void {
    const before = this.hoverPath;
    if (before.length === path.length && before.every((id, i) => id === path[i])) return;
    this.hoverPath = path;
    const screen = { x: input.x, y: input.y };
    // Leave from the inside out, then enter from the outside in, skipping groups the pointer stays in.
    for (const id of before) if (!path.includes(id)) this.deliver(id, "leave", before, screen, input);
    for (const id of [...path].reverse()) if (!before.includes(id)) this.deliver(id, "enter", path, screen, input);
  }

  /** `enter` and `leave` reach only their own id's handlers and "*". */
  private deliver(id: string, type: "enter" | "leave", path: string[], screen: Point, input: PointerInput): void {
    const event = this.makeEvent(type, path[0] ?? null, path, screen, input);
    for (const current of [id, "*"]) {
      for (const l of this.listenersFor(current, type)) l.handler({ ...event, currentTarget: current });
    }
  }

  private dispatch(
    type: RouterEventType,
    target: string | null,
    input: PointerInput | WheelInput | KeyInput,
    screen: Point | null,
    extra: { delta?: Point; total?: Point } = {},
    given?: readonly string[],
  ): void {
    // An op redrawn since the press is gone; its groups, remembered from then, still get the event.
    const live = target !== null && (this.scene.get(target) !== undefined || this.scene.getGroup(target) !== undefined);
    const path = target === null ? [] : live || !given ? [target, ...this.scene.groupChain(target)] : given.filter((id) => this.scene.getGroup(id));
    const base = this.makeEvent(type, target, path, screen, input, extra);
    let stopped = false;
    const run = (current: string, capture: boolean): void => {
      for (const l of this.listenersFor(current, type)) {
        if (l.capture !== capture) continue;
        l.handler({ ...base, currentTarget: current, stopPropagation: () => (stopped = true) });
      }
    };
    // Capture: "*", then the outermost group down to the target. Bubble: the target up to "*".
    for (const current of ["*", ...[...path].reverse()]) {
      run(current, true);
      if (stopped) return;
    }
    for (const current of [...path, "*"]) {
      run(current, false);
      if (stopped) return;
    }
  }

  private makeEvent(
    type: RouterEventType,
    target: string | null,
    path: readonly string[],
    screen: Point | null,
    input: PointerInput | WheelInput | KeyInput,
    extra: { delta?: Point; total?: Point } = {},
  ): RouterEvent {
    const op = target === null ? null : this.scene.get(target) ?? null;
    const at = screen ?? { x: NaN, y: NaN };
    const point = screen ? this.toWorld(screen) : { x: NaN, y: NaN };
    const toLocal = op && screen ? invert(op.transform) : null;
    return {
      type,
      target,
      op,
      path,
      currentTarget: target ?? "*",
      point,
      local: toLocal ? applyToPoint(toLocal, point.x, point.y) : null,
      screen: at,
      ...extra,
      input,
      stopPropagation: () => {},
    };
  }

  private listenersFor(id: string, type: RouterEventType): Listener[] {
    return [...(this.listeners.get(id)?.get(type) ?? [])];
  }
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
