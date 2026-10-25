// A table of a million rows on the board. Its body is a VirtualGroup: only the
// rows that show are recorded, each as a group keyed by its record, and they
// are recorded again as it scrolls. The data is never stored: each cell is
// made from its row number, and sorting keeps an order of row numbers. Cells
// are selected as a spreadsheet's are, and copied as tab-separated text.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type RouterEvent, type Scene, VirtualGroup } from "canvas-ir";

export const TABLE_ID = "million-rows";
export const TABLE_AT = { x: 1200, y: 2500 };
const ROWS = 1_000_000;
const ROW = 28;
const TITLE = 44;
const HEADER = 34;
const BODY = 476;
const FONT = "13px system-ui, -apple-system, 'Segoe UI', sans-serif";

type Key = "id" | "name" | "city" | "product" | "amount" | "date" | "status";
interface Column {
  readonly key: Key;
  readonly title: string;
  readonly width: number;
  readonly right?: boolean;
}
const COLUMNS: readonly Column[] = [
  { key: "id", title: "#", width: 96, right: true },
  { key: "name", title: "Name", width: 170 },
  { key: "city", title: "City", width: 120 },
  { key: "product", title: "Product", width: 150 },
  { key: "amount", title: "Amount", width: 110, right: true },
  { key: "date", title: "Date", width: 112 },
  { key: "status", title: "Status", width: 100 },
];
const WIDTH = COLUMNS.reduce((w, c) => w + c.width, 0);
const LEFT = COLUMNS.map((_, i) => COLUMNS.slice(0, i).reduce((w, c) => w + c.width, 0));

