// A whole novel on the board: War and Peace, 566,000 words in the Maude
// translation, from Project Gutenberg's plain text (scripts/build-book.ts).
// Each chapter is laid out with @canvas-ir/text when it first comes into
// view, and the rest in slices between frames, so reading starts at once and
// the whole book is laid out a second or two later; until then a chapter not
// yet laid out takes the height its length suggests. The text is a
// VirtualGroup that records the lines that show. Search runs over the raw
// text and jumps to each match; a bigger or smaller font lays the book out
// again.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type RecordingContextOptions, type Scene, VirtualGroup } from "canvas-ir";
import { type Block, type TextLayout, canvasMeasurer, layoutText } from "@canvas-ir/text";
import bookUrl from "./book/war-and-peace.txt" with { type: "file" };
import { textSink } from "./ui/kit";

export const BOOK_ID = "war-and-peace";
export const BOOK_AT = { x: 1300, y: 4350 };
const W = 1180;
const TITLE = 46;
const BODY = 800;
const STATUS = 28;
const SIDE = 250;
const GUTTER = 14;
const AREA = W - GUTTER - SIDE;
const COLUMN = 640;
const TEXT_X = SIDE + (AREA - COLUMN) / 2;
const ROW = 22;
const SIZES = [14, 15, 17, 19, 22, 26];
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
/** Space between chapters, in px at the body size. */
const GAP = 2.5;
/** Time a slice of background layout may take, in ms: well inside a frame. */
const SLICE = 10;

/** A chapter, with the book's title before it when it opens a book. */
interface Section {
  readonly book: number;
  readonly title: string | null;
  readonly chapter: string;
  /** Its paragraphs: indices into the book's. */
  readonly first: number;
  readonly count: number;
  readonly chars: number;
  layout: TextLayout | null;
}

/** A row of the contents: a book, or a chapter in it. */
interface Entry {
  readonly section: number;
  readonly text: string;
  readonly book: boolean;
}

interface Match {
  readonly paragraph: number;
  readonly start: number;
}

interface FrameState {
  readonly scroll: number;
  readonly current: number;
  readonly contents: number;
  readonly query: string;
  readonly caret: number;
  readonly editing: boolean;
  readonly note: string;
}

export interface BookHost {
  readonly components: () => Components;
  readonly render: () => void;
  readonly log: (line: string) => void;
  /** Where a board point is on the page, for the search field's hidden textarea. */
  readonly toPage: (x: number, y: number) => { x: number; y: number };
  readonly recorder?: RecordingContextOptions;
}

/** Lowercase without accents, character for character so offsets still point into the text; as lowercase alone where that would move them. */
const fold = (text: string): string => {
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return folded.length === text.length ? folded : text.toLowerCase();
};
const roman = (s: string): string => s.replace(/^CHAPTER /, "Chapter ");
const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s:])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

