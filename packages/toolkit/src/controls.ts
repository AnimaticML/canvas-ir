// A small widget kit drawn with canvas-ir: every button, toggle, slider,
// swatch row, text box and text field is a component drawn from its state,
// mounted on a surface (a card on the board). The only DOM is one hidden
// textarea that takes keyboard and IME input for whichever text field has
// focus; what is typed is drawn on canvas.
import { type ComponentHandle, type ComponentSpec, type JsonValue, type RecordingContext, type RouterEvent } from "canvas-ir";

/** The page's colors, read from its CSS custom properties so the chrome follows light and dark. */
export interface Palette {
  readonly bg: string;
  readonly panel: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly hover: string;
}

export const palette = (): Palette => {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--bg", "#f6f6f4"),
    panel: v("--panel", "#ffffff"),
    text: v("--text", "#1d1d1b"),
    muted: v("--muted", "#6b6b66"),
    border: v("--border", "#dcdcd6"),
    accent: v("--accent", "#2563eb"),
    hover: v("--hover", "#f59e0b"),
  };
};

export const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Breaks text into lines that fit `width` at the context's current font; existing line breaks are kept. */
export const wrap = (c: RecordingContext, text: string, width: number): string[] => {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && c.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
};

/** Cuts a line to fit `width`, ending it with an ellipsis. */
export const fit = (c: RecordingContext, text: string, width: number): string => {
  if (c.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (c.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
};

/**
 * The hidden textarea that takes typing for the focused text field, so IME,
 * paste, mobile keyboards and selection all work; the field draws its value
 * and caret from it.
 */
class TextSink {
  readonly element: HTMLTextAreaElement;
  private owner: { onInput: (value: string, caret: number) => void; onKey: (e: KeyboardEvent) => boolean; onBlur: () => void } | null = null;

  constructor() {
    const t = document.createElement("textarea");
    t.setAttribute("aria-hidden", "true");
    t.tabIndex = -1;
    t.autocapitalize = "off";
    t.spellcheck = false;
    Object.assign(t.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", resize: "none" });
    document.body.append(t);
    t.addEventListener("input", () => this.owner?.onInput(t.value, t.selectionEnd));
    t.addEventListener("select", () => this.owner?.onInput(t.value, t.selectionEnd));
    t.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (this.owner?.onKey(e)) e.preventDefault();
      // Arrows move the caret after this event.
      requestAnimationFrame(() => this.owner?.onInput(t.value, t.selectionEnd));
    });
    t.addEventListener("blur", () => {
      const owner = this.owner;
      this.owner = null;
      owner?.onBlur();
    });
    this.element = t;
  }

  /** Whether a text field has the keyboard. */
  get active(): boolean {
    return this.owner !== null;
  }

  /** Gives the keyboard to a field, placing the textarea at `at` (page pixels) so an IME's window opens there. */
  take(value: string, at: { x: number; y: number }, owner: NonNullable<TextSink["owner"]>): void {
    const previous = this.owner;
    this.owner = null;
    previous?.onBlur();
    this.element.value = value;
    this.element.style.left = `${at.x}px`;
    this.element.style.top = `${at.y}px`;
    this.owner = owner;
    this.element.focus({ preventScroll: true });
    this.element.setSelectionRange(value.length, value.length);
    owner.onInput(value, value.length);
  }

  release(): void {
    if (this.owner) this.element.blur();
  }
}

let sink: TextSink | null = null;
export const textSink = (): TextSink => (sink ??= new TextSink());

/**
 * Where widgets live: a card on the board, or anything else that mounts
 * components and can say where its content is. Widgets draw in the surface's
 * content coordinates.
 */
export interface Surface {
  readonly colors: Palette;
  /** Mounts a widget; ids are unique within the surface. */
  mount<S>(spec: ComponentSpec<S>): ComponentHandle<S>;
  get<S>(id: string): ComponentHandle<S> | undefined;
  /** Clears the surface and builds its widgets again. */
  rebuild(): void;
  /** Where an event happened, in content coordinates. */
  local(e: RouterEvent): { x: number; y: number };
  /** Where a point in the content is on the page, for the text sink. */
  toPage(x: number, y: number): { x: number; y: number };
}

/** A widget's place on its surface. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const hitArea = (c: RecordingContext, b: Box, fill: string): void => {
  c.fillStyle = fill;
  c.fillRect(b.x, b.y, b.w, b.h);
};

/** Static drawing: a heading, a hint, a rule. It takes no events. */
export const label = (id: string, draw: (c: RecordingContext) => void): ComponentSpec<null> => ({ id, state: null, draw: (c) => draw(c) });

export type ButtonLook = "plain" | "primary" | "accent";

/** Measures a button's width for its label. */
export const buttonWidth = (c: { font: string; measureText(text: string): { width: number } }, text: string): number => {
  c.font = `13px ${FONT}`;
  return Math.ceil(c.measureText(text).width) + 22;
};

export const button = (o: {
  id: string;
  panel: Surface;
  box: Box;
  text: string;
  onClick: () => void;
  look?: ButtonLook;
  /** Whether it shows as on, as the current tool does. */
  active?: boolean;
  title?: string;
}): ComponentSpec<{ active: boolean; text: string }> => ({
  id: o.id,
  state: { active: o.active ?? false, text: o.text },
  meta: (s) => ({ role: "button", label: o.title ? `${s.text}: ${o.title}` : s.text, ...(s.active ? { pressed: true } : {}) }),
  cursor: "pointer",
  draw: (c, s, ui) => {
    const k = o.panel.colors;
    const { x, y, w, h } = o.box;
    hitArea(c, o.box, k.panel);
    const filled = s.active || o.look === "primary" || o.look === "accent";
    const base = o.look === "accent" ? "#f97316" : k.accent;
    c.beginPath();
    c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
    if (filled) {
      c.fillStyle = ui.pressed ? k.text : ui.hovered && o.look === "accent" ? "#ea580c" : base;
      c.fill();
      if (ui.hovered && o.look !== "accent") {
        c.globalAlpha = 0.15;
        c.fillStyle = "#ffffff";
        c.fill();
        c.globalAlpha = 1;
      }
    } else {
      if (ui.pressed) {
        c.fillStyle = k.border;
        c.fill();
      }
      c.strokeStyle = ui.hovered || ui.focused ? k.accent : k.border;
      c.lineWidth = 1;
      c.stroke();
    }
    c.font = `${o.look === "accent" ? "600 " : ""}13px ${FONT}`;
    c.fillStyle = filled ? "#ffffff" : k.text;
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.fillText(s.text, x + w / 2, y + h / 2 + 0.5);
    c.textAlign = "start";
  },
  on: {
    click: (e) => {
      e.stopPropagation();
      o.onClick();
    },
    keydown: (e) => {
      const key = (e.input as { key: string }).key;
      if (key === "Enter" || key === " ") o.onClick();
    },
  },
});

/** A checkbox with its label. */
export const toggle = (o: { id: string; panel: Surface; box: Box; text: string; checked: boolean; onChange: (checked: boolean) => void }): ComponentSpec<{ checked: boolean }> => ({
  id: o.id,
  state: { checked: o.checked },
  meta: (s) => ({ role: "checkbox", label: o.text, value: s.checked }),
  cursor: "pointer",
  draw: (c, s, ui) => {
    const k = o.panel.colors;
    const { x, y, h } = o.box;
    hitArea(c, o.box, k.panel);
    const m = y + h / 2;
    c.beginPath();
    c.roundRect(x + 0.5, m - 7.5, 15, 15, 3);
    c.fillStyle = s.checked ? k.accent : k.panel;
    c.fill();
    c.strokeStyle = s.checked ? k.accent : ui.hovered ? k.accent : k.muted;
    c.lineWidth = 1;
    c.stroke();
    if (s.checked) {
      c.strokeStyle = "#ffffff";
      c.lineWidth = 2;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      c.moveTo(x + 4, m);
      c.lineTo(x + 7, m + 3.5);
      c.lineTo(x + 12, m - 3.5);
      c.stroke();
    }
    c.font = `13px ${FONT}`;
    c.fillStyle = k.text;
    c.textBaseline = "middle";
    c.fillText(o.text, x + 23, m + 0.5);
  },
  on: {
    click: (e, self) => {
      e.stopPropagation();
      self.setState({ checked: !self.state.checked });
      o.onChange(self.state.checked);
    },
    keydown: (e, self) => {
      const key = (e.input as { key: string }).key;
      if (key !== " " && key !== "Enter") return;
      self.setState({ checked: !self.state.checked });
      o.onChange(self.state.checked);
    },
  },
});

/** A slider with a label and its value; drag, click or use arrow keys. */
export const slider = (o: {
  id: string;
  panel: Surface;
  box: Box;
  text?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}): ComponentSpec<{ value: number }> => {
  const labelWidth = o.text ? 64 : 0;
  const valueWidth = o.format ? 44 : 0;
  const track = { x0: o.box.x + labelWidth + 8, x1: o.box.x + o.box.w - valueWidth - 8 };
  const step = o.step ?? 1;
  const set = (self: ComponentHandle<{ value: number }>, v: number): void => {
    const value = Math.min(o.max, Math.max(o.min, Math.round(v / step) * step));
    if (value === self.state.value) return;
    self.setState({ value });
    o.onChange(value);
  };
  const at = (x: number): number => o.min + ((x - track.x0) / (track.x1 - track.x0)) * (o.max - o.min);
  return {
    id: o.id,
    state: { value: o.value },
    meta: (s) => ({ role: "slider", label: o.text ?? o.id, value: s.value }),
    cursor: "pointer",
    draw: (c, s, ui) => {
      const k = o.panel.colors;
      const m = o.box.y + o.box.h / 2;
      hitArea(c, o.box, k.panel);
      c.font = `13px ${FONT}`;
      c.textBaseline = "middle";
      c.fillStyle = k.text;
      if (o.text) c.fillText(o.text, o.box.x, m + 0.5);
      const t = (s.value - o.min) / (o.max - o.min);
      const kx = track.x0 + t * (track.x1 - track.x0);
      c.lineCap = "round";
      c.lineWidth = 4;
      c.strokeStyle = k.border;
      c.beginPath();
      c.moveTo(track.x0, m);
      c.lineTo(track.x1, m);
      c.stroke();
      c.strokeStyle = k.accent;
      c.beginPath();
      c.moveTo(track.x0, m);
      c.lineTo(kx, m);
      c.stroke();
      c.beginPath();
      c.arc(kx, m, ui.pressed || ui.hovered ? 8 : 7, 0, Math.PI * 2);
      c.fillStyle = k.panel;
      c.fill();
      c.lineWidth = ui.focused ? 2.5 : 1.5;
      c.strokeStyle = k.accent;
      c.stroke();
      if (o.format) {
        c.fillStyle = k.muted;
        c.textAlign = "right";
        c.fillText(o.format(s.value), o.box.x + o.box.w, m + 0.5);
        c.textAlign = "start";
      }
    },
    on: {
      down: (e, self) => {
        e.stopPropagation();
        set(self, at(o.panel.local(e).x));
      },
      dragstart: (e) => e.stopPropagation(),
      drag: (e, self) => {
        e.stopPropagation();
        set(self, at(o.panel.local(e).x));
      },
      keydown: (e, self) => {
        const key = (e.input as { key: string }).key;
        if (key === "ArrowRight" || key === "ArrowUp") set(self, self.state.value + step);
        if (key === "ArrowLeft" || key === "ArrowDown") set(self, self.state.value - step);
      },
    },
  };
};

/** A row of color swatches to pick from. */
export const swatches = (o: { id: string; panel: Surface; box: Box; text: string; colors: readonly string[]; value: string; onChange: (color: string) => void }): ComponentSpec<{ value: string }> => {
  const size = 18;
  const gap = 5;
  const x0 = o.box.x + 64;
  const cell = (i: number) => ({ x: x0 + i * (size + gap), y: o.box.y + (o.box.h - size) / 2 });
  return {
    id: o.id,
    state: { value: o.value },
    meta: (s) => ({ role: "radiogroup", label: o.text, value: s.value }),
    cursor: "pointer",
    draw: (c, s) => {
      const k = o.panel.colors;
      hitArea(c, o.box, k.panel);
      c.font = `13px ${FONT}`;
      c.textBaseline = "middle";
      c.fillStyle = k.text;
      c.fillText(o.text, o.box.x, o.box.y + o.box.h / 2 + 0.5);
      o.colors.forEach((color, i) => {
        const p = cell(i);
        c.beginPath();
        c.roundRect(p.x, p.y, size, size, 4);
        c.fillStyle = color;
        c.fill();
        c.lineWidth = color === s.value ? 2 : 1;
        c.strokeStyle = color === s.value ? k.accent : k.border;
        if (color === s.value) {
          c.beginPath();
          c.roundRect(p.x - 2.5, p.y - 2.5, size + 5, size + 5, 6);
        }
        c.stroke();
      });
    },
    on: {
      click: (e, self) => {
        e.stopPropagation();
        const { x } = o.panel.local(e);
        const i = o.colors.findIndex((_, i) => {
          const p = cell(i);
          return x >= p.x - gap / 2 && x < p.x + size + gap / 2;
        });
        if (i < 0) return;
        self.setState({ value: o.colors[i]! });
        o.onChange(o.colors[i]!);
      },
    },
  };
};

export interface TextBoxState {
  readonly text: string;
  readonly scroll: number;
}

/** Monospaced or plain text in a box, cut to its width, scrolled by the wheel when longer than it. */
export const textBox = (o: {
  id: string;
  panel: Surface;
  box: Box;
  text: string;
  /** What screen readers call it. */
  label: string;
  mono?: boolean;
  /** Rows that can be clicked: called with the row's index. */
  onRow?: (row: number) => void;
  /** Which row shows as picked. */
  picked?: () => number;
}): ComponentSpec<TextBoxState> => {
  const LINE = o.mono ? 16 : 18;
  const rows = Math.max(1, Math.floor((o.box.h - 12) / LINE));
  return {
    id: o.id,
    state: { text: o.text, scroll: 0 },
    // A fixed label: a box showing the accessibility tree would otherwise change the tree it shows.
    meta: { role: "log", label: o.label },
    ...(o.onRow ? { cursor: "pointer" } : {}),
    draw: (c, s) => {
      const k = o.panel.colors;
      const { x, y, w, h } = o.box;
      c.beginPath();
      c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
      c.fillStyle = k.bg;
      c.fill();
      c.strokeStyle = k.border;
      c.lineWidth = 1;
      c.stroke();
      const lines = s.text.split("\n");
      c.font = o.mono ? `11.5px ${MONO}` : `13px ${FONT}`;
      c.textBaseline = "middle";
      const picked = o.picked?.() ?? -1;
      for (let i = 0; i < rows; i++) {
        const n = s.scroll + i;
        const line = lines[n];
        if (line === undefined) break;
        const ly = y + 6 + i * LINE;
        if (n === picked) {
          c.fillStyle = k.accent;
          c.globalAlpha = 0.15;
          c.fillRect(x + 2, ly, w - 4, LINE);
          c.globalAlpha = 1;
        }
        c.fillStyle = k.text;
        c.fillText(fit(c, line, w - 18), x + 8, ly + LINE / 2 + 0.5);
      }
      if (lines.length > rows) {
        // Where the visible rows are in the whole.
        const bar = Math.max(16, ((h - 8) * rows) / lines.length);
        const top = y + 4 + ((h - 8 - bar) * s.scroll) / Math.max(1, lines.length - rows);
        c.fillStyle = k.muted;
        c.globalAlpha = 0.5;
        c.beginPath();
        c.roundRect(x + w - 6, top, 3, bar, 1.5);
        c.fill();
        c.globalAlpha = 1;
      }
    },
    on: {
      wheel: (e, self) => {
        const lines = self.state.text.split("\n").length;
        if (lines <= rows) return;
        e.stopPropagation();
        const dy = (e.input as { deltaY?: number }).deltaY ?? 0;
        const scroll = Math.max(0, Math.min(lines - rows, self.state.scroll + Math.sign(dy) * Math.max(1, Math.round(Math.abs(dy) / LINE))));
        if (scroll !== self.state.scroll) self.setState({ scroll });
      },
      click: (e, self) => {
        if (!o.onRow) return;
        e.stopPropagation();
        const row = Math.floor((o.panel.local(e).y - o.box.y - 6) / LINE);
        if (row >= 0 && row < rows) o.onRow(self.state.scroll + row);
      },
    },
  };
};

/** A one-line text field; typing goes through the hidden textarea and is drawn here, with its caret. */
export const textField = (o: {
  id: string;
  panel: Surface;
  box: Box;
  placeholder: string;
  onChange: (value: string) => void;
  onEnter?: (value: string) => void;
}): ComponentSpec<{ value: string; caret: number; editing: boolean }> => ({
  id: o.id,
  state: { value: "", caret: 0, editing: false },
  meta: (s) => ({ role: "textbox", label: o.placeholder, value: s.value }),
  cursor: "text",
  draw: (c, s, ui) => {
    const k = o.panel.colors;
    const { x, y, w, h } = o.box;
    c.beginPath();
    c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
    c.fillStyle = k.panel;
    c.fill();
    c.strokeStyle = s.editing ? k.accent : ui.hovered ? k.muted : k.border;
    c.lineWidth = s.editing ? 1.5 : 1;
    c.stroke();
    c.font = `13px ${FONT}`;
    c.textBaseline = "middle";
    const m = y + h / 2 + 0.5;
    if (s.value === "" && !s.editing) {
      c.fillStyle = k.muted;
      c.fillText(o.placeholder, x + 8, m);
      return;
    }
    // Keep the caret in view: shift the text left when it runs past the box.
    const before = c.measureText(s.value.slice(0, s.caret)).width;
    const shift = Math.max(0, before - (w - 20));
    c.save();
    c.beginPath();
    c.rect(x + 4, y, w - 8, h);
    c.clip();
    c.fillStyle = k.text;
    c.fillText(s.value, x + 8 - shift, m);
    if (s.editing) {
      c.fillStyle = k.accent;
      c.fillRect(x + 8 - shift + before, y + 6, 1.5, h - 12);
    }
    c.restore();
  },
  on: {
    click: (e, self) => {
      e.stopPropagation();
      if (self.state.editing) return;
      textSink().take(self.state.value, o.panel.toPage(o.box.x + 8, o.box.y + o.box.h), {
        onInput: (value, caret) => {
          const changed = value !== self.state.value;
          self.setState({ value, caret, editing: true });
          if (changed) o.onChange(value);
        },
        onKey: (k) => {
          if (k.key === "Enter") {
            o.onEnter?.(self.state.value);
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
    },
  },
});

/** A section heading with an optional hint wrapped under it; returns the height it takes. */
export const section = (panel: Surface, id: string, x: number, y: number, w: number, title: string, hint?: string): { spec: ComponentSpec<null>; height: number } => {
  // Measure the hint on a throwaway canvas: the label draws with the same font.
  const m = new OffscreenCanvas(1, 1).getContext("2d")!;
  m.font = `12px ${FONT}`;
  const lines = hint ? wrapMeasured(m, hint, w) : [];
  const height = 24 + lines.length * 17;
  return {
    height,
    spec: label(id, (c) => {
      const k = panel.colors;
      c.font = `600 11.5px ${FONT}`;
      c.fillStyle = k.muted;
      c.textBaseline = "top";
      c.fillText(title.toUpperCase(), x, y + 2);
      c.font = `12px ${FONT}`;
      lines.forEach((line, i) => c.fillText(line, x, y + 24 + i * 17));
    }),
  };
};

const wrapMeasured = (c: OffscreenCanvasRenderingContext2D, text: string, width: number): string[] => {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && c.measureText(next).width > width) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
};

export type { JsonValue };