const FIRST = ["Ada", "Alan", "Anya", "Bo", "Carmen", "Dmitri", "Elena", "Femi", "Grace", "Hana", "Ivan", "Jun", "Kai", "Lena", "Maya", "Nia", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tara", "Uma", "Vera", "Wei", "Yuki", "Zoe"];
const LAST = ["Abe", "Berg", "Costa", "Dias", "Evans", "Fischer", "Garcia", "Hall", "Ito", "Jensen", "Khan", "Lopez", "Moreau", "Novak", "Okafor", "Petrov", "Quist", "Rossi", "Sato", "Tanaka", "Ueda", "Volkov", "Weber", "Young", "Zhang"];
const CITIES = ["Amsterdam", "Berlin", "Cairo", "Dublin", "Kyiv", "Lagos", "Lima", "Lisbon", "Madrid", "Nairobi", "Oslo", "Osaka", "Paris", "Prague", "Seoul", "Sydney", "Tbilisi", "Tokyo", "Toronto", "Vienna"];
const PRODUCTS = ["Canvas", "Easel", "Brush set", "Oil paints", "Palette knife", "Sketchbook", "Charcoal", "Ink", "Pastels", "Frame", "Varnish", "Gouache"];
const STATUSES = ["Paid", "Pending", "Shipped", "Refunded"];
const STATUS_COLORS = ["#16a34a", "#d97706", "#2563eb", "#dc2626"];

/** A number from a row and a column, the same every time: the cell's content without storing it. */
const hash = (row: number, salt: number): number => {
  let h = Math.imul(row ^ (salt * 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const pick = <T>(list: readonly T[], row: number, salt: number): number => hash(row, salt) % list.length;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const DAY = 86_400_000;
const START = Date.UTC(2020, 0, 1);

const cell = (row: number, key: Key): string => {
  switch (key) {
    case "id":
      return String(row + 1);
    case "name":
      return `${FIRST[pick(FIRST, row, 1)]} ${LAST[pick(LAST, row, 2)]}`;
    case "city":
      return CITIES[pick(CITIES, row, 3)]!;
    case "product":
      return PRODUCTS[pick(PRODUCTS, row, 4)]!;
    case "amount":
      return money.format((hash(row, 5) % 500_000) / 100);
    case "date":
      return new Date(START + (hash(row, 6) % 2000) * DAY).toISOString().slice(0, 10);
    case "status":
      return STATUSES[pick(STATUSES, row, 7)]!;
  }
};

/** What a column sorts by, as a number per row. */
const sortKey = (key: Key): ((row: number) => number) => {
  const rank = (list: readonly string[]) => {
    const sorted = [...list].sort();
    const ranks = list.map((v) => sorted.indexOf(v));
    return (i: number) => ranks[i]!;
  };
  const first = rank(FIRST);
  const last = rank(LAST);
  const city = rank(CITIES);
  const product = rank(PRODUCTS);
  const status = rank(STATUSES);
  switch (key) {
    case "id":
      return (r) => r;
    case "name":
      return (r) => last(pick(LAST, r, 2)) * 100 + first(pick(FIRST, r, 1));
    case "city":
      return (r) => city(pick(CITIES, r, 3));
    case "product":
      return (r) => product(pick(PRODUCTS, r, 4));
    case "amount":
      return (r) => hash(r, 5) % 500_000;
    case "date":
      return (r) => hash(r, 6) % 2000;
    case "status":
      return (r) => status(pick(STATUSES, r, 7));
  }
};

interface Cell {
  /** Position in the current order, and column index. */
  readonly pos: number;
  readonly col: number;
}

interface FrameState {
  readonly scroll: number;
  readonly sort: { key: Key; desc: boolean } | null;
  readonly note: string;
}

export interface TableHost {
  readonly components: () => Components;
  readonly render: () => void;
  readonly log: (line: string) => void;
}

export class MillionRows {
  /** Row numbers in display order; null while unsorted. */
  private order: Uint32Array | null = null;
  private scroll = 0;
  private x = TABLE_AT.x;
  private y = TABLE_AT.y;
  private anchor: Cell | null = null;
  private focus: Cell | null = null;
  private sort: { key: Key; desc: boolean } | null = null;
  private note = "";
  private readonly body: VirtualGroup;
  private frame: ComponentHandle<FrameState> | null = null;
  private unlisten: (() => void)[] = [];
  private readonly widths = new Map<string, number>();
  private measure: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly host: TableHost,
  ) {
    this.measure = new OffscreenCanvas(1, 1).getContext("2d")!;
    this.measure.font = FONT;
    scene.addGroup({ id: TABLE_ID, meta: { role: "grid", label: "A million rows", source: "million rows" } });
    this.frame = host.components().mount(this.frameSpec());
    this.body = new VirtualGroup(scene, {
      id: `${TABLE_ID}:rows`,
      parent: TABLE_ID,
      meta: { role: "rowgroup" },
      extent: { x: 0, y: 0, width: WIDTH, height: ROWS * ROW },
      draw: (ctx, window) => this.drawRows(ctx, window),
    });
    this.show();
    this.listen();
  }

  /** Whether the table is still on the board. */
  get alive(): boolean {
    return this.scene.getGroup(TABLE_ID) !== undefined;
  }

  /** The table's box on the board. */
  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: WIDTH + 14, height: TITLE + HEADER + BODY };
  }

  /** Follows the board into a scene rebuilt from its document. */
  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.body.bind(scene);
    this.listen();
  }

  /** The board moved the table (its frame moved with its component). */
  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.show(true);
  }

  private listen(): void {
    for (const off of this.unlisten) off();
    const rows = `${TABLE_ID}:rows`;
    const at = (e: RouterEvent): Cell | null => {
      const x = e.point.x - this.x;
      const y = e.point.y - this.y - TITLE - HEADER + this.scroll;
      const col = LEFT.findIndex((l, i) => x >= l && x < l + COLUMNS[i]!.width);
      const pos = Math.floor(y / ROW);
      return col < 0 || pos < 0 || pos >= ROWS ? null : { pos, col };
    };
    this.unlisten = [
      // A press on a cell selects it, Shift extends the selection, and dragging sweeps a range; the board doesn't move the table.
      this.router.on(rows, "down", (e) => {
        e.stopPropagation();
        const c = at(e);
        if (!c) return;
        if (!("shiftKey" in e.input && e.input.shiftKey) || !this.anchor) this.anchor = c;
        this.focus = c;
        this.body.refresh();
        this.host.render();
      }),
      this.router.on(rows, "dragstart", (e) => e.stopPropagation()),
      this.router.on(rows, "drag", (e) => {
        e.stopPropagation();
        const c = at(e);
        if (!c || (c.pos === this.focus?.pos && c.col === this.focus.col)) return;
        this.focus = c;
        this.body.refresh();
        this.host.render();
      }),
      this.router.on(rows, "click", (e) => e.stopPropagation()),
      this.router.on(TABLE_ID, "wheel", (e) => {
        const input = e.input as { deltaY?: number; ctrlKey?: boolean; metaKey?: boolean };
        if (input.ctrlKey || input.metaKey) return;
        e.stopPropagation();
        this.scrollTo(this.scroll + (input.deltaY ?? 0));
      }),
      this.router.on(TABLE_ID, "keydown", (e) => {
        const k = e.input as { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
        if ((k.ctrlKey || k.metaKey) && k.key.toLowerCase() === "c") {
          e.stopPropagation();
          this.copy();
          return;
        }
        const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-16, 0], PageDown: [16, 0] };
        const d = step[k.key];
        if (!d || !this.focus) return;
        e.stopPropagation();
        const next = { pos: Math.max(0, Math.min(ROWS - 1, this.focus.pos + d[0])), col: Math.max(0, Math.min(COLUMNS.length - 1, this.focus.col + d[1])) };
        if (!k.shiftKey) this.anchor = next;
        this.focus = next;
        // Keep the focused cell in view.
        const top = next.pos * ROW;
        if (top < this.scroll) this.scrollTo(top);
        else if (top + ROW > this.scroll + BODY) this.scrollTo(top + ROW - BODY);
        else this.body.refresh();
        this.host.render();
      }),
    ];
  }

  private scrollTo(y: number): void {
    const next = Math.max(0, Math.min(ROWS * ROW - BODY, y));
    if (next === this.scroll) return;
    this.scroll = next;
    this.show();
  }

  /** Places the rows for the scroll and draws what changed. */
  private show(moved = false): void {
    const t0 = performance.now();
    const view = {
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y + TITLE + HEADER - this.scroll },
      visible: { x: this.x, y: this.y + TITLE + HEADER, width: WIDTH, height: BODY },
      clip: true,
    };
    this.body.show(view);
    const ms = performance.now() - t0;
    const rows = Math.ceil(BODY / ROW) + 1;
    this.note = `${rows} of ${ROWS.toLocaleString("en-US")} rows recorded in ${ms.toFixed(1)} ms`;
    if (!moved) this.frame?.setState({ scroll: this.scroll, note: this.note });
    this.host.render();
  }

  private rowAt(pos: number): number {
    return this.order ? this.order[pos]! : pos;
  }

  private selected(): { top: number; bottom: number; left: number; right: number } | null {
    if (!this.anchor || !this.focus) return null;
    return {
      top: Math.min(this.anchor.pos, this.focus.pos),
      bottom: Math.max(this.anchor.pos, this.focus.pos),
      left: Math.min(this.anchor.col, this.focus.col),
      right: Math.max(this.anchor.col, this.focus.col),
    };
  }

  private fit(text: string, width: number): string {
    let w = this.widths.get(text);
    if (w === undefined) {
      w = this.measure.measureText(text).width;
      if (this.widths.size > 20_000) this.widths.clear();
      this.widths.set(text, w);
    }
    if (w <= width) return text;
    let s = text;
    while (s.length > 1 && this.measure.measureText(`${s}…`).width > width) s = s.slice(0, -1);
    return `${s}…`;
  }

  private drawRows(ctx: RecordingContext, window: { y: number; height: number }): void {
    const first = Math.max(0, Math.floor(window.y / ROW));
    const last = Math.min(ROWS - 1, Math.ceil((window.y + window.height) / ROW) - 1);
    const sel = this.selected();
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    for (let pos = first; pos <= last; pos++) {
      const row = this.rowAt(pos);
      const y = pos * ROW;
      // Keyed by the record, so a row is the same group wherever sorting puts it.
      ctx.beginGroup({ id: `r${row}`, meta: { role: "row", label: `Row ${row + 1}` } });
      ctx.fillStyle = pos % 2 ? "#f8fafc" : "#ffffff";
      ctx.fillRect(0, y, WIDTH, ROW);
      if (sel && pos >= sel.top && pos <= sel.bottom) {
        ctx.fillStyle = "rgba(37, 99, 235, 0.14)";
        ctx.fillRect(LEFT[sel.left]!, y, LEFT[sel.right]! + COLUMNS[sel.right]!.width - LEFT[sel.left]!, ROW);
      }
      COLUMNS.forEach((col, i) => {
        const text = cell(row, col.key);
        const shown = this.fit(text, col.width - 20);
        ctx.fillStyle = col.key === "status" ? STATUS_COLORS[STATUSES.indexOf(text)]! : col.key === "id" ? "#94a3b8" : "#1f2937";
        ctx.textAlign = col.right ? "right" : "left";
        ctx.fillText(shown, col.right ? LEFT[i]! + col.width - 10 : LEFT[i]! + 10, y + ROW / 2);
      });
      ctx.textAlign = "left";
      if (this.focus && this.focus.pos === pos) {
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 2;
        ctx.strokeRect(LEFT[this.focus.col]! + 1, y + 1, COLUMNS[this.focus.col]!.width - 2, ROW - 2);
      }
      ctx.endGroup();
    }
  }

  private sortBy(key: Key): void {
    const desc = this.sort?.key === key ? !this.sort.desc : false;
    const t0 = performance.now();
    if (key === "id") this.order = desc ? Uint32Array.from({ length: ROWS }, (_, i) => ROWS - 1 - i) : null;
    else {
      const of = sortKey(key);
      const keys = new Float64Array(ROWS);
      for (let r = 0; r < ROWS; r++) keys[r] = of(r);
      const order = new Uint32Array(ROWS);
      for (let r = 0; r < ROWS; r++) order[r] = r;
      const sign = desc ? -1 : 1;
      order.sort((a, b) => sign * (keys[a]! - keys[b]!) || a - b);
      this.order = order;
    }
    const ms = performance.now() - t0;
    this.sort = { key, desc };
    this.anchor = this.focus = null;
    this.host.log(`million rows: sorted by ${key}${desc ? ", descending" : ""} in ${ms.toFixed(0)} ms`);
    this.scroll = 0;
    this.body.refresh();
    this.show();
    this.frame?.setState({ sort: this.sort });
  }

  private copy(): void {
    const sel = this.selected();
    if (!sel) return;
    // Up to 10,000 rows: past that a clipboard is the wrong tool.
    const bottom = Math.min(sel.bottom, sel.top + 9999);
    const lines: string[] = [];
    for (let pos = sel.top; pos <= bottom; pos++) {
      const row = this.rowAt(pos);
      lines.push(COLUMNS.slice(sel.left, sel.right + 1).map((c) => cell(row, c.key)).join("\t"));
    }
    void navigator.clipboard.writeText(lines.join("\n")).then(
      () => this.host.log(`million rows: copied ${lines.length} rows as tab-separated text`),
      () => this.host.log("million rows: the browser didn't let the page write to the clipboard"),
    );
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const H = TITLE + HEADER + BODY;
    return {
      id: `${TABLE_ID}:frame`,
      parent: TABLE_ID,
      state: { scroll: 0, sort: null, note: "" },
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y },
      cursor: (_, ui) => (ui.hoveredParts.some((g) => g.meta?.["column"] !== undefined) ? "pointer" : null),
      draw: (c, s) => {
        c.shadowColor = "rgba(15, 23, 42, 0.16)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(-1, -1, WIDTH + 16, H + 2, 10);
        c.fillStyle = "#ffffff";
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 1;
        c.stroke();
        c.font = "600 15px system-ui, sans-serif";
        c.fillStyle = "#0f172a";
        c.textBaseline = "middle";
        c.fillText("A million rows", 14, TITLE / 2);
        c.font = "12px system-ui, sans-serif";
        c.fillStyle = "#64748b";
        c.textAlign = "right";
        c.fillText(`${s.note}. Click a header to sort; Shift-click or drag to select; Ctrl+C copies.`, WIDTH, TITLE / 2);
        c.textAlign = "left";
        c.fillStyle = "#f1f5f9";
        c.fillRect(0, TITLE, WIDTH + 14, HEADER);
        c.font = "600 12.5px system-ui, sans-serif";
        COLUMNS.forEach((col, i) => {
          c.beginGroup({ id: `h-${col.key}`, meta: { role: "columnheader", label: col.title, column: col.key } });
          c.fillStyle = "#f1f5f9";
          c.fillRect(LEFT[i]!, TITLE, col.width, HEADER);
          const arrow = s.sort?.key === col.key ? (s.sort.desc ? " ↓" : " ↑") : "";
          c.fillStyle = "#334155";
          c.textAlign = col.right ? "right" : "left";
          c.fillText(col.title + arrow, col.right ? LEFT[i]! + col.width - 10 : LEFT[i]! + 10, TITLE + HEADER / 2);
          c.textAlign = "left";
          c.endGroup();
        });
        c.fillStyle = "#cbd5e1";
        c.fillRect(0, TITLE + HEADER - 1, WIDTH, 1);
        // Where the rows that show are among the million, in the gutter right of the rows.
        const track = BODY - 8;
        const bar = Math.max(24, (track * BODY) / (ROWS * ROW));
        const top = TITLE + HEADER + 4 + ((track - bar) * s.scroll) / (ROWS * ROW - BODY);
        c.fillStyle = "rgba(100, 116, 139, 0.5)";
        c.beginPath();
        c.roundRect(WIDTH + 5, top, 4, bar, 2);
        c.fill();
      },
      on: {
        click: (e) => {
          const column = e.path.map((id) => this.scene.getGroup(id)?.meta?.["column"]).find((k) => k !== undefined);
          if (typeof column !== "string") return;
          e.stopPropagation();
          this.sortBy(column as Key);
        },
      },
    };
  }
}
