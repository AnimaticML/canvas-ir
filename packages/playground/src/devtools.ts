// Devtools: every op on the board in drawing order, with the line of code that
// drew it. Click a row to highlight the op and see its state; drag the step
// slider to draw the board up to that op only.
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

export class Devtools {
  /** Ops drawn while stepping, or null for all of them. */
  step: number | null = null;
  /** The op shown in detail and outlined. */
  focus: string | null = null;
  private pending = false;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly slider: HTMLInputElement;
  private readonly stepLabel: HTMLElement;
  private readonly panel: HTMLDetailsElement;

  constructor(private readonly host: DevtoolsHost) {
    this.panel = document.getElementById("devtools") as HTMLDetailsElement;
    this.list = document.getElementById("op-list")!;
    this.detail = document.getElementById("op-detail")!;
    this.filter = document.getElementById("op-filter") as HTMLInputElement;
    this.slider = document.getElementById("op-step") as HTMLInputElement;
    this.stepLabel = document.getElementById("op-step-label")!;
    this.panel.addEventListener("toggle", () => {
      if (!this.panel.open) this.stop();
      this.refresh();
    });
    this.filter.addEventListener("input", () => this.refresh());
    this.slider.addEventListener("input", () => {
      const ops = this.host.scene().document.ops;
      const n = Number(this.slider.value);
      this.step = n >= ops.length ? null : n;
      // The last op drawn is the one in focus.
      const last = ops[n - 1];
      if (this.step !== null && last) this.focus = last.id;
      this.refresh();
      this.host.redraw();
    });
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-op]");
      if (!row) return;
      this.focus = row.dataset["op"]!;
      this.host.select(this.focus);
      this.refresh();
    });
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
    if (this.pending || !this.panel.open) return;
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
    if (this.focus === null || !this.panel.open) return;
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
    const scene = this.host.scene();
    const ops = scene.document.ops;
    const query = this.filter.value.trim().toLowerCase();
    this.slider.max = String(ops.length);
    this.slider.value = String(this.step ?? ops.length);
    this.stepLabel.textContent = this.step === null ? `all ${ops.length} ops drawn` : `drawing ops 1 to ${this.step} of ${ops.length}`;
    const rows: string[] = [];
    let matches = 0;
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
      const dim = this.step !== null && i >= this.step ? " dim" : "";
      const on = op.id === this.focus ? " on" : "";
      rows.push(
        `<div class="op-row${dim}${on}" data-op="${escape(op.id)}"><span class="n">${i + 1}</span><span class="k">${op.kind}</span><span class="id" title="${escape(from)}">${escape(op.id)}</span><span class="src" title="${escape(source ?? "")}">${escape(shortSource(source))}</span></div>`,
      );
    }
    if (matches > ROWS) rows.push(`<div class="op-more">and ${matches - ROWS} more; type in the filter to narrow</div>`);
    this.list.innerHTML = rows.join("");
    this.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    const op = this.focus === null ? undefined : scene.get(this.focus);
    if (!op) {
      this.detail.textContent = "Click a row, or Alt-click a shape on the board.";
      return;
    }
    const source = this.host.sources.get(op.id);
    const chain = scene.groupChain(op.id);
    this.detail.textContent = [
      `#${scene.indexOf(op.id) + 1} ${op.kind} ${op.id}`,
      source ? `drawn at ${source}` : "drawn by the library (text layout, components) or replayed without a source",
      chain.length > 0 ? `inside ${chain.join(" < ")}` : "",
      describeOp(op),
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
}

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
