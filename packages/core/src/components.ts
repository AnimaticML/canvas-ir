import { RecordingContext, type RecordingContextOptions } from "./context";
import type { Scene } from "./geometry/scene";
import type { EventRouter, RouterEvent, RouterEventType } from "./interaction";
import { IDENTITY, multiply } from "./math";
import type { Group, JsonValue, Matrix2D } from "./types";

/** Pointer and focus state the library tracks for each component, passed to its `draw`. */
export interface ComponentUi {
  readonly hovered: boolean;
  /** A press began on the component and hasn't been released. */
  readonly pressed: boolean;
  /** The last press landed on the component, so key events go to it. */
  readonly focused: boolean;
  /** The groups inside the component under the pointer, innermost first: which part of it is hovered, such as a link's run. */
  readonly hoveredParts: readonly Group[];
}

export interface ComponentHandle<S> {
  readonly id: string;
  readonly state: S;
  readonly ui: ComponentUi;
  /** Where the component is: its drawing is recorded under this matrix. */
  readonly transform: Matrix2D;
  /** Changes the state and redraws. A partial object is merged into an object state. */
  setState(next: Partial<S> | ((state: S) => S)): void;
  redraw(): void;
}

export type ComponentHandler<S> = (event: RouterEvent, component: ComponentHandle<S>) => void;

export interface ComponentSpec<S> {
  /** The component's group id in the scene. */
  readonly id: string;
  readonly state: S;
  /** A group to put the component in. */
  readonly parent?: string;
  /** Extra meta for the component's group, or a function of its state, such as an accessible `role`, `label` and `value`. */
  readonly meta?: { readonly [key: string]: JsonValue } | ((state: S) => { readonly [key: string]: JsonValue });
  /** Where to draw it. Default identity. */
  readonly transform?: Matrix2D;
  /** The CSS cursor while it's hovered, or a function of its state; null for no preference. */
  readonly cursor?: string | ((state: S, ui: ComponentUi) => string | null);
  /**
   * Draws the component from its state, as many times as it changes. The
   * context records only this component, with its transform already set:
   * move with `translate`, `rotate` and `scale`, not `setTransform`.
   */
  draw(ctx: RecordingContext, state: S, ui: ComponentUi): void;
  /**
   * Event handlers. They run during capture, before handlers on the scene's
   * other listeners; call `event.stopPropagation()` to keep the event for the
   * component, as a knob does with drags so the board doesn't move it.
   */
  readonly on?: { readonly [T in RouterEventType]?: ComponentHandler<S> };
}

export interface ComponentsOptions {
  /** Options for the context each component records into, such as `measureText`. */
  readonly recorder?: RecordingContextOptions;
  /** Called after components redraw, with their ids, and when the cursor changes: the host renders. */
  readonly onChange?: (ids: readonly string[]) => void;
}

interface Mounted {
  readonly spec: ComponentSpec<unknown>;
  state: unknown;
  ui: ComponentUi;
  transform: Matrix2D;
  readonly handle: ComponentHandle<unknown>;
}

const IDLE: ComponentUi = { hovered: false, pressed: false, focused: false, hoveredParts: [] };
const ROUTED: readonly RouterEventType[] = ["down", "up", "click", "dragstart", "drag", "dragend", "wheel", "keydown", "keyup", "focus"];

/**
 * Interactive objects drawn from state. Each component owns a group: it is
 * drawn by its `draw` function into that group, and drawn again, through
 * `Scene.replaceGroup`, whenever its state or its hover, pressed or focus state
 * changes. The scene stays the only drawing; a component is the source of its
 * group, as a document model's object would be. Events reach a component's
 * handlers when its group is on the event's path.
 */
