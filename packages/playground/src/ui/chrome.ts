// The playground's controls, as two panels on the board made from the toolkit's: the playground card (drawing tools
// and actions) and the inspector, a scrolling card of drawing style, selection, snapping, rendering, accessibility,
// devtools, pasting SVG and the event log. What is the playground's own is the devtools section, the hints and the
// actions; the rest is the toolkit's board controls.
import type { Devtools } from "../devtools";
import {
  type ActionEntry,
  type Board,
  type BoardFeed,
  type CardLayer,
  FONT,
  Panel,
  type PanelItem,
  type SnapControls,
  type TextBoxState,
  type ToolEntry,
  actionItems,
  logItems,
  mirrorItems,
  renderItems,
  selectionItems,
  snapItems,
  styleItems,
  toolItems,
} from "@canvas-ir/toolkit";

/** What the board reads from the side panel's controls. */
export interface Settings {
  readonly snap: SnapControls;
  lod: boolean;
}

export interface ChromeHost {
  readonly board: Board;
  readonly feed: BoardFeed;
  readonly tools: readonly ToolEntry[];
  /** Buttons at the toolbar's end. */
  readonly actions: readonly ActionEntry[];
  readonly settings: Settings;
  readonly onLod: () => void;
  readonly devtools: Devtools;
  readonly pasteSvg: () => void;
}

export class Chrome {
  readonly toolbar: Panel;
  readonly side: Panel;
  private devtoolsOpen = false;
  private query = "";
  private step = { max: 0, value: 0, label: "" };
  private picked = -1;
  private ops = "";
  private detail = "";

  /** Puts the panels on `layer`, to the left of where the first samples are drawn. */
  constructor(layer: CardLayer, private readonly host: ChromeHost) {
    this.toolbar = new Panel(layer, { id: "playground", title: "CanvasIR Playground", x: -740, y: 20, width: 340, items: () => this.toolbarItems() });
    this.side = new Panel(layer, { id: "inspector", title: "Inspector", x: -380, y: 20, width: 330, height: 640, items: () => this.sideItems() });
    host.feed.attach(this.toolbar);
    host.feed.attach(this.side);
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
          this.side.refresh("op-step");
          this.side.card.get<{ text: string }>("op-step-label")?.setState({ text });
        }
      },
      showRows: (lines, picked) => {
        this.picked = picked;
        this.ops = lines.join("\n");
        this.side.refresh("op-list");
        // Keep the picked row in view.
        const box = this.side.card.get<TextBoxState>("op-list");
        if (box && picked >= 0 && (picked < box.state.scroll || picked >= box.state.scroll + 10)) box.setState({ scroll: Math.max(0, picked - 3) });
      },
      showDetail: (text) => {
        this.detail = text;
        this.side.refresh("op-detail");
      },
    };
  }

  private toolbarItems(): PanelItem[] {
    return [
      {
        kind: "section",
        id: "tools-head",
        title: "Tools",
        hint: "Keys V, P, R, O and T. Scroll to zoom, drag empty space to pan, and drag a card by its frame. Every feature is an icon somewhere on the board: zoom out to find them, press one to add it beside it.",
      },
      toolItems(this.host.board, this.host.tools),
      { kind: "section", id: "actions-head", title: "Do" },
      actionItems(this.host.actions),
    ];
  }

  private sideItems(): PanelItem[] {
    const { board, feed, settings, devtools } = this.host;
    const devtoolsItems: PanelItem[] = this.devtoolsOpen
      ? [
          {
            kind: "field",
            id: "op-filter",
            placeholder: "Filter by kind, id, group or source",
            value: () => this.query,
            onChange: (v) => {
              this.query = v;
              devtools.refresh();
            },
          },
          { kind: "slider", id: "op-step", text: "Step", min: 0, max: Math.max(1, this.step.max), value: () => this.step.value, onChange: (v) => devtools.stepTo(v) },
          {
            kind: "custom",
            height: 18,
            spec: (box) => ({
              id: "op-step-label",
              state: { text: this.step.label },
              draw: (c, s) => {
                c.font = `12px ${FONT}`;
                c.fillStyle = this.side.card.colors.muted;
                c.textBaseline = "middle";
                c.fillText((s as { text: string }).text, box.x, box.y + 9);
              },
            }),
          },
          { kind: "text", id: "op-list", label: "Ops", height: 220, text: () => this.ops, onRow: (i) => devtools.pick(i), picked: () => this.picked },
          { kind: "text", id: "op-detail", label: "Op details", height: 200, text: () => this.detail },
        ]
      : [];
    return [
      { kind: "section", id: "draw-head", title: "Draw", hint: "The pen, rectangle, ellipse and text tools draw with these. Shift keeps squares and circles; corners snap like a drag." },
      ...styleItems(board),
      { kind: "gap" },
      {
        kind: "section",
        id: "selection-head",
        title: "Selection",
        hint: "Drag moves an object, or one shape with Alt held; it snaps unless Ctrl or Cmd is held. Shift-click adds to the selection; Shift-drag on empty space lassoes. Delete removes. Scroll zooms; drag empty space to pan.",
      },
      selectionItems(feed),
      { kind: "gap" },
      { kind: "section", id: "snap-head", title: "Snapping", hint: "Text laid out around what you drag is never a target, since it moves as you drag." },
      ...snapItems(settings.snap),
      { kind: "gap" },
      {
        kind: "section",
        id: "render-head",
        title: "Rendering",
        hint: "Only what changed is redrawn; while you drag, what lies below and above is cached as two layers. Add 10,000 shapes and zoom out to see small things simplified.",
      },
      renderItems(feed),
      {
        kind: "toggle",
        id: "lod",
        text: "Simplify what is too small to see",
        checked: () => settings.lod,
        onChange: (v) => {
          settings.lod = v;
          this.host.onLod();
        },
      },
      { kind: "gap" },
      { kind: "section", id: "a11y-head", title: "Accessibility", hint: "Groups name their role and label in their meta. The tree is mirrored as DOM over the board for screen readers, so Tab reaches the controls and Enter presses them." },
      mirrorItems(feed),
      { kind: "gap" },
      { kind: "section", id: "devtools-head", title: "Devtools", hint: "Every op in drawing order, with the line of code that drew it. Step to draw the board up to one op." },
      {
        kind: "button",
        id: "devtools-open",
        text: () => (this.devtoolsOpen ? "Hide devtools" : "Show devtools"),
        onClick: () => {
          this.devtoolsOpen = !this.devtoolsOpen;
          devtools.toggled();
          this.side.rebuild();
        },
      },
      ...devtoolsItems,
      { kind: "gap" },
      { kind: "section", id: "svg-head", title: "Add an SVG", hint: "Copy SVG markup and press Ctrl+V (⌘V) on the page, or press the button; canvg draws it into the board." },
      { kind: "button", id: "paste-svg", text: () => "Paste SVG", onClick: () => this.host.pasteSvg() },
      { kind: "gap" },
      { kind: "section", id: "log-head", title: "Events" },
      logItems(feed),
    ];
  }
}
