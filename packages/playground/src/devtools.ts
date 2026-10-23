// Devtools: every op on the board in drawing order, with the line of code that
// drew it. Click a row to highlight the op and see its state; drag the step
// slider to draw the board up to that op only. It shows itself through a
// DevtoolsView: the side panel, drawn on canvas.
import { type Matrix2D, type Op, type Scene, applyToPoint, replayDocument } from "canvas-ir";

export interface DevtoolsHost {
  readonly scene: () => Scene;
  /** Op id to the stack line that drew it. */
  readonly sources: ReadonlyMap<string, string>;
  readonly select: (id: string) => void;
  readonly redraw: () => void;
  readonly images: (src: string) => CanvasImageSource | undefined;
}

/** Rows shown at once; the filter narrows a big board. */
const ROWS = 300;

/** An op as JSON, with long point lists cut short. */
const describeOp = (op: Op): string =>
  JSON.stringify(
    op,
    (key, value: unknown) => {
      if (Array.isArray(value) && value.length > 16 && typeof value[0] === "number") return [...value.slice(0, 16), `… ${value.length - 16} more`];
      if (key === "segments" && Array.isArray(value) && value.length > 6) return [...value.slice(0, 6), `… ${value.length - 6} more`];
      return value;
    },
    1,
  );

const shortSource = (line: string | undefined): string => {
  if (line === undefined) return "";
  // "fn (https://host/app.js:12:3)" → "fn :12:3", which in a minified bundle still tells calls apart.
  const m = /^(.*?)\s*\(?[^\s()]*?(:\d+:\d+)\)?$/.exec(line);
  return m ? `${m[1] || "anonymous"} ${m[2]}` : line;
};

/** Where devtools shows itself: the side panel's widgets, drawn on canvas. */
export interface DevtoolsView {
  /** Whether the panel is open; closed, nothing is listed. */
  readonly open: boolean;
  /** The filter's text. */
  readonly query: string;
  showStep(max: number, value: number, label: string): void;
  /** One line per row, and which is picked (or -1). */
  showRows(lines: readonly string[], picked: number): void;
  showDetail(text: string): void;
}

export class Devtools {
  /** Ops drawn while stepping, or null for all of them. */
  step: number | null = null;
  /** The op shown in detail and outlined. */
  focus: string | null = null;
  private pending = false;
  /** The op id of each listed row. */
  private rows: string[] = [];
  view: DevtoolsView | null = null;

  constructor(private readonly host: DevtoolsHost) {}

  /** Opened or closed: closing stops stepping. */
  toggled(): void {
    if (!this.view?.open) this.stop();
    this.refresh();
  }

  /** Draws only the first `n` ops (all of them at the end). */
  stepTo(n: number): void {
    const ops = this.host.scene().document.ops;
    this.step = n >= ops.length ? null : n;
    // The last op drawn is the one in focus.
    const last = ops[n - 1];
    if (this.step !== null && last) this.focus = last.id;
    this.refresh();
    this.host.redraw();
  }

  /** A listed row was clicked. */
  pick(row: number): void {
    const id = this.rows[row];
    if (id === undefined) return;
    this.focus = id;
    this.host.select(id);
    this.refresh();
  }

  /** Watches a new scene: the list follows its edits. */
  attach(scene: Scene): void {
    scene.onChange(() => this.refresh());
    this.stop();
    this.refresh();
  }

  /** Shows an op picked on the board. */
  show(id: string): void {
    if (!this.host.scene().get(id)) return;
    this.focus = id;
    this.refresh();
  }

  /** Back to drawing every op. */
  stop(): void {
    if (this.step === null) return;
    this.step = null;
    this.host.redraw();
  }

  /** Lists again on the next frame, so a drag that changes many ops lists once. */
  refresh(): void {
    if (this.pending || !this.view?.open) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.build();
    });
  }

  /** While stepping, draws the first ops only and returns true; otherwise leaves the board to the renderer. */
  drawBoard(ctx: CanvasRenderingContext2D, device: Matrix2D): boolean {
    if (this.step === null) return false;
    const document = this.host.scene().document;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    replayDocument(ctx, { ...document, ops: document.ops.slice(0, this.step) }, { view: device, images: this.host.images });
    return true;
  }

  /** Outlines the op in focus on the overlay. */
  preview(ctx: CanvasRenderingContext2D, device: Matrix2D, dpr: number): void {
    if (this.focus === null || !this.view?.open) return;
    const b = this.host.scene().bounds(this.focus);
    if (!b) return;
    const p = applyToPoint(device, b.x, b.y);
    const q = applyToPoint(device, b.x + b.width, b.y + b.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(p.x, p.y, q.x - p.x, q.y - p.y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#e11d48";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y);
  }

  private build(): void {
    const view = this.view;
    if (!view) return;
    const scene = this.host.scene();
    const ops = scene.document.ops;
    const query = view.query.trim().toLowerCase();
    view.showStep(ops.length, this.step ?? ops.length, this.step === null ? `all ${ops.length} ops drawn` : `drawing ops 1 to ${this.step} of ${ops.length}`);
    const lines: string[] = [];
    this.rows = [];
    let matches = 0;
    let picked = -1;
    const focusAt = this.focus === null ? -1 : scene.indexOf(this.focus);
    // Without a filter, the rows start a little before the op in focus, so it is always listed.
    const first = query === "" && focusAt >= ROWS ? focusAt - 20 : 0;
    for (let i = first; i < ops.length; i++) {
      const op = ops[i]!;
      const source = this.host.sources.get(op.id);
      // The outermost group's source names the sample or tool it came from, such as "Star".
      const top = op.group === undefined ? undefined : scene.getGroup(scene.groupChain(op.id).at(-1) ?? op.group);
      const from = typeof top?.meta?.["source"] === "string" ? top.meta["source"] : "";
      const label = `${i + 1} ${op.kind} ${op.id} ${op.group ?? ""} ${from} ${source ?? ""}`;
      if (query !== "" && !label.toLowerCase().includes(query)) continue;
      if (matches++ >= ROWS) continue;
      if (op.id === this.focus) picked = lines.length;
      const drawn = this.step !== null && i >= this.step ? "·" : " ";
      lines.push(`${drawn}${String(i + 1).padStart(5)} ${op.kind.padEnd(6)} ${op.id}  ${shortSource(source)}`);
      this.rows.push(op.id);
    }
    if (matches > ROWS) lines.push(`and ${matches - ROWS} more; type in the filter to narrow`);
    view.showRows(lines, picked);
    const op = this.focus === null ? undefined : scene.get(this.focus);
    if (!op) {
      view.showDetail("Click a row, or Alt-click a shape on the board.");
      return;
    }
    const source = this.host.sources.get(op.id);
    const chain = scene.groupChain(op.id);
    view.showDetail(
      [
        `#${scene.indexOf(op.id) + 1} ${op.kind} ${op.id}`,
        source ? `drawn at ${source}` : "drawn by the library (text layout, components) or replayed without a source",
        chain.length > 0 ? `inside ${chain.join(" < ")}` : "",
        describeOp(op),
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }
}