export class WarAndPeace {
  private x = BOOK_AT.x;
  private y = BOOK_AT.y;
  private paragraphs: string[] = [];
  private lower: string[] | null = null;
  private sections: Section[] = [];
  private entries: Entry[] = [];
  /** The section of each paragraph. */
  private sectionOf = new Uint16Array(0);
  /** Each section's top and the bottom of the last, in the book's coordinates. */
  private tops = new Float64Array(1);
  private scroll = 0;
  private size = 17;
  private matches: Match[] = [];
  private byParagraph = new Map<number, number[]>();
  private match = -1;
  private pump = 0;
  private started = 0;
  private busy = 0;
  private recorded = { lines: 0, ms: 0 };
  private readonly measurer = canvasMeasurer();
  private readonly text: VirtualGroup;
  private readonly frame: ComponentHandle<FrameState>;
  private unlisten: (() => void)[] = [];

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly host: BookHost,
  ) {
    scene.addGroup({ id: BOOK_ID, meta: { role: "figure", label: "War and Peace, by Leo Tolstoy", source: "book" } });
    this.frame = host.components().mount(this.frameSpec());
    this.text = new VirtualGroup(
      scene,
      {
        id: `${BOOK_ID}:text`,
        parent: BOOK_ID,
        meta: { role: "document", label: "War and Peace" },
        // Taller than any book: the view is clipped to what shows, and the book's height changes as it is laid out.
        extent: { x: 0, y: 0, width: COLUMN, height: 1e9 },
        draw: (ctx, window) => this.draw(ctx, window),
      },
      host.recorder ? { recorder: host.recorder } : {},
    );
    this.show();
    this.listen();
    void this.load();
  }

  get alive(): boolean {
    return this.scene.getGroup(BOOK_ID) !== undefined;
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: W, height: TITLE + BODY + STATUS };
  }

  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.text.bind(scene);
    this.listen();
  }

  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.show();
  }

  /** Fetches the text, which ships beside the page, and splits it into chapters. */
  private async load(): Promise<void> {
    const t0 = performance.now();
    const source = await (await fetch(bookUrl)).text();
    let book = -1;
    let title: string | null = null;
    for (const line of source.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("# ")) {
        book++;
        title = titleCase(line.slice(2));
        this.entries.push({ section: this.sections.length, text: title, book: true });
      } else if (line.startsWith("## ")) {
        const chapter = roman(line.slice(3));
        this.entries.push({ section: this.sections.length, text: chapter, book: false });
        this.sections.push({ book, title, chapter, first: this.paragraphs.length, count: 0, chars: 0, layout: null });
        title = null;
      } else {
        const s = this.sections[this.sections.length - 1]!;
        this.sections[this.sections.length - 1] = { ...s, count: s.count + 1, chars: s.chars + line.length };
        this.paragraphs.push(line);
      }
    }
    this.sectionOf = new Uint16Array(this.paragraphs.length);
    this.sections.forEach((s, i) => this.sectionOf.fill(i, s.first, s.first + s.count));
    const words = source.split(/\s+/).length;
    this.host.log(`war and peace: ${words.toLocaleString("en-US")} words in ${this.sections.length} chapters read in ${(performance.now() - t0).toFixed(0)} ms`);
    this.relayout();
  }

  /** Lays the book out again from scratch, the chapters in view first. */
  private relayout(): void {
    const at = this.anchor();
    for (const s of this.sections) s.layout = null;
    this.measure();
    this.scroll = this.tops[at.section]! + at.fraction * this.heightOf(at.section);
    this.started = performance.now();
    this.busy = 0;
    this.show();
    this.schedule();
  }

  private theme() {
    return {
      fontFamily: SERIF,
      fontSize: this.size,
      lineHeight: 1.6,
      color: "#1f2937",
      headingSizes: [Math.round(this.size * 1.8), this.size * 1.3, Math.round(this.size * 1.05), this.size, this.size, this.size] as [number, number, number, number, number, number],
      headingWeight: 600,
      paragraphSpacing: Math.round(this.size * 0.7),
      headingSpacingBefore: this.size * 1.4,
      headingSpacingAfter: this.size * 0.8,
    };
  }

  private blocks(s: Section): Block[] {
    const blocks: Block[] = [];
    if (s.title) blocks.push({ type: "heading", level: 1, align: "center", content: [s.title] });
    blocks.push({ type: "heading", level: 3, align: "center", content: [{ text: s.chapter, italic: true }] });
    for (let i = 0; i < s.count; i++) blocks.push({ type: "paragraph", content: [this.paragraphs[s.first + i]!] });
    return blocks;
  }

  private lay(i: number): void {
    const s = this.sections[i]!;
    if (s.layout) return;
    s.layout = layoutText({ blocks: this.blocks(s) }, { container: { x: 0, y: 0, width: COLUMN }, theme: this.theme(), measurer: this.measurer });
  }

  /** A section's height: laid out, or guessed from its length and the chapters laid out so far. */
  private heightOf(i: number): number {
    const s = this.sections[i]!;
    if (s.layout) return s.layout.bottom - s.layout.top + GAP * this.size;
    return s.chars * this.perChar + (s.title ? 5 : 3) * this.size + GAP * this.size;
  }

  private perChar = 0;

  /** Places the sections, with the height per character of those laid out for the rest. */
  private measure(): void {
    let chars = 0;
    let height = 0;
    for (const s of this.sections) {
      if (!s.layout) continue;
      chars += s.chars;
      height += s.layout.bottom - s.layout.top - (s.title ? 5 : 3) * this.size;
    }
    // About half an em a character, before anything is laid out.
    this.perChar = chars > 0 ? height / chars : (1.6 * this.size) / (COLUMN / (0.47 * this.size));
    const tops = new Float64Array(this.sections.length + 1);
    for (let i = 0; i < this.sections.length; i++) tops[i + 1] = tops[i]! + this.heightOf(i);
    this.tops = tops;
  }

  private get total(): number {
    return this.tops[this.tops.length - 1]!;
  }

  /** The section at a point of the book. */
  private sectionAt(y: number): number {
    let lo = 0;
    let hi = this.sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Where the reader is: the section at the top of the view, and how far into it. */
  private anchor(): { section: number; fraction: number } {
    if (this.sections.length === 0) return { section: 0, fraction: 0 };
    const section = this.sectionAt(this.scroll);
    return { section, fraction: (this.scroll - this.tops[section]!) / this.heightOf(section) };
  }

  /** Lays out the sections in view, keeping what the reader sees in place as heights above it change. */
  private fill(): void {
    if (this.sections.length === 0) return;
    for (let round = 0; round < 8; round++) {
      const first = this.sectionAt(this.scroll);
      const last = this.sectionAt(this.scroll + BODY);
      let laid = false;
      for (let i = first; i <= last; i++) {
        if (this.sections[i]!.layout) continue;
        const at = this.anchor();
        this.lay(i);
        this.measure();
        this.scroll = this.tops[at.section]! + at.fraction * this.heightOf(at.section);
        laid = true;
      }
      if (!laid) break;
    }
    this.scroll = Math.max(0, Math.min(this.total - BODY, this.scroll));
  }

  /** Lays out the rest of the book a slice at a time between frames. */
  private schedule(): void {
    if (this.pump) return;
    this.pump = window.setTimeout(() => {
      this.pump = 0;
      if (!this.alive) return;
      const t0 = performance.now();
      const at = this.anchor();
      const before = this.sections.findIndex((s) => !s.layout);
      if (before < 0) return;
      let i = before;
      while (i < this.sections.length && performance.now() - t0 < SLICE) {
        if (!this.sections[i]!.layout) this.lay(i);
        i++;
      }
      this.measure();
      this.scroll = this.tops[at.section]! + at.fraction * this.heightOf(at.section);
      this.busy += performance.now() - t0;
      // Chapters laid out below the view move nothing in it.
      const moved = before <= this.sectionAt(this.scroll + BODY);
      const done = this.sections.every((s) => s.layout);
      if (done) {
        const lines = this.sections.reduce((n, s) => n + s.layout!.lines.length, 0);
        this.host.log(`war and peace: laid out ${lines.toLocaleString("en-US")} lines at ${this.size}px in ${this.busy.toFixed(0)} ms, in slices over ${(performance.now() - this.started).toFixed(0)} ms`);
      }
      if (moved) this.show(true);
      else this.note();
      if (!done) this.schedule();
    }, 0);
  }

  private listen(): void {
    for (const off of this.unlisten) off();
    const text = `${BOOK_ID}:text`;
    this.unlisten = [
      this.router.on(BOOK_ID, "wheel", (e) => {
        const input = e.input as { deltaY?: number; ctrlKey?: boolean; metaKey?: boolean };
        if (input.ctrlKey || input.metaKey) return;
        e.stopPropagation();
        this.scrollTo(this.scroll + (input.deltaY ?? 0));
      }),
      // Dragging the page scrolls it, as a finger does; the board doesn't move the book.
      this.router.on(text, "down", (e) => e.stopPropagation()),
      this.router.on(text, "dragstart", (e) => e.stopPropagation()),
      this.router.on(text, "drag", (e) => {
        e.stopPropagation();
        this.scrollTo(this.scroll - e.delta!.y);
      }),
      this.router.on(BOOK_ID, "keydown", (e) => {
        const k = e.input as { key: string };
        const step: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: BODY - 60, PageUp: -(BODY - 60), " ": BODY - 60 };
        if (k.key === "Home") this.scrollTo(0);
        else if (k.key === "End") this.scrollTo(this.total);
        else if (step[k.key] !== undefined) this.scrollTo(this.scroll + step[k.key]!);
        else return;
        e.stopPropagation();
      }),
    ];
  }

  private scrollTo(y: number): void {
    const next = Math.max(0, Math.min(this.total - BODY, y));
    if (next === this.scroll) return;
    this.scroll = next;
    this.show();
  }

  /** Lays out what comes into view, places the text and draws what changed. */
  private show(redraw = false): void {
    this.fill();
    const t0 = performance.now();
    const view = {
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x + TEXT_X, f: this.y + TITLE - this.scroll },
      visible: { x: this.x + SIDE + 1, y: this.y + TITLE, width: AREA - 1, height: BODY },
      clip: true,
    };
    if (!this.text.show(view) && redraw) this.text.refresh();
    this.recorded.ms = performance.now() - t0;
    this.note();
    this.host.render();
  }

  private note(): void {
    const current = this.sections.length > 0 ? this.sectionAt(this.scroll + 1) : 0;
    const laid = this.sections.filter((s) => s.layout).length;
    const lines = this.sections.reduce((n, s) => n + (s.layout?.lines.length ?? 0), 0);
    const layout = this.sections.length === 0 ? "Loading the book" : laid < this.sections.length ? `Laying out: ${laid} of ${this.sections.length} chapters` : `${lines.toLocaleString("en-US")} lines laid out in ${this.busy.toFixed(0)} ms`;
    const search = this.matches.length > 0 ? `; match ${this.match + 1} of ${this.matches.length.toLocaleString("en-US")}` : this.frame.state.query.length > 1 ? "; no matches" : "";
    const note = `${layout}; ${this.recorded.lines} lines recorded in ${this.recorded.ms.toFixed(1)} ms${search}`;
    const s = this.frame.state;
    let contents = s.contents;
    const row = this.entries.findIndex((e) => !e.book && e.section === current);
    const rows = Math.floor(BODY / ROW);
    if (row >= 0 && current !== s.current) contents = Math.max(0, Math.min(this.entries.length - rows, row < contents + 2 || row > contents + rows - 3 ? row - Math.floor(rows / 3) : contents));
    this.frame.setState({ scroll: this.scroll, current, contents, note });
  }

  private draw(ctx: RecordingContext, window: { y: number; height: number }): void {
    let recorded = 0;
    if (this.sections.length > 0) {
      const first = this.sectionAt(window.y);
      const last = this.sectionAt(window.y + window.height);
      for (let i = first; i <= last; i++) {
        const layout = this.sections[i]!.layout;
        if (!layout) continue;
        const dy = this.tops[i]! - layout.top;
        const s = this.sections[i]!;
        const heads = s.title ? 2 : 1;
        let open = -1;
        for (const line of layout.lines) {
          const top = dy + line.top;
          if (top + line.height < window.y || top > window.y + window.height) continue;
          const block = layout.paragraphs[line.paragraph]!.block;
          if (block !== open) {
            if (open >= 0) ctx.endGroup();
            const paragraph = block >= heads ? s.first + block - heads : -1;
            ctx.beginGroup({ id: paragraph >= 0 ? `p${paragraph}` : `s${i}h${block}` });
            open = block;
          }
          if (block >= heads) this.highlight(ctx, s.first + block - heads, line, top);
          for (const f of line.fragments) {
            ctx.font = f.font;
            ctx.fillStyle = f.color;
            ctx.fillText(f.text, f.x, dy + line.baseline);
          }
          recorded++;
        }
        if (open >= 0) ctx.endGroup();
      }
    }
    this.recorded.lines = recorded;
  }

  /** Marks the search's matches on a line, the current one stronger. */
  private highlight(ctx: RecordingContext, paragraph: number, line: TextLayout["lines"][number], top: number): void {
    const starts = this.byParagraph.get(paragraph);
    if (!starts) return;
    const n = this.frame.state.query.length;
    const current = this.matches[this.match];
    for (const f of line.fragments) {
      for (const start of starts) {
        const a = Math.max(start, f.sourceStart);
        const b = Math.min(start + n, f.sourceEnd);
        if (a >= b) continue;
        const x0 = f.x + this.measurer.width(f.font, f.text.slice(0, a - f.sourceStart));
        const x1 = f.x + this.measurer.width(f.font, f.text.slice(0, b - f.sourceStart));
        ctx.fillStyle = current && current.paragraph === paragraph && current.start === start ? "#fb923c" : "#fde68a";
        ctx.fillRect(x0, top + 2, x1 - x0, line.height - 4);
      }
    }
  }

  /** Finds every match of the query in the book, case and accents aside ("natasha" finds Natásha), and goes to the first after what shows. */
  private search(query: string): void {
    this.matches = [];
    this.byParagraph = new Map();
    this.match = -1;
    const q = fold(query);
    if (q.length > 1 && this.paragraphs.length > 0) {
      const t0 = performance.now();
      this.lower ??= this.paragraphs.map(fold);
      this.lower.forEach((p, paragraph) => {
        for (let i = p.indexOf(q); i >= 0; i = p.indexOf(q, i + q.length)) {
          this.matches.push({ paragraph, start: i });
          (this.byParagraph.get(paragraph) ?? (this.byParagraph.set(paragraph, []), this.byParagraph.get(paragraph)!)).push(i);
        }
      });
      this.host.log(`war and peace: ${this.matches.length} matches of "${query}" in ${(performance.now() - t0).toFixed(1)} ms`);
      const here = this.sectionAt(this.scroll + 1);
      const next = this.matches.findIndex((m) => this.sectionOf[m.paragraph]! >= here);
      if (this.matches.length > 0) this.go(next < 0 ? 0 : next);
    }
    this.show(true);
  }

  /** Scrolls a match into view, a third of the way down. */
  private go(index: number): void {
    const m = this.matches[index];
    if (!m) return;
    this.match = index;
    const section = this.sectionOf[m.paragraph]!;
    const at = this.anchor();
    this.lay(section);
    this.measure();
    this.scroll = this.tops[at.section]! + at.fraction * this.heightOf(at.section);
    const s = this.sections[section]!;
    const layout = s.layout!;
    const block = m.paragraph - s.first + (s.title ? 2 : 1);
    const line = layout.lines.find((l) => layout.paragraphs[l.paragraph]!.block === block && l.fragments.some((f) => f.sourceEnd > m.start)) ?? layout.lines[0]!;
    this.scroll = Math.max(0, Math.min(this.total - BODY, this.tops[section]! - layout.top + line.top - BODY / 3));
    this.show(true);
  }

  private jump(section: number): void {
    this.scroll = this.tops[section]!;
    this.fill();
    this.scroll = Math.min(this.tops[section]!, this.total - BODY);
    this.show();
  }

  private resize(step: number): void {
    const i = SIZES.indexOf(this.size) + step;
    if (i < 0 || i >= SIZES.length) return;
    this.size = SIZES[i]!;
    this.relayout();
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const H = TITLE + BODY + STATUS;
    const field = { x: W - 14 - 2 * 34 - 8 - 240, y: 10, width: 240, height: 26 };
    const smaller = { x: W - 14 - 2 * 34 - 4, y: 10, width: 34, height: 26 };
    const bigger = { x: W - 14 - 34, y: 10, width: 34, height: 26 };
    const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }): boolean => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    const local = (point: { x: number; y: number }) => ({ x: point.x - this.x, y: point.y - this.y });
    const track = { x: W - GUTTER + 4, y: TITLE + 4, width: 6, height: BODY - 8 };
    const thumb = (s: FrameState): { top: number; height: number } => {
      const total = Math.max(BODY, this.total);
      const height = Math.max(28, (track.height * BODY) / total);
      return { top: track.y + ((track.height - height) * s.scroll) / Math.max(1, total - BODY), height };
    };
    let grab: number | null = null;
    return {
      id: `${BOOK_ID}:frame`,
      parent: BOOK_ID,
      state: { scroll: 0, current: 0, contents: 0, query: "", caret: 0, editing: false, note: "Loading the book" },
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y },
      cursor: () => "default",
      draw: (c, s) => {
        c.shadowColor = "rgba(15, 23, 42, 0.16)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(0, 0, W, H, 10);
        c.fillStyle = "#ffffff";
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 1;
        c.stroke();
        c.textBaseline = "middle";
        c.font = `600 15px ${FONT}`;
        c.fillStyle = "#0f172a";
        c.fillText("War and Peace, by Leo Tolstoy", 14, TITLE / 2);
        c.font = `12px ${FONT}`;
        c.fillStyle = "#64748b";
        c.fillText("translated by Louise and Aylmer Maude", 240, TITLE / 2 + 1);
        // The search field.
        c.beginPath();
        c.roundRect(field.x + 0.5, field.y + 0.5, field.width - 1, field.height - 1, 6);
        c.fillStyle = "#ffffff";
        c.fill();
        c.strokeStyle = s.editing ? "#2563eb" : "#cbd5e1";
        c.lineWidth = s.editing ? 1.5 : 1;
        c.stroke();
        c.font = `13px ${FONT}`;
        if (s.query === "" && !s.editing) {
          c.fillStyle = "#94a3b8";
          c.fillText("Search the book", field.x + 10, field.y + field.height / 2 + 0.5);
        } else {
          const before = c.measureText(s.query.slice(0, s.caret)).width;
          const shift = Math.max(0, before - (field.width - 24));
          c.save();
          c.beginPath();
          c.rect(field.x + 4, field.y, field.width - 8, field.height);
          c.clip();
          c.fillStyle = "#0f172a";
          c.fillText(s.query, field.x + 10 - shift, field.y + field.height / 2 + 0.5);
          if (s.editing) {
            c.fillStyle = "#2563eb";
            c.fillRect(field.x + 10 - shift + before, field.y + 6, 1.5, field.height - 12);
          }
          c.restore();
        }
        for (const [b, text, on] of [[smaller, "A−", this.size > SIZES[0]!], [bigger, "A+", this.size < SIZES[SIZES.length - 1]!]] as const) {
          c.beginPath();
          c.roundRect(b.x, b.y, b.width, b.height, 6);
          c.fillStyle = "#f1f5f9";
          c.fill();
          c.fillStyle = on ? "#0f172a" : "#cbd5e1";
          c.textAlign = "center";
          c.fillText(text, b.x + b.width / 2, b.y + b.height / 2);
          c.textAlign = "left";
        }
        // The contents, beside the text.
        c.fillStyle = "#f8fafc";
        c.fillRect(0.5, TITLE, SIDE, BODY);
        c.fillStyle = "#e2e8f0";
        c.fillRect(0, TITLE, W, 1);
        c.fillRect(SIDE, TITLE, 1, BODY);
        c.fillRect(0, TITLE + BODY, W, 1);
        c.save();
        c.beginPath();
        c.rect(0, TITLE + 1, SIDE, BODY - 1);
        c.clip();
        const rows = Math.ceil(BODY / ROW);
        for (let r = 0; r < rows; r++) {
          const entry = this.entries[s.contents + r];
          if (!entry) break;
          const y = TITLE + 4 + r * ROW;
          if (!entry.book && entry.section === s.current) {
            c.fillStyle = "#dbeafe";
            c.fillRect(6, y, SIDE - 12, ROW);
          }
          c.font = entry.book ? `600 12.5px ${FONT}` : `12.5px ${FONT}`;
          c.fillStyle = entry.book ? "#0f172a" : "#475569";
          c.fillText(entry.text, entry.book ? 14 : 28, y + ROW / 2 + 0.5);
        }
        c.restore();
        // Where the view is in the book.
        const t = thumb(s);
        c.fillStyle = "rgba(100, 116, 139, 0.5)";
        c.beginPath();
        c.roundRect(track.x, t.top, track.width, t.height, 3);
        c.fill();
        c.font = `12px ${FONT}`;
        c.fillStyle = "#64748b";
        c.fillText(`${s.note}. Wheel or drag to read, click a chapter to go there, Enter for the next match.`, 14, TITLE + BODY + STATUS / 2);
      },
      on: {
        wheel: (e, self) => {
          const p = local(e.point);
          if (p.x > SIDE || p.y < TITLE) return;
          e.stopPropagation();
          const rows = Math.floor(BODY / ROW);
          const dy = (e.input as { deltaY?: number }).deltaY ?? 0;
          const contents = Math.max(0, Math.min(this.entries.length - rows, self.state.contents + Math.round(dy / ROW)));
          if (contents !== self.state.contents) self.setState({ contents });
        },
        down: (e, self) => {
          const p = local(e.point);
          if (p.x < W - GUTTER || p.y < TITLE || p.y > TITLE + BODY) return;
          e.stopPropagation();
          const t = thumb(self.state);
          // A press on the thumb holds it where it was pressed; elsewhere on the track, the thumb's middle comes there.
          grab = p.y >= t.top && p.y <= t.top + t.height ? p.y - t.top : t.height / 2;
          this.scrollTo(((p.y - grab - track.y) / (track.height - t.height)) * (this.total - BODY));
        },
        dragstart: (e) => {
          if (grab !== null) e.stopPropagation();
        },
        drag: (e, self) => {
          if (grab === null) return;
          e.stopPropagation();
          const t = thumb(self.state);
          this.scrollTo(((local(e.point).y - grab - track.y) / (track.height - t.height)) * (this.total - BODY));
        },
        up: () => {
          grab = null;
        },
        click: (e, self) => {
          const p = local(e.point);
          if (inside(p, smaller) || inside(p, bigger)) {
            e.stopPropagation();
            this.resize(inside(p, smaller) ? -1 : 1);
          } else if (inside(p, field)) {
            e.stopPropagation();
            if (self.state.editing) return;
            textSink().take(self.state.query, this.host.toPage(this.x + field.x + 10, this.y + field.y + field.height), {
              onInput: (query, caret) => {
                const changed = query !== self.state.query;
                self.setState({ query, caret, editing: true });
                if (changed) this.search(query);
              },
              onKey: (k) => {
                if (k.key === "Enter") {
                  if (this.matches.length > 0) this.go((this.match + (k.shiftKey ? this.matches.length - 1 : 1)) % this.matches.length);
                  return true;
                }
                if (k.key === "Escape") {
                  textSink().release();
                  return true;
                }
                return false;
              },
              onBlur: () => self.setState({ editing: false }),
            });
          } else if (p.x < SIDE && p.y > TITLE && p.y < TITLE + BODY) {
            e.stopPropagation();
            const entry = this.entries[self.state.contents + Math.floor((p.y - TITLE - 4) / ROW)];
            if (entry) this.jump(entry.section);
          }
        },
      },
    };
  }
}
