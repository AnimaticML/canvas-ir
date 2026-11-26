// A desktop on the board: icons that open and close windows, and the frames those windows wear.
//
// `Desktop` keeps icons as components (on the cards' layer, so they zoom with the board but are never part of the
// drawing). Pressing one opens its window, or closes it when it is open, and a dot under its name shows it open, as a
// dock does; one without a window is an action. Dragged, an icon moves, and the host is told where it was put, to keep.
// What an icon shows inside its tile, and what opening it does, is the host's.
//
// `Windows` puts a frame (`windowFrame`: a title bar and a close button) around what a window holds on the board, and
// moves the frame and all it holds as one.
import type { ComponentHandle, ComponentSpec, ComponentUi, Components, Point, RecordingContext, Rect, Scene } from "canvas-ir";
import { FONT, type Palette } from "./controls";
import { windowFrame } from "./window";

export interface DesktopIcon {
  readonly id: string;
  readonly name: string;
  /** The tile's top left corner on the board, before any move the host kept. */
  readonly x: number;
  readonly y: number;
  /** A slight turn, in degrees, for tiles that should look scattered rather than laid out. */
  readonly tilt?: number;
  /** The tile's color. */
  readonly tint?: string;
  /** Whether its window is open now. Without it the icon is an action, and pressing it calls `show`. */
  readonly open?: () => boolean;
  /** Opens its window (or does its action). */
  readonly show: () => void;
  /** Closes its window. */
  readonly hide?: () => void;
  /** Draws its picture inside the tile, in the tile's coordinates (0 to `size`). */
  readonly draw?: (c: RecordingContext, ui: ComponentUi) => void;
}

export interface DesktopOptions {
  /** Where the icons are mounted, and the scene that holds them: the cards' layer. */
  readonly layer: { readonly components: Components; readonly scene: Scene };
  readonly colors: () => Palette;
  /** A tile's side in world units. Default 150. */
  readonly size?: number;
  /** How wide a name may be before it wraps. Default 220. */
  readonly labelWidth?: number;
  /** The name's color; default the palette's text. A light board in dark mode keeps dark ink. */
  readonly ink?: string;
  /** Prefixes an icon's id to make its group's. Default "icon-". */
  readonly prefix?: string;
  /** Where icons were moved to, by id, as the host kept them. */
  readonly moved?: Readonly<Record<string, Point>>;
  /** An icon was dragged and let go here: the host keeps it. */
  readonly onMoved?: (id: string, at: Point) => void;
  /** An icon's window was opened or closed by its icon: the host places it, flies to it, logs. */
  readonly onToggle?: (id: string, opened: boolean) => void;
  /** Something changed that needs drawing. */
  readonly redraw: () => void;
}

export class Desktop {
  private readonly icons = new Map<string, DesktopIcon>();
  private readonly at = new Map<string, Point>();
  private readonly size: number;
  private readonly prefix: string;

  constructor(private readonly options: DesktopOptions) {
    this.size = options.size ?? 150;
    this.prefix = options.prefix ?? "icon-";
  }

  /** The group an icon is drawn in. */
  groupOf(id: string): string {
    return `${this.prefix}${id}`;
  }

  /** Which icon a group is, if any: for a hit test's groups. */
  iconOf(group: string): string | null {
    return group.startsWith(this.prefix) && this.icons.has(group.slice(this.prefix.length)) ? group.slice(this.prefix.length) : null;
  }

  /** Where an icon's tile is now. */
  position(id: string): Point | undefined {
    return this.at.get(id);
  }

  /** The icon's box on the board, its name included, or null when it isn't there. */
  boxOf(id: string): Rect | null {
    const g = this.groupOf(id);
    return this.options.layer.scene.getGroup(g) ? (this.options.layer.scene.bounds(g) ?? null) : null;
  }

  add(icon: DesktopIcon): void {
    this.remove(icon.id);
    this.icons.set(icon.id, icon);
    this.at.set(icon.id, this.options.moved?.[icon.id] ?? { x: icon.x, y: icon.y });
    this.options.layer.components.mount(this.spec(icon));
  }