export class Components {
  private readonly mounted = new Map<string, Mounted>();
  private unlisten: (() => void)[] = [];
  private current: string | null = null;

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly options: ComponentsOptions = {},
  ) {
    this.listen();
  }

  /** The cursor the innermost hovered component asks for, or null. */
  get cursor(): string | null {
    return this.current;
  }

  get ids(): string[] {
    return [...this.mounted.keys()];
  }

  get<S>(id: string): ComponentHandle<S> | undefined {
    return this.mounted.get(id)?.handle as ComponentHandle<S> | undefined;
  }

  /** Adds a component and draws it: in place if its group exists, else after its parent's ops, or last. */
  mount<S>(spec: ComponentSpec<S>): ComponentHandle<S> {
    if (this.mounted.has(spec.id)) throw new Error(`component ${spec.id} is already mounted`);
    const m: Mounted = {
      spec: spec as ComponentSpec<unknown>,
      state: spec.state,
      ui: IDLE,
      transform: spec.transform ?? IDENTITY,
      handle: null as unknown as ComponentHandle<unknown>,
    };
    const self = this;
    (m as { handle: ComponentHandle<unknown> }).handle = {
      id: spec.id,
      get state() {
        return m.state;
      },
      get ui() {
        return m.ui;
      },
      get transform() {
        return m.transform;
      },
      setState(next) {
        m.state =
          typeof next === "function"
            ? (next as (s: unknown) => unknown)(m.state)
            : typeof m.state === "object" && m.state !== null
              ? { ...(m.state as object), ...(next as object) }
              : next;
        self.redraw([m]);
      },
      redraw() {
        self.redraw([m]);
      },
    };
    this.mounted.set(spec.id, m);
    this.redraw([m]);
    return m.handle as ComponentHandle<S>;
  }

  /** Removes a component and its group. */
  unmount(id: string): void {
    if (!this.mounted.delete(id)) return;
    if (this.scene.getGroup(id)) this.scene.remove(id);
    this.updateCursor();
    this.options.onChange?.([id]);
  }

  /**
   * Moves an op or group through the scene, like `scene.transform`, and keeps
   * the components it is or holds where it put them when they redraw. Hosts
   * move things through this rather than the scene once components are mounted.
   */
  move(id: string, matrix: Matrix2D): void {
    this.scene.transform(id, matrix);
    for (const m of this.mounted.values()) {
      if (m.spec.id === id || this.scene.groupChain(m.spec.id).includes(id)) m.transform = multiply(matrix, m.transform);
    }
  }

  /**
   * Moves the components to another scene and router, such as after the host
   * rebuilt its scene from a document that already holds their groups. They
   * aren't drawn again.
   */
  bind(scene: Scene, router: EventRouter): void {
    for (const off of this.unlisten) off();
    this.scene = scene;
    this.router = router;
    for (const m of this.mounted.values()) m.ui = IDLE;
    this.current = null;
    this.listen();
  }

  private redraw(list: readonly Mounted[]): void {
    for (const m of list) {
      const { spec } = m;
      const recorder = new RecordingContext(this.options.recorder);
      const meta = typeof spec.meta === "function" ? spec.meta(m.state) : spec.meta;
      recorder.beginGroup({ id: spec.id, meta: { ...meta, component: true } });
      const t = m.transform;
      recorder.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      spec.draw(recorder, m.state, m.ui);
      recorder.endGroup();
      this.scene.replaceGroup(spec.id, recorder.getDocument(), spec.parent !== undefined ? { parent: spec.parent } : {});
    }
    this.updateCursor();
    if (list.length > 0) this.options.onChange?.(list.map((m) => m.spec.id));
  }

  /** Components on a path, innermost first. */
  private on(path: readonly string[]): Mounted[] {
    return path.flatMap((id) => {
      const m = this.mounted.get(id);
      return m ? [m] : [];
    });
  }

  /** Sets each component's ui from `change`, and redraws those whose ui changed. */
  private setUi(change: (m: Mounted) => Partial<ComponentUi>): void {
    const changed: Mounted[] = [];
    for (const m of this.mounted.values()) {
      const next = { ...m.ui, ...change(m) };
      const same =
        next.hovered === m.ui.hovered &&
        next.pressed === m.ui.pressed &&
        next.focused === m.ui.focused &&
        next.hoveredParts.length === m.ui.hoveredParts.length &&
        next.hoveredParts.every((g, i) => g.id === m.ui.hoveredParts[i]!.id);
      if (same) continue;
      m.ui = next;
      changed.push(m);
    }
    if (changed.length > 0) this.redraw(changed);
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
        const at = path.indexOf(m.spec.id);
        return {
          hovered: at >= 0,
          hoveredParts: at < 0 ? [] : path.slice(1, at).flatMap((id) => this.scene.getGroup(id) ?? []),
        };
      });
    };
    this.unlisten = [this.router.on("*", "enter", hover), this.router.on("*", "leave", hover)];
    for (const type of ROUTED) {
      const off = this.router.on(
        "*",
        type,
        (e) => {
          const hit = this.on(e.path);
          if (type === "down") this.setUi((m) => ({ pressed: hit.includes(m), focused: hit.includes(m) }));
          if (type === "up") this.setUi(() => ({ pressed: false }));
          if (type === "focus") this.setUi((m) => ({ focused: hit.includes(m) }));
          // Innermost first, like bubbling; a handler that stops propagation keeps the event from outer components too.
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
            if (handler) handler({ ...event, currentTarget: m.spec.id }, m.handle);
            if (stopped) break;
          }
        },
        { capture: true },
      );
      this.unlisten.push(off);
    }
  }
}
