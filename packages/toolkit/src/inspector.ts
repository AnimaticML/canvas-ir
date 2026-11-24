// The controls a board's toolbar and inspector are made of, as panel items: the tools, the drawing style, snapping,
// and boxes showing the selection, the last redraw, the accessibility tree and a log. `BoardFeed` keeps that text from
// what the board does and refreshes the panels showing it. A host puts these in its own panels, among its own
// controls, or takes `boardPanels` for a toolbar and an inspector as they come.
import type { AccessibleNode, SnapKind } from "canvas-ir";
import type { Board, SnapSettings } from "./board";
import type { CardLayer } from "./cards";
import type { ButtonLook } from "./controls";
import { Panel, type PanelItem } from "./panel";
import type { ToolName } from "./tools";

/** What the snapping controls set: grouped kinds a person can tell apart. */
export interface SnapControls {
  on: boolean;
  /** In screen pixels. */
  radius: number;
  kinds: Set<"points" | "bounds" | "path">;
  text: boolean;
}

export const snapControls = (): SnapControls => ({ on: true, radius: 8, kinds: new Set(["points", "bounds", "path"]), text: false });

const KIND_GROUPS: Record<"points" | "bounds" | "path", readonly SnapKind[]> = {
  points: ["vertex", "intersection", "center", "midpoint", "extreme", "baseline"],
  bounds: ["bounds"],
  path: ["path"],
};

/** What the board reads from the snapping controls. */
export const snapSettings = (c: SnapControls): SnapSettings => ({ on: c.on, radius: c.radius, kinds: [...c.kinds].flatMap((k) => KIND_GROUPS[k]), text: c.text });

export interface ToolEntry {
  readonly name: ToolName;
  readonly text: string;
  readonly key: string;
}

export const TOOLS: readonly ToolEntry[] = [
  { name: "select", text: "Select", key: "V" },
  { name: "pen", text: "Pen", key: "P" },
  { name: "rect", text: "Rectangle", key: "R" },
  { name: "ellipse", text: "Ellipse", key: "O" },
  { name: "text", text: "Text", key: "T" },
  { name: "arrow", text: "Arrow", key: "A" },
];

export interface ActionEntry {
  readonly text: string;
  readonly onClick: () => void;
  readonly look?: ButtonLook;
  readonly title?: string;
}

/** The tool buttons, the current one shown as on. */
export const toolItems = (board: Board, tools: readonly ToolEntry[] = TOOLS): PanelItem => ({
  kind: "buttons",
  buttons: tools.map((t) => ({ id: `tool-${t.name}`, text: t.text, title: `${t.text} (${t.key})`, onClick: () => board.useTool(t.name), active: () => board.tools.current === t.name })),
});

/** The host's own buttons. */
export const actionItems = (actions: readonly ActionEntry[]): PanelItem => ({
  kind: "buttons",
  buttons: actions.map((a, i) => ({ id: `action-${i}`, text: a.text, onClick: a.onClick, ...(a.look ? { look: a.look } : {}), ...(a.title ? { title: a.title } : {}) })),
});

const FILLS = ["#fde68a", "#fecaca", "#bbf7d0", "#bfdbfe", "#e9d5ff", "#ffffff", "transparent"];
const STROKES = ["#1f2937", "#dc2626", "#16a34a", "#2563eb", "#9333ea", "#f97316", "#ffffff"];

/** Fill, stroke and line width for what the tools draw. */
export const styleItems = (board: Board, colors: { fills?: readonly string[]; strokes?: readonly string[] } = {}): PanelItem[] => {
  const style = board.tools.style;
  return [
    { kind: "swatches", id: "fill", text: "Fill", colors: colors.fills ?? FILLS, value: () => style.fill, onChange: (v) => (style.fill = v) },
    { kind: "swatches", id: "stroke", text: "Stroke", colors: colors.strokes ?? STROKES, value: () => style.stroke, onChange: (v) => (style.stroke = v) },
    { kind: "slider", id: "width", text: "Width", min: 1, max: 16, value: () => style.lineWidth, format: (v) => `${v}px`, onChange: (v) => (style.lineWidth = v) },
  ];
};

/** Whether and to what a drag snaps. */
export const snapItems = (c: SnapControls): PanelItem[] => [
  { kind: "toggle", id: "snap-on", text: "Snap while dragging", checked: () => c.on, onChange: (v) => (c.on = v) },
  { kind: "slider", id: "snap-radius", text: "Radius", min: 2, max: 30, value: () => c.radius, format: (v) => `${v}px`, onChange: (v) => (c.radius = v) },
  ...(
    [
      ["points", "Corners, centers and crossings"],
      ["bounds", "Bounding boxes"],
      ["path", "Outlines"],
    ] as const
  ).map(
    ([kind, text]): PanelItem => ({ kind: "toggle", id: `snap-${kind}`, text, checked: () => c.kinds.has(kind), onChange: (v) => (v ? c.kinds.add(kind) : c.kinds.delete(kind)) }),
  ),
  { kind: "toggle", id: "snap-text", text: "Text", checked: () => c.text, onChange: (v) => (c.text = v) },
];

