// The playground's controls, as two cards on the board drawn with the widget
// kit: the playground card (drawing tools and actions, wrapping onto
// as many rows as its width needs) and the inspector, a scrolling card of
// drawing style, selection, snapping, rendering, accessibility, devtools,
// pasting SVG and the event log.
import type { Devtools } from "../devtools";
import type { ToolName } from "../tools";
import type { Card, CardLayer } from "./cards";
import { type ButtonLook, FONT, type TextBoxState, button, buttonWidth, section, slider, swatches, textBox, textField, toggle } from "./kit";

export interface Action {
  readonly text: string;
  readonly onClick: () => void;
  readonly look?: ButtonLook;
  readonly title?: string;
}

/** What the board reads from the side panel's controls. */
export interface Settings {
  snapOn: boolean;
  snapRadius: number;
  snapKinds: Set<"points" | "bounds" | "path">;
  snapText: boolean;
  lod: boolean;
}

export interface ChromeHost {
  readonly tools: readonly { name: ToolName; text: string; key: string }[];
  readonly onTool: (name: ToolName) => void;
  /** Buttons at the toolbar's end. */
  readonly actions: readonly Action[];
  readonly style: { fill: string; stroke: string; lineWidth: number };
  readonly settings: Settings;
  readonly onLod: () => void;
  readonly devtools: Devtools;
  readonly pasteSvg: () => void;
}

/** Text shown in the inspector's boxes, by box. */
export type TextId = "selection" | "render-stats" | "a11y" | "log" | "op-list" | "op-detail";

const LABELS: Record<TextId, string> = {
  selection: "Selection",
  "render-stats": "Last redraw",
  a11y: "Accessibility tree",
  log: "Events",
  "op-list": "Ops",
  "op-detail": "Op details",
};

const FILLS = ["#fde68a", "#fecaca", "#bbf7d0", "#bfdbfe", "#e9d5ff", "#ffffff", "transparent"];
const STROKES = ["#1f2937", "#dc2626", "#16a34a", "#2563eb", "#9333ea", "#f97316", "#ffffff"];

export class Chrome {
  readonly toolbar: Card;
  readonly side: Card;
  private tool: ToolName = "select";
  private readonly texts = new Map<TextId, string>();
  private devtoolsOpen = false;
  private query = "";
  private step = { max: 0, value: 0, label: "" };
  private picked = -1;

  /** Puts the cards on `layer`, to the left of where the first samples are drawn. */
  constructor(layer: CardLayer, private readonly host: ChromeHost) {
    this.texts.set("selection", "Click something on the board.");
    this.texts.set("render-stats", "Nothing drawn yet.");
    this.toolbar = layer.card({ id: "playground", title: "CanvasIR Playground", x: -740, y: 20, width: 340, build: (p, w) => this.buildToolbar(p, w) });
    this.side = layer.card({ id: "inspector", title: "Inspector", x: -380, y: 20, width: 330, height: 640, build: (p, w) => this.buildSide(p, w) });
    const chrome = this;
    host.devtools.view = {
      get open() {
        return chrome.devtoolsOpen;
      },
      get query() {
        return chrome.query;
      },
      showStep: (max, value, text) => {
        // The slider's range is fixed when it is built: a new op count builds the panel again.
        const rebuild = max !== this.step.max && this.devtoolsOpen;
        this.step = { max, value, label: text };
        if (rebuild) this.side.rebuild();
        else {
          this.side.get<{ value: number }>("op-step")?.setState({ value });
          this.side.get<{ text: string }>("op-step-label")?.setState({ text });
        }
      },
      showRows: (lines, picked) => {
        this.picked = picked;
        this.setText("op-list", lines.join("\n"));
        // Keep the picked row in view.
        const box = this.side.get<TextBoxState>("op-list");
        if (box && picked >= 0 && (picked < box.state.scroll || picked >= box.state.scroll + 10)) box.setState({ scroll: Math.max(0, picked - 3) });
      },
      showDetail: (text) => this.setText("op-detail", text),
    };
  }

