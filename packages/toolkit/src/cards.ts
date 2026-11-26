// Cards of widgets on the board. They live in a scene of their own, drawn on a
// canvas over the board's with the board's view, so they pan and zoom with
// everything else but stay out of the drawing, its exports and its devtools.
// A card is a group holding its frame (title, background, scrollbar) and its
// widgets; dragging the frame moves the card, and the wheel scrolls a card
// whose content is taller than it, clipping the widgets to what shows.
import {
  AccessibilityLayer,
  type ComponentHandle,
  type ComponentSpec,
  Components,
  EventRouter,
  IDENTITY,
  type Matrix2D,
  type RecordingContextOptions,
  type RouterEvent,
  Renderer,
  Scene,
  applyToPoint,
} from "canvas-ir";
import { FONT, type Palette, type Surface, type TextInput, type Theme, systemTheme, textSink } from "./controls";
import type { PointerLayer } from "./dom";

type Modifiers = { readonly button?: number; readonly altKey?: boolean; readonly shiftKey?: boolean; readonly ctrlKey?: boolean; readonly metaKey?: boolean };
const input = (p: { x: number; y: number }, e?: Modifiers) => ({
  x: p.x,
  y: p.y,
  button: e?.button ?? 0,
  altKey: !!e?.altKey,
  shiftKey: !!e?.shiftKey,
  ctrlKey: !!e?.ctrlKey,
  metaKey: !!e?.metaKey,
});

const TITLE = 38;
const translate = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export interface LayerOptions {
  readonly recorder: RecordingContextOptions;
  /** Called when the cursor the cards ask for changes. */
  readonly onCursor: (cursor: string | null) => void;
  /** Called when the keyboard should come to the cards, as when Tab reaches one of their controls. */
  readonly onFocus: () => void;
  /** Where the cards' colors come from. Default the page's CSS custom properties and its light or dark preference. */
  readonly theme?: Theme;
  /** Where their text fields take typing from. Default the shared `textSink()`. */
  readonly text?: TextInput;
}

/** The scene, router and renderer the cards share, drawn over the board. */
export class CardLayer implements PointerLayer {
  readonly scene = new Scene({ version: 1, ops: [] });
  readonly router: EventRouter;
  readonly components: Components;
  colors: Palette;
  readonly text: TextInput;
  private readonly unsubscribe: () => void;
  private readonly renderer: Renderer;
  private readonly a11y: AccessibilityLayer;
  private readonly cards: Card[] = [];
  private view: Matrix2D = IDENTITY;
  private frame = 0;
  private claimed = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    container: HTMLElement,
    private readonly options: LayerOptions,
  ) {
    const theme = options.theme ?? systemTheme();
    this.colors = theme.colors();
    this.text = options.text ?? textSink();
    this.router = new EventRouter(this.scene, { tolerance: 2 });
    this.renderer = new Renderer(this.scene, canvas.getContext("2d")!, { lod: false });
    this.components = new Components(this.scene, this.router, {
      recorder: options.recorder,
      onChange: () => {
        options.onCursor(this.components.cursor);
        this.render();
      },
    });
    // A wheel no card or widget kept goes on to the board, which zooms.
    this.router.on("*", "wheel", () => (this.claimed = false));
    // Screen readers and Tab reach the cards' controls through their own DOM mirror.
    this.a11y = new AccessibilityLayer(this.scene, container, {
      onFocus: (id) => {
        options.onFocus();
        this.router.focusOn(id);
      },
      onActivate: (id) => {
        const b = this.scene.bounds(id);
        if (!b) return;
        const p = applyToPoint(this.view, b.x + b.width / 2, b.y + b.height / 2);
        this.router.pointerDown({ x: p.x, y: p.y, button: 0 });
        this.router.pointerUp({ x: p.x, y: p.y, button: 0 });
      },
    });
    this.unsubscribe = theme.subscribe(() => {
      this.colors = theme.colors();
      for (const card of this.cards) card.rebuild();
    });
  }

  /** Puts a card on the board. */
  card(options: CardOptions): Card {
    const card = new Card(this, options);
    this.cards.push(card);
    return card;
  }

  /** Takes a card off the board, with its controls. */
  removeCard(card: Card): void {
    const i = this.cards.indexOf(card);
    if (i < 0) return;
    this.cards.splice(i, 1);
    card.dispose();
    this.render();
  }

  /** Whether a card is under a point, in CSS pixels over the board. */
  hits(screen: { x: number; y: number }): boolean {
    return this.scene.hitTest(this.router.toWorld(screen)).length > 0;
  }

  // Pointers, in CSS pixels over the board, for `bindGestures({ above: layer })` or a host routing them itself.
  down(p: { x: number; y: number }, e?: Modifiers): void {
    this.router.pointerDown(input(p, e));
  }
  move(p: { x: number; y: number }, e?: Modifiers): void {
    this.router.pointerMove(input(p, e));
  }
  up(p: { x: number; y: number }, e?: Modifiers): void {
    this.router.pointerUp(input(p, e));
  }
  cancel(): void {
    this.router.pointerCancel();
  }
  leave(p: { x: number; y: number }): void {
    this.router.pointerLeave(input(p));
    this.options.onCursor(null);
  }

  /** Sends a wheel to the cards; false when none kept it, so the board can zoom. */
  wheel(input: Parameters<EventRouter["wheel"]>[0]): boolean {
    this.claimed = true;
    this.router.wheel(input);
    return this.claimed;
  }

  /** The board's view: world to CSS pixels, and to the canvas's device pixels. */
  setView(view: Matrix2D, device: Matrix2D): void {
    this.view = view;
    this.router.setView(view);
    this.a11y.setView(view);
    this.renderer.setView(device, this.canvas.width, this.canvas.height);
    // Drawn now, in the board's frame: the canvas was just resized and cleared, and a frame without the cards would flicker.
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.renderer.render();
  }

  /** The world box the cards and everything else on this layer cover. */
  bounds(): { x: number; y: number; width: number; height: number } | null {
    let box: { x: number; y: number; width: number; height: number } | null = null;
    for (const op of this.scene.document.ops) {
      const b = this.scene.bounds(op.id);
      if (!b) continue;
      if (!box) box = b;
      else {
        const x = Math.min(box.x, b.x);
        const y = Math.min(box.y, b.y);
        box = { x, y, width: Math.max(box.x + box.width, b.x + b.width) - x, height: Math.max(box.y + box.height, b.y + b.height) - y };
      }
    }
    return box;
  }

  /** Where a world point is on the page. */
  toPage(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const p = applyToPoint(this.view, x, y);
    return { x: r.left + p.x, y: r.top + p.y };
  }

  /** Takes the cards off the page: their mirror, their drawing and what they listen to. The text input is the host's. */
  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.unsubscribe();
    this.a11y.dispose();
    this.renderer.dispose();
    this.cards.length = 0;
  }

  /** Draws what changed, once per frame. */
  render(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render();
    });
  }
}