/** The accessibility tree as indented lines: role, label and value. */
export const outlineOf = (nodes: readonly AccessibleNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.role}${n.label ? ` "${n.label.length > 48 ? `${n.label.slice(0, 47)}…` : n.label}"` : ""}${n.value !== undefined ? ` = ${n.value}` : ""}`,
    ...outlineOf(n.children, depth + 1),
  ]);

/** What the board's text boxes show, kept from what the board does, and the panels to refresh when it changes. */
export class BoardFeed {
  selection = "Click something on the board.";
  stats = "Nothing drawn yet.";
  mirror = "";
  private lines: string[] = [];
  private readonly panels = new Set<Panel>();

  constructor(
    private readonly board: Board,
    private readonly keep = 200,
  ) {
    board.on("selected", (ids) => {
      this.selection = ids.length === 0 ? "Click something on the board." : ids.length === 1 ? board.describe(ids[0]!) : `${ids.length} objects\n${ids.join(", ")}`;
      this.refresh("selection");
    });
    board.on("drawn", (stats, ms) => {
      this.stats = `${stats.mode} redraw: ${stats.ops} of ${board.scene.document.ops.length} ops in ${ms.toFixed(1)} ms${stats.rects.length > 0 ? `, ${stats.rects.length} rect${stats.rects.length > 1 ? "s" : ""}` : ""}`;
      this.refresh("render-stats");
    });
    board.on("mirror", (tree) => {
      this.mirror = outlineOf(tree).join("\n");
      this.refresh("a11y");
    });
    board.on("log", (line) => this.log(line));
    board.on("tool", () => {
      for (const p of this.panels) p.refresh();
    });
  }

  /** The log, newest first. */
  get logText(): string {
    return this.lines.join("\n");
  }

  log(line: string): void {
    this.lines = [line, ...this.lines].slice(0, this.keep);
    this.refresh("log");
  }

  /** Keeps a panel showing this feed. */
  attach(panel: Panel): void {
    this.panels.add(panel);
  }

  private refresh(id: string): void {
    for (const p of this.panels) p.refresh(id);
  }
}

export const selectionItems = (feed: BoardFeed, height = 96): PanelItem => ({ kind: "text", id: "selection", label: "Selection", height, text: () => feed.selection });
export const renderItems = (feed: BoardFeed): PanelItem => ({ kind: "text", id: "render-stats", label: "Last redraw", height: 44, text: () => feed.stats });
export const mirrorItems = (feed: BoardFeed, height = 150): PanelItem => ({ kind: "text", id: "a11y", label: "Accessibility tree", height, text: () => feed.mirror });
export const logItems = (feed: BoardFeed, height = 220): PanelItem => ({ kind: "text", id: "log", label: "Events", height, text: () => feed.logText });

export interface BoardPanelsOptions {
  readonly x: number;
  readonly y: number;
  readonly title?: string;
  readonly tools?: readonly ToolEntry[];
  readonly actions?: readonly ActionEntry[];
  readonly snap?: SnapControls;
  /** How tall the inspector shows; it scrolls beyond. */
  readonly height?: number;
}

/** A toolbar (the tools and the host's actions) and, to its right, an inspector (style, selection, snapping, redraws, the tree, a log). */
export const boardPanels = (board: Board, layer: CardLayer, options: BoardPanelsOptions): { toolbar: Panel; inspector: Panel; feed: BoardFeed } => {
  const feed = new BoardFeed(board);
  const toolbar = new Panel(layer, {
    id: "toolbar",
    title: options.title ?? "Tools",
    x: options.x,
    y: options.y,
    width: 300,
    items: () => [
      { kind: "section", id: "tools-head", title: "Tools", hint: "Keys V, P, R, O, T and A. Scroll or pinch to zoom, drag empty space to pan." },
      toolItems(board, options.tools),
      ...(options.actions?.length ? [{ kind: "section", id: "actions-head", title: "Do" } as const, actionItems(options.actions)] : []),
    ],
  });
  const inspector = new Panel(layer, {
    id: "inspector",
    title: "Inspector",
    x: options.x + 320,
    y: options.y,
    width: 300,
    ...(options.height !== undefined ? { height: options.height } : {}),
    items: () => [
      { kind: "section", id: "draw-head", title: "Draw" },
      ...styleItems(board),
      { kind: "section", id: "selection-head", title: "Selection" },
      selectionItems(feed),
      ...(options.snap ? [{ kind: "section", id: "snap-head", title: "Snapping" } as const, ...snapItems(options.snap)] : []),
      { kind: "section", id: "render-head", title: "Rendering" },
      renderItems(feed),
      { kind: "section", id: "a11y-head", title: "Accessibility" },
      mirrorItems(feed),
      { kind: "section", id: "log-head", title: "Events" },
      logItems(feed),
    ],
  });
  feed.attach(toolbar);
  feed.attach(inspector);
  return { toolbar, inspector, feed };
};
