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
import { FONT, type Palette, type Surface, palette } from "./kit";

const TITLE = 38;
const translate = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export interface LayerOptions {
  readonly recorder: RecordingContextOptions;
  /** Called when the cursor the cards ask for changes. */
  readonly onCursor: (cursor: string | null) => void;
  /** Called when the keyboard should come to the cards, as when Tab reaches one of their controls. */
  readonly onFocus: () => void;
}

/** The scene, router and renderer the cards share, drawn over the board. */
export class CardLayer {
  readonly scene = new Scene({ version: 1, ops: [] });
  readonly router: EventRouter;
  readonly components: Components;
  colors: Palette = palette();
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
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.colors = palette();
      for (const card of this.cards) card.rebuild();
    });
  }

  /** Puts a card on the board. */
  card(options: CardOptions): Card {
    const card = new Card(this, options);
    this.cards.push(card);
    return card;
  }

  /** Whether a card is under a point, in CSS pixels over the board. */
  hits(screen: { x: number; y: number }): boolean {
    return this.scene.hitTest(this.router.toWorld(screen)).length > 0;
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
    this.render();
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

  constructor(
    private readonly layer: CardLayer,
    private readonly options: CardOptions,
  ) {
    this.group = `card-${options.id}`;
    this.x = options.x;
    this.y = options.y;
    layer.scene.addGroup({ id: this.group, meta: { role: "group", label: options.title } });
    this.frame = layer.components.mount(this.frameSpec());
    layer.router.on(this.group, "wheel", (e) => {
      const input = e.input as { deltaY?: number; ctrlKey?: boolean; metaKey?: boolean };
      // A pinch (or Ctrl and the wheel) zooms the board even over a card.
      if (input.ctrlKey || input.metaKey || this.content <= this.view) return;
      e.stopPropagation();
      this.scrollTo(this.scroll + (input.deltaY ?? 0));
    });
    this.rebuild();
  }

  get colors(): Palette {
    return this.layer.colors;
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
      },
    };
  }
}
