// Drawing tools: pen, rectangle, ellipse and text. Each records a new group
// through a RecordingContext and hands it to the board, which swaps it into the
// scene; while drawing, a preview goes on the overlay. Corners snap to the
// board like a drag does.
import { RecordingContext, type Matrix2D, type Point, type RecordingContextOptions, type Scene, applyToPoint, fitCurve, simplifyPolyline, traceCurve } from "canvas-ir";

export type ToolName = "select" | "pen" | "rect" | "ellipse" | "text";

export interface ToolHost {
  readonly scene: () => Scene;
  readonly toWorld: (screen: Point) => Point;
  /** World units per screen pixel, for tolerances that should feel the same at any zoom. */
  readonly pixel: () => number;
  /** A snapped point near `world`, or null; `kind` is shown on the board. */
  readonly snap: (world: Point) => { point: Point; kind: string } | null;
  /** Puts a newly recorded group on the board. */
  readonly commit: (id: string, draw: (ctx: RecordingContext) => void) => void;
  readonly recorder: RecordingContextOptions;
  readonly stage: HTMLElement;
  readonly redraw: () => void;
  readonly log: (line: string) => void;
}

export interface Style {
  fill: string;
  stroke: string;
  lineWidth: number;
}

let count = 0;

export class Tools {
  current: ToolName = "select";
  readonly style: Style = { fill: "#fde68a", stroke: "#1f2937", lineWidth: 3 };
  private points: Point[] = [];
  private from: Point | null = null;
  private to: Point | null = null;
  private square = false;
  /** The snap shown while drawing. */
  mark: { point: Point; kind: string } | null = null;
  private editor: HTMLTextAreaElement | null = null;

  constructor(private readonly host: ToolHost) {}

  /** Whether a press is being turned into a shape. */
  get drawing(): boolean {
    return this.from !== null;
  }

  /** Whether the tool takes this pointer press (anything but select does). */
  down(screen: Point, shift: boolean): boolean {
    if (this.current === "select") return false;
    const p = this.place(screen);
    if (this.current === "text") {
      this.openEditor(screen, p);
      return true;
    }
    this.from = p;
    this.to = p;
    this.points = [p];
    this.square = shift;
    this.host.redraw();
    return true;
  }

  move(screen: Point, shift: boolean): void {
    if (!this.from) return;
    this.square = shift;
    if (this.current === "pen") {
      this.points.push(this.host.toWorld(screen));
      this.mark = null;
    } else {
      this.to = this.place(screen);
    }
    this.host.redraw();
  }

  up(): void {
    if (!this.from) return;
    const from = this.from;
    const to = this.box(from, this.to ?? from);
    const points = this.points;
    this.from = null;
    this.to = null;
    this.points = [];
    this.mark = null;
    const id = `drawn-${this.current}-${count++}`;
    const { fill, stroke, lineWidth } = this.style;
    if (this.current === "pen") {
      if (points.length < 2) return this.host.redraw();
      // Thin the freehand points, then fit as few curves as stay within a screen pixel or so.
      const px = this.host.pixel();
      const simple = simplifyPolyline(points, 0.6 * px);
      const pieces = fitCurve(simple, 1.2 * px, { cornerAngle: 70 });
      this.host.commit(id, (ctx) => {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        traceCurve(ctx, pieces);
        ctx.stroke();
      });
      this.host.log(`pen: ${points.length} points, simplified to ${simple.length}, fitted with ${pieces.length} curves`);
      return;
    }
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const w = Math.abs(to.x - from.x);
    const h = Math.abs(to.y - from.y);
    if (w < 1 && h < 1) return this.host.redraw();
    this.host.commit(id, (ctx) => {
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      if (this.current === "rect") ctx.rect(x, y, w, h);
      else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    this.host.log(`${this.current} ${w.toFixed(0)} × ${h.toFixed(0)}`);
  }

  /** The preview, in device pixels on the overlay. */
  preview(ctx: CanvasRenderingContext2D, device: Matrix2D, dpr: number): void {
    if (this.current === "pen" && this.points.length > 1) {
      ctx.strokeStyle = this.style.stroke;
      ctx.lineWidth = this.style.lineWidth * Math.hypot(device.a, device.b);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const p of this.points) {
        const q = applyToPoint(device, p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    } else if (this.from && this.to && (this.current === "rect" || this.current === "ellipse")) {
      const to = this.box(this.from, this.to);
      const a = applyToPoint(device, this.from.x, this.from.y);
      const b = applyToPoint(device, to.x, to.y);
      ctx.fillStyle = this.style.fill;
      ctx.strokeStyle = this.style.stroke;
      ctx.lineWidth = this.style.lineWidth * Math.hypot(device.a, device.b);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      if (this.current === "rect") ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (this.mark) {
      const q = applyToPoint(device, this.mark.point.x, this.mark.point.y);
      const r = 5 * dpr;
      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(q.x - r, q.y - r, 2 * r, 2 * r);
    }
  }

  cancel(): void {
    this.from = null;
    this.to = null;
    this.points = [];
    this.mark = null;
    this.editor?.remove();
    this.editor = null;
  }

  /** The pointer in world space, snapped to the board when something is near. */
  private place(screen: Point): Point {
    const world = this.host.toWorld(screen);
    this.mark = this.host.snap(world);
    return this.mark?.point ?? world;
  }

  /** With Shift held, a square or circle. */
  private box(from: Point, to: Point): Point {
    if (!this.square) return to;
    const side = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    return { x: from.x + Math.sign(to.x - from.x || 1) * side, y: from.y + Math.sign(to.y - from.y || 1) * side };
  }

  private openEditor(screen: Point, world: Point): void {
    this.editor?.remove();
    const editor = document.createElement("textarea");
    editor.className = "text-editor";
    editor.style.left = `${screen.x}px`;
    editor.style.top = `${screen.y - 10}px`;
    editor.placeholder = "Type, then Enter";
    this.host.stage.append(editor);
    this.editor = editor;
    setTimeout(() => editor.focus());
    const finish = (keep: boolean): void => {
      if (this.editor !== editor) return;
      this.editor = null;
      const text = editor.value.trimEnd();
      editor.remove();
      if (!keep || text === "") return;
      const lines = text.split("\n");
      const id = `drawn-text-${count++}`;
      this.host.commit(id, (ctx) => {
        ctx.font = "18px system-ui, sans-serif";
        ctx.fillStyle = this.style.stroke;
        ctx.textBaseline = "top";
        lines.forEach((line, i) => ctx.fillText(line, world.x, world.y + i * 24));
      });
      this.host.log(`text "${lines[0]}"${lines.length > 1 ? ` and ${lines.length - 1} more lines` : ""}`);
    };
    editor.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") finish(false);
    });
    editor.addEventListener("blur", () => finish(true));
  }
}
