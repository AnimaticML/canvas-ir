// A card of controls described as a list: headings, rows of buttons that wrap, swatches, sliders, toggles, text boxes
// and fields. The panel lays them out down the card and keeps them showing the host's values: each control reads its
// value through a function, and `refresh` sets what changed. A toolbar and an inspector are panels.
import type { ComponentSpec } from "canvas-ir";
import type { Card, CardLayer } from "./cards";
import { type Box, type ButtonLook, type TextBoxState, button, buttonWidth, section, slider, swatches, textBox, textField, toggle } from "./controls";

export interface PanelButton {
  readonly id: string;
  readonly text: string;
  readonly onClick: () => void;
  readonly look?: ButtonLook;
  readonly title?: string;
  /** Whether it shows as on, as the current tool does; read on refresh. */
  readonly active?: () => boolean;
}

export type PanelItem =
  /** A heading, with a hint under it. */
  | { readonly kind: "section"; readonly id: string; readonly title: string; readonly hint?: string }
  /** Buttons left to right, wrapping onto as many rows as they need. */
  | { readonly kind: "buttons"; readonly buttons: readonly PanelButton[] }
  /** One button as wide as the panel; its text is read on refresh. */
  | { readonly kind: "button"; readonly id: string; readonly text: () => string; readonly onClick: () => void; readonly look?: ButtonLook }
  | { readonly kind: "swatches"; readonly id: string; readonly text: string; readonly colors: readonly string[]; readonly value: () => string; readonly onChange: (color: string) => void }
  | {
      readonly kind: "slider";
      readonly id: string;
      readonly text: string;
      readonly min: number;
      readonly max: number;
      readonly step?: number;
      readonly value: () => number;
      readonly format?: (v: number) => string;
      readonly onChange: (v: number) => void;
    }
  | { readonly kind: "toggle"; readonly id: string; readonly text: string; readonly checked: () => boolean; readonly onChange: (checked: boolean) => void }
  /** A box of text, scrolled when longer than it; its text is read on refresh. */
  | {
      readonly kind: "text";
      readonly id: string;
      readonly label: string;
      readonly height: number;
      readonly text: () => string;
      readonly mono?: boolean;
      readonly onRow?: (row: number) => void;
      readonly picked?: () => number;
    }
  | { readonly kind: "field"; readonly id: string; readonly placeholder: string; readonly value: () => string; readonly onChange: (value: string) => void }
  /** Anything else, given its place. */
  | { readonly kind: "custom"; readonly height: number; readonly spec: (box: Box) => ComponentSpec<unknown> }
  /** Space between groups of controls. */
  | { readonly kind: "gap" };

export interface PanelOptions {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** How tall the content shows; taller content scrolls. Omitted, the panel is as tall as its content. */
  readonly height?: number;
  /** The controls, read each time the panel is built, so they can depend on the host's state. */
  readonly items: () => readonly PanelItem[];
  readonly onMove?: (x: number, y: number) => void;
}

const PAD = 14;
const H = 28;
const GAP = 6;

export class Panel {
  readonly card: Card;
  private items: readonly PanelItem[] = [];

  constructor(layer: CardLayer, private readonly options: PanelOptions) {
    this.card = layer.card({
      id: options.id,
      title: options.title,
      x: options.x,
      y: options.y,
      width: options.width,
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.onMove ? { onMove: options.onMove } : {}),
      build: (card, width) => this.build(card, width),
    });
  }

  /** Builds the panel again, as when its list of controls changed. */
  rebuild(): void {
    this.card.rebuild();
  }

  /** Sets what each control shows from the host's values, or only one control's. */
  refresh(id?: string): void {
    for (const item of this.items) {
      if (item.kind === "buttons") {
        for (const b of item.buttons) if (b.active && (id === undefined || id === b.id)) this.card.get<{ active: boolean }>(b.id)?.setState({ active: b.active() });
        continue;
      }
      if (!("id" in item) || (id !== undefined && id !== item.id)) continue;
      const handle = this.card.get<Record<string, unknown>>(item.id);
      if (!handle) continue;
      if (item.kind === "text") handle.setState({ text: item.text() });
      else if (item.kind === "button") handle.setState({ text: item.text() });
      else if (item.kind === "swatches") handle.setState({ value: item.value() });
      else if (item.kind === "slider") handle.setState({ value: item.value() });
      else if (item.kind === "toggle") handle.setState({ checked: item.checked() });
      else if (item.kind === "field" && !(handle.state as { editing?: boolean }).editing) handle.setState({ value: item.value() });
    }
  }

  /** Shows new text in a text box, keeping its scroll. */
  setText(id: string, text: string): void {
    this.card.get<TextBoxState>(id)?.setState({ text });
  }

  private build(p: Card, width: number): number {
    this.items = this.options.items();
    const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
    const w = width - PAD * 2;
    let y = PAD;
    let first = true;
    const row = (h: number): Box => {
      const b = { x: PAD, y, w, h };
      y += h + 4;
      return b;
    };
    for (const item of this.items) {
      switch (item.kind) {
        case "section": {
          if (!first) y += 10;
          const s = section(p, item.id, PAD, y, w, item.title, item.hint);
          p.mount(s.spec);
          y += s.height + 8;
          break;
        }
        case "buttons": {
          let x = PAD;
          for (const b of item.buttons) {
            const bw = Math.min(w, buttonWidth(measure, b.text));
            if (x + bw > width - PAD && x > PAD) {
              x = PAD;
              y += H + GAP;
            }
            p.mount(
              button({
                id: b.id,
                panel: p,
                box: { x, y, w: bw, h: H },
                text: b.text,
                onClick: b.onClick,
                active: b.active?.() ?? false,
                ...(b.look ? { look: b.look } : {}),
                ...(b.title ? { title: b.title } : {}),
              }),
            );
            x += bw + GAP;
          }
          y += H + 8;
          break;
        }
        case "button":
          p.mount(button({ id: item.id, panel: p, box: row(H), text: item.text(), onClick: item.onClick, ...(item.look ? { look: item.look } : {}) }));
          break;
        case "swatches":
          p.mount(swatches({ id: item.id, panel: p, box: row(26), text: item.text, colors: item.colors, value: item.value(), onChange: item.onChange }));
          break;
        case "slider":
          p.mount(
            slider({
              id: item.id,
              panel: p,
              box: row(26),
              text: item.text,
              min: item.min,
              max: item.max,
              value: item.value(),
              onChange: item.onChange,
              ...(item.step !== undefined ? { step: item.step } : {}),
              ...(item.format ? { format: item.format } : {}),
            }),
          );
          break;
        case "toggle":
          p.mount(toggle({ id: item.id, panel: p, box: row(26), text: item.text, checked: item.checked(), onChange: item.onChange }));
          break;
        case "text": {
          const box = { x: PAD, y, w, h: item.height };
          y += item.height + 8;
          p.mount(
            textBox({
              id: item.id,
              panel: p,
              box,
              text: item.text(),
              label: item.label,
              mono: item.mono ?? true,
              ...(item.onRow ? { onRow: item.onRow } : {}),
              ...(item.picked ? { picked: item.picked } : {}),
            }),
          );
          break;
        }
        case "field": {
          p.mount(textField({ id: item.id, panel: p, box: row(H), placeholder: item.placeholder, onChange: item.onChange }));
          const value = item.value();
          if (value) p.get<{ value: string }>(item.id)?.setState({ value });
          break;
        }
        case "custom":
          p.mount(item.spec(row(item.height)));
          break;
        case "gap":
          y += 14;
          break;
      }
      first = false;
    }
    return y + PAD - 4;
  }
}