  remove(id: string): void {
    if (!this.icons.delete(id)) return;
    this.at.delete(id);
    this.options.layer.components.unmount(this.groupOf(id));
  }

  /** Opens an icon's window, or closes it when it is open; an action icon just acts. */
  toggle(id: string): void {
    const icon = this.icons.get(id);
    if (!icon) return;
    const opened = !(icon.open?.() ?? false);
    if (opened) icon.show();
    else icon.hide?.();
    if (icon.open) this.options.onToggle?.(id, opened);
    this.refresh();
    this.options.redraw();
  }

  /** Draws the icons again, so each shows whether its window is open. */
  refresh(): void {
    for (const id of this.icons.keys()) this.options.layer.components.get(this.groupOf(id))?.redraw();
  }

  /** Puts every icon back where the host first placed it. */
  reset(): void {
    for (const icon of [...this.icons.values()]) {
      this.options.layer.components.unmount(this.groupOf(icon.id));
      this.at.set(icon.id, { x: icon.x, y: icon.y });
      this.options.layer.components.mount(this.spec(icon));
    }
    this.options.redraw();
  }

  private spec(icon: DesktopIcon): ComponentSpec<null> {
    const size = this.size;
    const labelWidth = this.options.labelWidth ?? 220;
    const { x, y } = this.at.get(icon.id)!;
    const r = ((icon.tilt ?? 0) * Math.PI) / 180;
    const c0 = Math.cos(r);
    const s0 = Math.sin(r);
    // Turned about the tile's center.
    const cx = x + size / 2;
    const cy = y + size / 2;
    let dragged: Point | null = null;
    const id = icon.id;
    return {
      id: this.groupOf(id),
      state: null,
      transform: { a: c0, b: s0, c: -s0, d: c0, e: cx - c0 * cx + s0 * cy, f: cy - s0 * cx - c0 * cy },
      meta: { role: "button", label: icon.open ? `Open or close ${icon.name}` : icon.name },
      cursor: "pointer",
      draw: (c, _, ui) => {
        const k = this.options.colors();
        const lift = !ui.pressed && ui.hovered ? 4 : 0;
        c.translate(x, y - lift);
        c.shadowColor = "rgba(15, 23, 42, 0.18)";
        c.shadowBlur = ui.hovered ? 26 : 14;
        c.shadowOffsetY = ui.hovered ? 8 : 4;
        c.beginPath();
        c.roundRect(0, 0, size, size, size * 0.19);
        c.fillStyle = icon.tint ?? k.panel;
        c.fill();
        c.shadowColor = "transparent";
        if (ui.hovered || ui.focused) {
          c.lineWidth = 3;
          c.strokeStyle = k.accent;
          c.stroke();
        }
        if (icon.draw) {
          c.save();
          icon.draw(c, ui);
          c.restore();
        }
        c.font = `600 ${Math.round(size * 0.147)}px ${FONT}`;
        c.textAlign = "center";
        c.textBaseline = "top";
        c.fillStyle = this.options.ink ?? k.text;
        const lineHeight = Math.round(size * 0.173);
        // The name wraps to lines no wider than the space between icons.
        const lines: string[] = [];
        for (const word of icon.name.split(" ")) {
          const line = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
          if (lines.length && c.measureText(line).width <= labelWidth) lines[lines.length - 1] = line;
          else lines.push(word);
        }
        lines.forEach((line, i) => c.fillText(line, size / 2, size + 12 + i * lineHeight));
        // An open window shows as a dot under the name, as a dock does.
        if (icon.open?.()) {
          c.beginPath();
          c.arc(size / 2, size + 30 + lines.length * lineHeight, 5, 0, Math.PI * 2);
          c.fillStyle = k.accent;
          c.fill();
        }
        c.textAlign = "start";
      },
      on: {
        click: (e) => {
          e.stopPropagation();
          this.toggle(id);
        },
        keydown: (e) => {
          const key = (e.input as { key: string }).key;
          if (key === "Enter" || key === " ") this.toggle(id);
        },
        // Dragged, an icon moves, as on a desktop; it doesn't open its window.
        dragstart: (e) => {
          e.stopPropagation();
          dragged = { x: 0, y: 0 };
        },
        drag: (e, self: ComponentHandle<null>) => {
          e.stopPropagation();
          if (!e.total || !dragged) return;
          this.options.layer.components.move(self.id, { a: 1, b: 0, c: 0, d: 1, e: e.total.x - dragged.x, f: e.total.y - dragged.y });
          dragged = { x: e.total.x, y: e.total.y };
          this.options.redraw();
        },
        dragend: (e) => {
          e.stopPropagation();
          if (!dragged) return;
          const was = this.at.get(id)!;
          const to = { x: was.x + dragged.x, y: was.y + dragged.y };
          dragged = null;
          this.at.set(id, to);
          this.options.onMoved?.(id, to);
        },
      },
    };
  }
}