export interface CardOptions {
  readonly id: string;
  readonly title: string;
  /** Where the card's top left corner is on the board. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** How tall the content shows; taller content scrolls. Omitted, the card is as tall as its content. */
  readonly height?: number;
  /** Mounts the card's widgets, in content coordinates, for its width; returns the height they take. */
  readonly build: (card: Card, width: number) => number;
  /**
   * Called once when a drag of the frame ends, with where the card now is. The card moves itself while dragged, as a
   * window does; a host that keeps card positions in its document commits them here, and puts a card back with `moveTo`.
   */
  readonly onMove?: (x: number, y: number) => void;
}

interface FrameState {
  readonly scroll: number;
  readonly content: number;
  readonly view: number;
}

/** A titled card of widgets on the board: drag its frame to move it, scroll it with the wheel. */
export class Card implements Surface {
  readonly group: string;
  private x: number;
  private y: number;
  private scroll = 0;
  private content = 0;
  private view = 0;
  private readonly children = new Set<string>();
  private readonly frame: ComponentHandle<FrameState>;
  private readonly offWheel: () => void;

  constructor(
    private readonly layer: CardLayer,
    private readonly options: CardOptions,
  ) {
    this.group = `card-${options.id}`;
    this.x = options.x;
    this.y = options.y;
    layer.scene.addGroup({ id: this.group, meta: { role: "group", label: options.title } });
    this.frame = layer.components.mount(this.frameSpec());
    this.offWheel = layer.router.on(this.group, "wheel", (e) => {
      const input = e.input as { deltaY?: number; ctrlKey?: boolean; metaKey?: boolean };
      // A pinch (or Ctrl and the wheel) zooms the board even over a card.
      if (input.ctrlKey || input.metaKey || this.content <= this.view) return;
      e.stopPropagation();
      this.scrollTo(this.scroll + (input.deltaY ?? 0));
    });
    this.rebuild();
  }

  /** Where the card's top left corner is on the board. */
  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Puts the card's top left corner at a point on the board, as when the host undoes a move. */
  moveTo(x: number, y: number): void {
    const dx = x - this.x;
    const dy = y - this.y;
    if (dx === 0 && dy === 0) return;
    this.x = x;
    this.y = y;
    this.layer.components.move(this.group, translate(dx, dy));
    this.layer.render();
  }

  get colors(): Palette {
    return this.layer.colors;
  }