  /** Shows text in one of the side panel's boxes. */
  setText(id: TextId, text: string): void {
    this.texts.set(id, text);
    this.side.get<TextBoxState>(id)?.setState({ text });
  }

  text(id: TextId): string {
    return this.texts.get(id) ?? "";
  }

  /** Marks the current drawing tool. */
  setTool(name: ToolName): void {
    this.tool = name;
    for (const t of this.host.tools) this.toolbar.get<{ active: boolean }>(`tool-${t.name}`)?.setState({ active: t.name === name });
  }

  private buildToolbar(p: Card, width: number): number {
    const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
    const H = 28;
    const GAP = 6;
    const PAD = 14;
    let x = PAD;
    let y = PAD;
    // Buttons flow left to right, onto as many rows as they need.
    const place = (w: number): { x: number; y: number } => {
      if (x + w > width - PAD && x > PAD) {
        x = PAD;
        y += H + GAP;
      }
      const at = { x, y };
      x += w + GAP;
      return at;
    };
    const head = (id: string, title: string, hint?: string): void => {
      if (x > PAD) y += H + 16;
      const s = section(p, id, PAD, y, width - PAD * 2, title, hint);
      p.mount(s.spec);
      x = PAD;
      y += s.height + 6;
    };
    const add = (id: string, a: Action, active = false): void => {
      const w = buttonWidth(measure, a.text);
      const at = place(w);
      p.mount(button({ id, panel: p, box: { x: at.x, y: at.y, w, h: H }, text: a.text, onClick: a.onClick, active, ...(a.look ? { look: a.look } : {}), ...(a.title ? { title: a.title } : {}) }));
    };
    head("tools-head", "Tools", "Keys V, P, R, O and T. Scroll to zoom, drag empty space to pan, and drag a card by its frame. Every feature is an icon somewhere on the board: zoom out to find them, press one to add it beside it.");
    for (const tool of this.host.tools) add(`tool-${tool.name}`, { text: tool.text, onClick: () => this.host.onTool(tool.name), title: `${tool.text} (${tool.key})` }, tool.name === this.tool);
    head("actions-head", "Do");
    this.host.actions.forEach((a, i) => add(`action-${i}`, a));
    return y + H + PAD;
  }