export interface WindowsOptions {
  /** The board the windows are on: its components (the frames) and its scene (what they hold). Read each time. */
  readonly board: { readonly components: Components; readonly scene: Scene };
  /** Space between a frame and what it holds. Default 16. */
  readonly pad?: number;
  /** A window was closed with its frame's close button. */
  readonly onClose?: (id: string) => void;
  /** Something was moved with a window, by (dx, dy): the host keeps what follows it (arrows, a layout). */
  readonly moved?: (id: string, dx: number, dy: number) => void;
}

/** Frames around windows drawn straight on the board: a title bar and a close button around all a window holds. */
export class Windows {
  private readonly frames = new Map<string, { title: string; held: readonly string[] }>();

  constructor(private readonly options: WindowsOptions) {}

  /** A window's frame group. */
  frameOf(id: string): string {
    return `${id}:window`;
  }

  private exists(x: string): boolean {
    const s = this.options.board.scene;
    return s.getGroup(x) !== undefined || s.get(x) !== undefined;
  }

  /** Puts a frame with `title` around what `held` names, as it is now; `close` runs when its close button is pressed. */
  frame(id: string, title: string, held: readonly string[], close: () => void): void {
    const { components, scene } = this.options.board;
    const frame = this.frameOf(id);
    this.unframe(id);
    const there = held.filter((h) => this.exists(h));
    let box: Rect | null = null;
    for (const h of there) {
      const b = scene.bounds(h);
      if (!b) continue;
      if (!box) box = b;
      else {
        const x = Math.min(box.x, b.x);
        const y = Math.min(box.y, b.y);
        box = { x, y, width: Math.max(box.x + box.width, b.x + b.width) - x, height: Math.max(box.y + box.height, b.y + b.height) - y };
      }
    }
    if (!box) return;
    const pad = this.options.pad ?? 16;
    components.mount(
      windowFrame({
        id: frame,
        title,
        rect: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
        onClose: () => {
          close();
          this.unframe(id);
          this.options.onClose?.(id);
        },
      }),
    );
    this.frames.set(frame, { title, held: there });
  }

  /** Takes a window's frame off; what it held stays. */
  unframe(id: string): void {
    const frame = this.frameOf(id);
    this.options.board.components.unmount(frame);
    this.frames.delete(frame);
  }

  /** The ids, with every window any of them belongs to: its frame and all it holds. */
  with(ids: readonly string[]): string[] {
    const out = new Set(ids);
    for (const [frame, { held }] of this.frames) if (ids.includes(frame) || held.some((h) => ids.includes(h))) for (const x of [frame, ...held]) out.add(x);
    return [...out].filter((x) => this.exists(x));
  }

  /** Moves a window by (dx, dy): its frame and all it holds. */
  moveBy(id: string, dx: number, dy: number): void {
    for (const x of this.with([id])) {
      this.options.board.components.move(x, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
      this.options.moved?.(x, dx, dy);
    }
  }

  /** The frames on the board now: each one's group, title, what it holds and its box. */
  list(): { id: string; title: string; held: readonly string[]; box: Rect }[] {
    const out: { id: string; title: string; held: readonly string[]; box: Rect }[] = [];
    for (const [frame, { title, held }] of this.frames) {
      const box = this.exists(frame) ? this.options.board.scene.bounds(frame, "geometry") : null;
      if (box) out.push({ id: frame, title, held, box });
    }
    return out;
  }
}
