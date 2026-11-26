// What a control does, apart from how it looks: a press that clicks, a box that checks, a value dragged along a range.
// Each takes the app's own drawing and gives back a component that handles the pointer, the keys and the accessibility
// mirror the way the stock controls do (`controls.ts`, which are these with the toolkit's look). An app with its own
// look (a round transport button, a knob, a fader) draws it, and gets the same clicks, drags, keys and screen reader
// labels as every other control on the board.
import type { ComponentHandle, ComponentSpec, ComponentUi, JsonValue, RecordingContext, RouterEvent } from "canvas-ir";

type Draw<S> = (c: RecordingContext, state: S, ui: ComponentUi) => void;
type Meta = { readonly [key: string]: JsonValue };

const keyOf = (e: RouterEvent): string => (e.input as { key?: string }).key ?? "";

/** Something that clicks: a press released on it, or Enter or Space when it has the focus. */
export const pressable = <S>(o: {
  readonly id: string;
  readonly state: S;
  readonly draw: Draw<S>;
  readonly onPress: (self: ComponentHandle<S>) => void;
  /** What a screen reader calls it. */
  readonly label: string | ((state: S) => string);
  /** Shown as pressed (as the current tool is), read from the state. */
  readonly pressed?: (state: S) => boolean;
  readonly cursor?: string;
}): ComponentSpec<S> => ({
  id: o.id,
  state: o.state,
  meta: (s): Meta => ({ role: "button", label: typeof o.label === "function" ? o.label(s) : o.label, ...(o.pressed?.(s) ? { pressed: true } : {}) }),
  cursor: o.cursor ?? "pointer",
  draw: o.draw,
  on: {
    click: (e, self) => {
      e.stopPropagation();
      o.onPress(self);
    },
    keydown: (e, self) => {
      const key = keyOf(e);
      if (key === "Enter" || key === " ") o.onPress(self);
    },
  },
});

/** Something on or off: a click or Enter or Space flips it. */
export const checkable = (o: {
  readonly id: string;
  readonly checked: boolean;
  readonly draw: Draw<{ checked: boolean }>;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  /** A checkbox (the default) or a switch, for screen readers. */
  readonly role?: "checkbox" | "switch";
  readonly cursor?: string;
}): ComponentSpec<{ checked: boolean }> => {
  const flip = (self: ComponentHandle<{ checked: boolean }>): void => {
    self.setState({ checked: !self.state.checked });
    o.onChange(self.state.checked);
  };
  return {
    id: o.id,
    state: { checked: o.checked },
    meta: (s) => ({ role: o.role ?? "checkbox", label: o.label, value: s.checked }),
    cursor: o.cursor ?? "pointer",
    draw: o.draw,
    on: {
      click: (e, self) => {
        e.stopPropagation();
        flip(self);
      },
      keydown: (e, self) => {
        const key = keyOf(e);
        if (key === " " || key === "Enter") flip(self);
      },
    },
  };
};

export interface RangeOptions {
  readonly id: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** What the value snaps to; default 1. */
  readonly step?: number;
  /** The value at the point of a press or drag: along a track, round a knob, up a fader. */
  readonly valueAt: (e: RouterEvent) => number;
  /**
   * Whether a drag moves by how far it went (a knob: press anywhere, drag to turn) rather than jumping to where it is
   * (a slider). With `relative`, `valueAt` still gives the value at each point, and the drag adds the change.
   */
  readonly relative?: boolean;
  readonly draw: Draw<{ value: number }>;
  readonly onChange: (value: number) => void;
  readonly label: string;
  /** How much Page Up and Page Down move; default ten steps. */
  readonly page?: number;
  readonly cursor?: string;
}

/**
 * A value in a range: a press sets it (or, `relative`, starts a drag), a drag moves it, the arrows step it, Page Up and
 * Down move it further, Home and End go to the ends.
 */
export const ranged = (o: RangeOptions): ComponentSpec<{ value: number }> => {
  const step = o.step ?? 1;
  const page = o.page ?? step * 10;
  const set = (self: ComponentHandle<{ value: number }>, v: number): void => {
    const value = Math.min(o.max, Math.max(o.min, Math.round((v - o.min) / step) * step + o.min));
    if (value === self.state.value) return;
    self.setState({ value });
    o.onChange(value);
  };
  // Where a relative drag began: the value then, and the value at the point it began.
  let from: { value: number; at: number } | null = null;
  return {
    id: o.id,
    state: { value: o.value },
    meta: (s) => ({ role: "slider", label: o.label, value: s.value }),
    cursor: o.cursor ?? "pointer",
    draw: o.draw,
    on: {
      down: (e, self) => {
        e.stopPropagation();
        if (o.relative) from = { value: self.state.value, at: o.valueAt(e) };
        else set(self, o.valueAt(e));
      },
      dragstart: (e) => e.stopPropagation(),
      drag: (e, self) => {
        e.stopPropagation();
        if (o.relative && from) set(self, from.value + o.valueAt(e) - from.at);
        else set(self, o.valueAt(e));
      },
      up: () => {
        from = null;
      },
      keydown: (e, self) => {
        const key = keyOf(e);
        const v = self.state.value;
        if (key === "ArrowRight" || key === "ArrowUp") set(self, v + step);
        else if (key === "ArrowLeft" || key === "ArrowDown") set(self, v - step);
        else if (key === "PageUp") set(self, v + page);
        else if (key === "PageDown") set(self, v - page);
        else if (key === "Home") set(self, o.min);
        else if (key === "End") set(self, o.max);
      },
    },
  };
};