  private buildSide(p: Card, width: number): number {
    const PAD = 14;
    const w = width - PAD * 2;
    const x = PAD;
    let y = PAD;
    const head = (id: string, title: string, hint?: string): void => {
      const s = section(p, id, x, y, w, title, hint);
      p.mount(s.spec);
      y += s.height + 8;
    };
    const box = (id: TextId, h: number, mono = true, extra: Partial<Parameters<typeof textBox>[0]> = {}): void => {
      p.mount(textBox({ id, panel: p, box: { x, y, w, h }, text: this.text(id), label: LABELS[id], mono, ...extra }));
      y += h + 8;
    };
    const row = (h = 26) => {
      const b = { x, y, w, h };
      y += h + 4;
      return b;
    };
    const gap = (): void => {
      y += 14;
    };
    const style = this.host.style;
    const settings = this.host.settings;

    head("draw-head", "Draw", "The pen, rectangle, ellipse and text tools draw with these. Shift keeps squares and circles; corners snap like a drag.");
    p.mount(swatches({ id: "fill", panel: p, box: row(), text: "Fill", colors: FILLS, value: style.fill, onChange: (v) => (style.fill = v) }));
    p.mount(swatches({ id: "stroke", panel: p, box: row(), text: "Stroke", colors: STROKES, value: style.stroke, onChange: (v) => (style.stroke = v) }));
    p.mount(slider({ id: "width", panel: p, box: row(), text: "Width", min: 1, max: 16, value: style.lineWidth, format: (v) => `${v}px`, onChange: (v) => (style.lineWidth = v) }));
    gap();

    head(
      "selection-head",
      "Selection",
      "Drag moves an object, or one shape with Alt held; it snaps unless Ctrl or Cmd is held. Shift-click adds to the selection; Shift-drag on empty space lassoes. Delete removes. Scroll zooms; drag empty space to pan.",
    );
    box("selection", 96);
    gap();

    head("snap-head", "Snapping", "Text laid out around what you drag is never a target, since it moves as you drag.");
    p.mount(toggle({ id: "snap-on", panel: p, box: row(), text: "Snap while dragging", checked: settings.snapOn, onChange: (v) => (settings.snapOn = v) }));
    p.mount(slider({ id: "snap-radius", panel: p, box: row(), text: "Radius", min: 2, max: 30, value: settings.snapRadius, format: (v) => `${v}px`, onChange: (v) => (settings.snapRadius = v) }));
    for (const [kind, text] of [
      ["points", "Corners, centers and crossings"],
      ["bounds", "Bounding boxes"],
      ["path", "Outlines"],
    ] as const) {
      p.mount(
        toggle({
          id: `snap-${kind}`,
          panel: p,
          box: row(),
          text,
          checked: settings.snapKinds.has(kind),
          onChange: (v) => (v ? settings.snapKinds.add(kind) : settings.snapKinds.delete(kind)),
        }),
      );
    }
    p.mount(toggle({ id: "snap-text", panel: p, box: row(), text: "Text", checked: settings.snapText, onChange: (v) => (settings.snapText = v) }));
    gap();

    head("render-head", "Rendering", "Only what changed is redrawn; while you drag, what lies below and above is cached as two layers. Add 10,000 shapes and zoom out to see small things simplified.");
    box("render-stats", 44);
    p.mount(
      toggle({
        id: "lod",
        panel: p,
        box: row(),
        text: "Simplify what is too small to see",
        checked: settings.lod,
        onChange: (v) => {
          settings.lod = v;
          this.host.onLod();
        },
      }),
    );
    gap();

    head("a11y-head", "Accessibility", "Groups name their role and label in their meta. The tree is mirrored as DOM over the board for screen readers, so Tab reaches the controls and Enter presses them.");
    box("a11y", 150);
    gap();

    head("devtools-head", "Devtools", "Every op in drawing order, with the line of code that drew it. Step to draw the board up to one op.");
    p.mount(
      button({
        id: "devtools-open",
        panel: p,
        box: row(28),
        text: this.devtoolsOpen ? "Hide devtools" : "Show devtools",
        onClick: () => {
          this.devtoolsOpen = !this.devtoolsOpen;
          this.host.devtools.toggled();
          p.rebuild();
        },
      }),
    );
    if (this.devtoolsOpen) {
      p.mount(
        textField({
          id: "op-filter",
          panel: p,
          box: row(28),
          placeholder: "Filter by kind, id, group or source",
          onChange: (v) => {
            this.query = v;
            this.host.devtools.refresh();
          },
        }),
      );
      const filter = p.get<{ value: string }>("op-filter");
      if (filter && this.query) filter.setState({ value: this.query });
      p.mount(
        slider({ id: "op-step", panel: p, box: row(), text: "Step", min: 0, max: Math.max(1, this.step.max), value: this.step.value, onChange: (v) => this.host.devtools.stepTo(v) }),
      );
      const stepLabel = row(18);
      p.mount({
        id: "op-step-label",
        state: { text: this.step.label },
        draw: (c, s) => {
          c.font = `12px ${FONT}`;
          c.fillStyle = p.colors.muted;
          c.textBaseline = "middle";
          c.fillText(s.text, stepLabel.x, stepLabel.y + 9);
        },
      });
      box("op-list", 220, true, { onRow: (i) => this.host.devtools.pick(i), picked: () => this.picked });
      box("op-detail", 200);
    }
    gap();

    head("svg-head", "Add an SVG", "Copy SVG markup and press Ctrl+V (⌘V) on the page, or press the button; canvg draws it into the board.");
    p.mount(button({ id: "paste-svg", panel: p, box: row(28), text: "Paste SVG", onClick: () => this.host.pasteSvg() }));
    gap();

    head("log-head", "Events");
    box("log", 220);
    return y + PAD;
  }
}

export type { ButtonLook };
