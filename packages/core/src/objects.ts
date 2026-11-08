// Interactive 3D objects drawn from state, as CanvasIR's components are in
// 2D: each owns an object in a 3D engine's scene (a three.js Object3D, a
// Babylon node, anything with a name), found by its name, and its
// `draw` sets the object's materials, transforms or children from its state
// and its pointer state (hovered, pressed, focused) whenever either changes.
// Its handlers get the router's events while the object is on their path,
// before the router's other listeners, so a stand that stops its drags keeps
// them from turning the camera.
import type { EventRouter, RouterEvent, RouterEventType } from "./interaction";

/** Anything a pickable world names on the router's paths. */
export interface Named {
  readonly name: string;
}

export interface ObjectUi {
  readonly hovered: boolean;
  readonly pressed: boolean;
  /** The last press landed on it, so key events go to it. */
  readonly focused: boolean;
  /** The named objects inside it under the pointer, innermost first: which part of it is hovered, such as a stand's legs. */
  readonly hoveredParts: readonly string[];
}

export interface ObjectHandle<S, O extends Named = Named> {
  readonly id: string;
  readonly object: O;
  readonly state: S;
  readonly ui: ObjectUi;
  /** Changes the state and draws again. A partial object is merged into an object state. */
  setState(next: Partial<S> | ((state: S) => S)): void;
  redraw(): void;
}

export type ObjectHandler<S, O extends Named = Named> = (event: RouterEvent, object: ObjectHandle<S, O>) => void;

export interface ObjectSpec<S, O extends Named = Named> {
  /** The object, named with its id so the world's rays find it. */
  readonly object: O;
  readonly state: S;
  /** The CSS cursor while it's hovered, or a function of its state; null for no preference. */
  readonly cursor?: string | ((state: S, ui: ObjectUi) => string | null);
  /** Sets the object from its state and pointer state, as many times as either changes. */
  draw?(object: O, state: S, ui: ObjectUi): void;
  readonly on?: { readonly [T in RouterEventType]?: ObjectHandler<S, O> };
}

interface Mounted {
  readonly spec: ObjectSpec<unknown>;
  state: unknown;
  ui: ObjectUi;
  readonly handle: ObjectHandle<unknown>;
}

const IDLE: ObjectUi = { hovered: false, pressed: false, focused: false, hoveredParts: [] };
const ROUTED: readonly RouterEventType[] = ["down", "up", "click", "dragstart", "drag", "dragend", "wheel", "keydown", "keyup", "focus"];

export class Objects {
  private readonly mounted = new Map<string, Mounted>();
  private current: string | null = null;

  constructor(
    private readonly router: EventRouter,
    private readonly options: { readonly onChange?: (ids: readonly string[]) => void } = {},
  ) {
    this.listen();
  }

  /** The cursor the innermost hovered object asks for, or null. */
  get cursor(): string | null {
    return this.current;
  }

  mount<S, O extends Named>(spec: ObjectSpec<S, O>): ObjectHandle<S, O> {
    const id = spec.object.name;
    if (!id) throw new Error("an interactive object needs a name: the router finds it by its name");
    if (this.mounted.has(id)) throw new Error(`object ${id} is already mounted`);
    const m: Mounted = { spec: spec as unknown as ObjectSpec<unknown>, state: spec.state, ui: IDLE, handle: null as unknown as ObjectHandle<unknown> };
    const self = this;
    (m as { handle: ObjectHandle<unknown> }).handle = {
      id,
      object: spec.object,
      get state() {
        return m.state;
      },
      get ui() {
        return m.ui;
      },
      setState(next) {
        m.state =
          typeof next === "function"
            ? (next as (s: unknown) => unknown)(m.state)
            : typeof m.state === "object" && m.state !== null
              ? { ...(m.state as object), ...(next as object) }
              : next;
        self.draw([m]);
      },
      redraw() {
        self.draw([m]);
      },
    };
    this.mounted.set(id, m);
    this.draw([m]);
    return m.handle as unknown as ObjectHandle<S, O>;
  }

  unmount(id: string): void {
    if (this.mounted.delete(id)) this.updateCursor();
  }

  get(id: string): ObjectHandle<unknown> | undefined {
    return this.mounted.get(id)?.handle;
  }

  private draw(list: readonly Mounted[]): void {
    for (const m of list) m.spec.draw?.(m.spec.object, m.state, m.ui);
    this.updateCursor();
    if (list.length > 0) this.options.onChange?.(list.map((m) => m.spec.object.name));
  }

  private on(path: readonly string[]): Mounted[] {
    return path.flatMap((id) => {
      const m = this.mounted.get(id);
      return m ? [m] : [];
    });
  }

  private setUi(change: (m: Mounted) => Partial<ObjectUi>): void {
    const changed: Mounted[] = [];
    for (const m of this.mounted.values()) {
      const next = { ...m.ui, ...change(m) };
      const same =
        next.hovered === m.ui.hovered &&
        next.pressed === m.ui.pressed &&
        next.focused === m.ui.focused &&
        next.hoveredParts.length === m.ui.hoveredParts.length &&
        next.hoveredParts.every((p, i) => p === m.ui.hoveredParts[i]);
      if (same) continue;
      m.ui = next;
      changed.push(m);
    }
    if (changed.length > 0) this.draw(changed);
    else this.updateCursor(true);
  }

  private updateCursor(notify = false): void {
    let cursor: string | null = null;
    for (const m of this.on(this.router.hoveredPath)) {
      const c = m.spec.cursor;
      cursor = typeof c === "function" ? c(m.state, m.ui) : c ?? null;
      if (cursor !== null) break;
    }
    if (cursor === this.current) return;
    this.current = cursor;
    if (notify) this.options.onChange?.([]);
  }

  private listen(): void {
    const hover = (): void => {
      const path = this.router.hoveredPath;
      this.setUi((m) => {
        const at = path.indexOf(m.spec.object.name);
        return { hovered: at >= 0, hoveredParts: at < 0 ? [] : path.slice(0, at) };
      });
    };
    this.router.on("*", "enter", hover);
    this.router.on("*", "leave", hover);
    for (const type of ROUTED) {
      this.router.on(
        "*",
        type,
        (e) => {
          const hit = this.on(e.path);
          if (type === "down") this.setUi((m) => ({ pressed: hit.includes(m), focused: hit.includes(m) }));
          if (type === "up") this.setUi(() => ({ pressed: false }));
          let stopped = false;
          const event: RouterEvent = {
            ...e,
            stopPropagation: () => {
              stopped = true;
              e.stopPropagation();
            },
          };
          for (const m of hit) {
            const handler = m.spec.on?.[type];
            if (handler) handler({ ...event, currentTarget: m.spec.object.name }, m.handle);
            if (stopped) break;
          }
        },
        { capture: true },
      );
    }
  }
}