  get text(): TextInput {
    return this.layer.text;
  }

  mount<S>(spec: ComponentSpec<S>): ComponentHandle<S> {
    const id = this.key(spec.id);
    this.children.add(id);
    const draw = spec.draw;
    return this.layer.components.mount({
      ...spec,
      id,
      parent: this.group,
      transform: this.contentTransform(),
      // Clipped to the part of the content that shows, which hit tests follow too.
      draw: (c, state, ui) => {
        if (this.options.height === undefined) return draw(c, state, ui);
        c.save();
        c.beginPath();
        c.rect(0, this.scroll, this.options.width, this.view);
        c.clip();
        draw(c, state, ui);
        c.restore();
      },
    });
  }

  get<S>(id: string): ComponentHandle<S> | undefined {
    return this.layer.components.get<S>(this.key(id));
  }

  rebuild(): void {
    for (const id of this.children) this.layer.components.unmount(id);
    this.children.clear();
    this.view = this.options.height ?? Number.POSITIVE_INFINITY;
    this.content = this.options.build(this, this.options.width);
    if (this.options.height === undefined) this.view = this.content;
    this.scrollTo(this.scroll, true);
  }

  /** Unmounts the card's controls and frame; `CardLayer.removeCard` calls this. */
  dispose(): void {
    for (const id of this.children) this.layer.components.unmount(id);
    this.children.clear();
    this.layer.components.unmount(`${this.group}:frame`);
    this.offWheel();
    if (this.layer.scene.getGroup(this.group)) this.layer.scene.remove(this.group);
  }

  /** Scrolls so content y is at the top of the card, within bounds. */
  scrollTo(y: number, redraw = false): void {
    const next = Math.round(Math.max(0, Math.min(y, this.content - this.view)));
    const dy = next - this.scroll;
    if (dy === 0 && !redraw) return;
    this.scroll = next;
    for (const id of this.children) {
      if (dy !== 0) this.layer.components.move(id, translate(0, -dy));
      // Drawn again for the new clip.
      if (dy !== 0 && this.options.height !== undefined) this.layer.components.get(id)?.redraw();
    }
    this.frame.setState({ scroll: this.scroll, content: this.content, view: this.view });
  }

  local(e: RouterEvent): { x: number; y: number } {
    return { x: e.point.x - this.x, y: e.point.y - this.y - TITLE + this.scroll };
  }

  toPage(x: number, y: number): { x: number; y: number } {
    return this.layer.toPage(this.x + x, this.y + TITLE + y - this.scroll);
  }

  private key(id: string): string {
    return `${this.group}:${id}`;
  }

  private contentTransform(): Matrix2D {
    return translate(this.x, this.y + TITLE - this.scroll);
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const { width, title } = this.options;
    return {
      id: `${this.group}:frame`,
      parent: this.group,
      state: { scroll: 0, content: 0, view: 0 },
      transform: translate(this.x, this.y),
      cursor: (_, ui) => (ui.pressed ? "grabbing" : "grab"),
      draw: (c, s) => {
        const k = this.colors;
        const h = TITLE + s.view;
        c.shadowColor = "rgba(15, 23, 42, 0.16)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(0, 0, width, h, 12);
        c.fillStyle = k.panel;
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = k.border;
        c.lineWidth = 1;
        c.stroke();
        c.font = `600 13.5px ${FONT}`;
        c.fillStyle = k.text;
        c.textBaseline = "middle";
        c.fillText(title, 14, TITLE / 2 + 1);
        // A grip: the frame is what moves the card.
        c.fillStyle = k.muted;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) c.fillRect(width - 22 + j * 5, TITLE / 2 - 5 + i * 5, 2, 2);
        c.fillStyle = k.border;
        c.fillRect(0, TITLE - 1, width, 1);
        if (s.content > s.view) {
          // Where the content that shows sits in the whole.
          const track = s.view - 12;
          const bar = Math.max(24, (track * s.view) / s.content);
          const top = TITLE + 6 + ((track - bar) * s.scroll) / (s.content - s.view);
          c.globalAlpha = 0.45;
          c.fillStyle = k.muted;
          c.beginPath();
          c.roundRect(width - 6, top, 3, bar, 1.5);
          c.fill();
          c.globalAlpha = 1;
        }
      },
      on: {
        dragstart: (e) => e.stopPropagation(),
        drag: (e) => {
          e.stopPropagation();
          const d = e.delta!;
          this.x += d.x;
          this.y += d.y;
          this.layer.components.move(this.group, translate(d.x, d.y));
          this.layer.render();
        },
        dragend: (e) => {
          e.stopPropagation();
          this.options.onMove?.(this.x, this.y);
        },
      },
    };
  }
}
