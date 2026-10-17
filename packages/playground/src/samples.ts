import { type LiveTextOptions, type RichText, type TextRun, drawTextLayout, layoutText } from "@canvas-ir/text";
import { type ComponentHandle, type ComponentSpec, type RecordingContext, applyToPoint, invert } from "canvas-ir";

/**
 * Text the playground lays out again whenever an obstacle moves. Its block group
 * `id` goes inside the group `parent`, which also holds the container's outline,
 * so dragging the parent moves the container too.
 */
export type LiveSpec = LiveTextOptions & { readonly parent: string };

/** What the controls sample changes on the board. */
export interface ControlHooks {
  setMargin(px: number): void;
  setSize(px: number): void;
  openLink(href: string): void;
  get<S>(id: string): ComponentHandle<S> | undefined;
}

/** What a drawn sample leaves to the board: text to keep laid out, and components to mount. */
export interface Drawn {
  readonly live?: readonly LiveSpec[];
  // biome-ignore lint: components of any state
  readonly components?: readonly ComponentSpec<any>[];
}

/** Something to put on the board: SVG markup drawn through canvg, or a function drawing on the recorder. */
export type Sample =
  | { readonly name: string; readonly svg: string; readonly at: { x: number; y: number } }
  | { readonly name: string; readonly draw: (ctx: RecordingContext, hooks: ControlHooks) => Drawn | void };

let nextId = 0;
const unique = (name: string): string => `${name}-${nextId++}`;

const circleRing = (cx: number, cy: number, r: number) =>
  Array.from({ length: 128 }, (_, i) => ({ x: cx + r * Math.cos((i / 128) * 2 * Math.PI), y: cy + r * Math.sin((i / 128) * 2 * Math.PI) }));

const prose =
  "Text here flows around the purple shape and the orange sticker, which is an image: lines follow its opaque pixels, not its box. Drag either one and every line is laid out again. Drag the column by its text or its dashed outline, and the text moves with it.";

/**
 * A sticker drawn on a canvas and placed as an image: an orange blob with a star
 * cut out of it. Its transparent parts, the star included, aren't part of it.
 */
const sticker = (): OffscreenCanvas => {
  const canvas = new OffscreenCanvas(180, 140);
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#fb923c";
  c.beginPath();
  for (const [x, y, r] of [[62, 72, 50], [112, 58, 46], [120, 98, 34]] as const) {
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, Math.PI * 2);
  }
  c.fill();
  c.globalCompositeOperation = "destination-out";
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 24 : 10;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    c.lineTo(92 + r * Math.cos(a), 72 + r * Math.sin(a));
  }
  c.fill();
  c.globalCompositeOperation = "source-over";
  c.fillStyle = "#7c2d12";
  c.font = "bold 18px sans-serif";
  c.fillText("PNG", 32, 80);
  return canvas;
};

const wrap: Sample = {
  name: "Text around shapes",
  draw: (ctx) => {
    const column = ctx.beginGroup({ meta: { source: "text column" } });
    ctx.strokeStyle = "#a1a1aa";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(30.5, 250.5, 290, 300);
    ctx.endGroup();
    const shape = ctx.beginGroup({ meta: { source: "obstacle" } });
    ctx.fillStyle = "#a78bfa";
    ctx.beginPath();
    ctx.ellipse(160, 370, 52, 40, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.endGroup();
    const image = ctx.beginGroup({ meta: { source: "sticker image" } });
    ctx.save();
    ctx.translate(196, 448);
    ctx.rotate(-0.25);
    ctx.drawImage(sticker() as unknown as CanvasImageSource, 0, 0, 110, 85);
    ctx.restore();
    ctx.endGroup();
    return {
      live: [
      {
        id: `${column}-text`,
        parent: column,
        text: { blocks: [{ type: "heading", level: 4, content: ["Wrapping around"] }, { type: "paragraph", content: [prose] }] },
        theme: { fontSize: 14 },
        container: { x: 40, y: 258, width: 272, height: 286 },
        obstacles: [shape, image],
        obstacleMargin: 8,
      },
      ],
    };
  },
};

const circle: Sample = {
  name: "Text in a circle",
  draw: (ctx) => {
    const group = ctx.beginGroup({ meta: { source: "text in a circle" } });
    ctx.fillStyle = "#e0f2fe";
    ctx.beginPath();
    ctx.arc(700, 380, 110, 0, Math.PI * 2);
    ctx.fill();
    ctx.endGroup();
    return {
      live: [
      {
        id: `${group}-text`,
        parent: group,
        text: {
          blocks: [
            {
              type: "paragraph",
              align: "center",
              content: ["The container is any path: here a circle. Each line gets the part of its band that is inside the circle for the line's whole height, so nothing pokes out at the curve."],
            },
          ],
        },
        theme: { fontSize: 14 },
        container: { rings: [circleRing(700, 380, 100)] },
        obstacles: [],
      },
      ],
    };
  },
};

const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#059669"/></linearGradient></defs>
  <circle cx="60" cy="60" r="52" fill="url(#g)"/>
  <path d="M36 62 L52 78 L86 42" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150" viewBox="0 0 220 150">
  <rect x="0.5" y="0.5" width="219" height="149" rx="8" fill="#fff" stroke="#d4d4d8"/>
  <g fill="#6366f1"><rect x="24" y="80" width="26" height="50"/><rect x="62" y="50" width="26" height="80"/><rect x="100" y="66" width="26" height="64"/><rect x="138" y="30" width="26" height="100"/><rect x="176" y="96" width="26" height="34"/></g>
  <path d="M20 130 H204" stroke="#71717a" stroke-width="2"/>
  <text x="20" y="22" font-family="sans-serif" font-size="13" fill="#27272a">Weekly orders</text>
</svg>`;

const star = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="110" viewBox="0 0 110 110">
  <polygon points="55,6 68,40 104,42 76,64 86,100 55,80 24,100 34,64 6,42 42,40" fill="#fbbf24" stroke="#b45309" stroke-width="4" stroke-linejoin="round"/>
</svg>`;

const noteText: RichText = {
  blocks: [
    { type: "heading", level: 3, content: ["Rich text, recorded"] },
    {
      type: "paragraph",
      content: ["Laid out by ", { text: "@canvas-ir/text", code: true }, " and drawn as ", { text: "fillText", bold: true }, " calls. Each line is a group you can hit."],
    },
    { type: "list", items: [[{ type: "paragraph", content: ["Wraps like the DOM"] }], [{ type: "paragraph", content: ["Works in any shape"] }]] },
    {
      type: "paragraph",
      content: [
        "Runs can be ",
        { text: "underlined", underline: true },
        ", ",
        { text: "struck out", strikethrough: true },
        ", ",
        { text: "overlined", overline: true },
        " or ",
        { text: "links you can click", href: "https://github.com/AnimaticML/canvas-ir" },
        ".",
      ],
    },
  ],
};

/** The link a component's pointer is over, from the text-run group it hovers. */
const hoveredHref = (parts: readonly { meta?: { readonly [key: string]: unknown } }[]): string | null => {
  const href = parts.find((g) => typeof g.meta?.href === "string")?.meta?.href;
  return typeof href === "string" ? href : null;
};

/** The note is a component: hovering a link draws it again with that link highlighted. */
const note: Sample = {
  name: "Text block",
  draw: (_ctx, hooks) => ({
    components: [
      {
        id: unique("note"),
        state: {},
        meta: { source: "sticky note" },
        cursor: (_state, ui) => (hoveredHref(ui.hoveredParts) ? "pointer" : null),
        draw: (ctx, _state, ui) => {
          const hovered = hoveredHref(ui.hoveredParts);
          ctx.save();
          ctx.fillStyle = "#fef3c7";
          ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 3;
          ctx.beginPath();
          ctx.roundRect(330, 40, 230, 310, 10);
          ctx.fill();
          ctx.restore();
          const style = (run: TextRun): TextRun => (hovered !== null && run.href === hovered ? { ...run, color: "#0842a0" } : run);
          const text: RichText = {
            blocks: noteText.blocks.map((b) => (b.type === "paragraph" ? { ...b, content: b.content.map((r) => (typeof r === "string" ? r : style(r))) } : b)),
          };
          const layout = layoutText(text, { container: { x: 346, y: 52, width: 198, height: 290 }, theme: { fontSize: 14 } });
          if (hovered !== null) {
            // A tint behind every fragment of the hovered link.
            ctx.fillStyle = "rgba(11, 87, 208, 0.12)";
            for (const line of layout.lines) {
              for (const f of line.fragments) {
                if (layout.paragraphs[line.paragraph]?.runs[f.run]?.href !== hovered) continue;
                ctx.beginPath();
                ctx.roundRect(f.x - 2, line.top + 1, f.width + 4, line.height - 2, 3);
                ctx.fill();
              }
            }
          }
          drawTextLayout(ctx, layout, { meta: { source: "sticky note text" } });
        },
        on: {
          click: (e, c) => {
            const href = hoveredHref(c.ui.hoveredParts);
            if (href === null || ("shiftKey" in e.input && e.input.shiftKey)) return;
            hooks.openLink(href);
          },
        },
      },
    ],
  }),
};

const knobValue = (margin: number): number => margin / 24;

/** A knob, a slider and a button that set the wrapped text's obstacle margin and size. */
const controls: Sample = {
  name: "Controls",
  draw: (ctx, hooks) => {
    const panel = ctx.beginGroup({ meta: { source: "controls panel" } });
    ctx.fillStyle = "#f4f4f5";
    ctx.strokeStyle = "#d4d4d8";
    ctx.beginPath();
    ctx.roundRect(340.5, 370.5, 240, 160, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#52525b";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText("The wrapped text", 352, 392);
    ctx.endGroup();
    const knobId = unique("knob");
    const sliderId = unique("slider");
    const label = (c: RecordingContext, text: string, x: number, y: number): void => {
      c.fillStyle = "#3f3f46";
      c.font = "12px system-ui, sans-serif";
      c.textAlign = "center";
      c.fillText(text, x, y);
      c.textAlign = "start";
    };
    const KX = 395;
    const KY = 440;
    const knob: ComponentSpec<{ value: number }> = {
      id: knobId,
      parent: panel,
      state: { value: knobValue(8) },
      meta: { source: "knob" },
      cursor: (_s, ui) => (ui.pressed ? "grabbing" : "grab"),
      draw: (c, { value }, ui) => {
        const start = 0.75 * Math.PI;
        const end = start + value * 1.5 * Math.PI;
        c.lineCap = "round";
        c.lineWidth = 5;
        c.strokeStyle = "#d4d4d8";
        c.beginPath();
        c.arc(KX, KY, 30, start, start + 1.5 * Math.PI);
        c.stroke();
        c.strokeStyle = "#2563eb";
        c.beginPath();
        c.arc(KX, KY, 30, start, Math.max(end, start + 0.001));
        c.stroke();
        c.fillStyle = ui.hovered || ui.pressed ? "#ffffff" : "#fafafa";
        c.strokeStyle = ui.focused ? "#2563eb" : "#a1a1aa";
        c.lineWidth = ui.focused ? 2 : 1;
        c.beginPath();
        c.arc(KX, KY, 21, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        c.strokeStyle = "#18181b";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(KX + 8 * Math.cos(end), KY + 8 * Math.sin(end));
        c.lineTo(KX + 17 * Math.cos(end), KY + 17 * Math.sin(end));
        c.stroke();
        label(c, `Margin ${Math.round(value * 24)}px`, KX, KY + 52);
      },
      on: {
        dragstart: (e) => e.stopPropagation(),
        drag: (e, k) => {
          e.stopPropagation();
          const center = applyToPoint(k.transform, KX, KY);
          const angle = Math.atan2(e.point.y - center.y, e.point.x - center.x);
          // Measured clockwise from the start of the arc, with the gap at the bottom split between its ends.
          let along = (angle - 0.75 * Math.PI) / (1.5 * Math.PI);
          along = ((along % (4 / 3)) + 4 / 3) % (4 / 3);
          const value = along <= 1 ? along : along < 7 / 6 ? 1 : 0;
          k.setState({ value });
          hooks.setMargin(value * 24);
        },
        keydown: (e, k) => {
          const key = (e.input as { key: string }).key;
          const step = key === "ArrowRight" || key === "ArrowUp" ? 1 / 24 : key === "ArrowLeft" || key === "ArrowDown" ? -1 / 24 : 0;
          if (step === 0) return;
          const value = Math.min(1, Math.max(0, k.state.value + step));
          k.setState({ value });
          hooks.setMargin(value * 24);
        },
      },
    };
    const SX0 = 460;
    const SX1 = 560;
    const SY = 432;
    const sizeAt = (v: number): number => Math.round(12 + v * 8);
    const setSlider = (s: ComponentHandle<{ value: number }>, x: number): void => {
      const local = applyToPoint(invert(s.transform) ?? s.transform, x, 0);
      const value = Math.min(1, Math.max(0, (local.x - SX0) / (SX1 - SX0)));
      s.setState({ value });
      hooks.setSize(sizeAt(value));
    };
    const slider: ComponentSpec<{ value: number }> = {
      id: sliderId,
      parent: panel,
      state: { value: 0.25 },
      meta: { source: "slider" },
      cursor: "pointer",
      draw: (c, { value }, ui) => {
        // A transparent grip taller than the track, so the thin track is easy to hit.
        c.beginGroup({ meta: { hitArea: true } });
        c.fillStyle = "rgba(0, 0, 0, 0)";
        c.fillRect(SX0 - 10, SY - 14, SX1 - SX0 + 20, 28);
        c.endGroup();
        c.fillStyle = "#d4d4d8";
        c.fillRect(SX0, SY - 2, SX1 - SX0, 4);
        const x = SX0 + value * (SX1 - SX0);
        c.fillStyle = "#2563eb";
        c.fillRect(SX0, SY - 2, x - SX0, 4);
        c.fillStyle = "#ffffff";
        c.strokeStyle = ui.focused ? "#2563eb" : "#71717a";
        c.lineWidth = ui.focused || ui.hovered ? 2 : 1;
        c.beginPath();
        c.arc(x, SY, ui.pressed ? 9 : 7, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        label(c, `Size ${sizeAt(value)}px`, (SX0 + SX1) / 2, SY + 28);
      },
      on: {
        down: (e, s) => setSlider(s, e.point.x),
        dragstart: (e) => e.stopPropagation(),
        drag: (e, s) => {
          e.stopPropagation();
          setSlider(s, e.point.x);
        },
        keydown: (e, s) => {
          const key = (e.input as { key: string }).key;
          const step = key === "ArrowRight" || key === "ArrowUp" ? 1 / 8 : key === "ArrowLeft" || key === "ArrowDown" ? -1 / 8 : 0;
          if (step === 0) return;
          const value = Math.min(1, Math.max(0, s.state.value + step));
          s.setState({ value });
          hooks.setSize(sizeAt(value));
        },
      },
    };
    const button: ComponentSpec<{ resets: number }> = {
      id: unique("button"),
      parent: panel,
      state: { resets: 0 },
      meta: { source: "button" },
      cursor: "pointer",
      draw: (c, _s, ui) => {
        c.fillStyle = ui.pressed ? "#1d4ed8" : ui.hovered ? "#3b82f6" : "#2563eb";
        c.beginPath();
        c.roundRect(450, 476, 110, 30, 6);
        c.fill();
        if (ui.focused) {
          c.strokeStyle = "#93c5fd";
          c.lineWidth = 2;
          c.stroke();
        }
        c.fillStyle = "#ffffff";
        c.font = "600 13px system-ui, sans-serif";
        c.textAlign = "center";
        c.fillText("Reset", 505, ui.pressed ? 496 : 495);
        c.textAlign = "start";
      },
      on: {
        click: (e, b) => {
          e.stopPropagation();
          b.setState({ resets: b.state.resets + 1 });
          hooks.get<{ value: number }>(knobId)?.setState({ value: knobValue(8) });
          hooks.get<{ value: number }>(sliderId)?.setState({ value: 0.25 });
          hooks.setMargin(8);
          hooks.setSize(14);
        },
      },
    };
    return { components: [knob, slider, button] };
  },
};

const shapes: Sample = {
  name: "Canvas shapes",
  draw: (ctx) => {
    ctx.beginGroup({ meta: { source: "canvas calls" } });
    ctx.save();
    ctx.translate(120, 330);
    ctx.rotate(-0.2);
    const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 60);
    g.addColorStop(0, "#fda4af");
    g.addColorStop(1, "#e11d48");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 70, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 6;
    ctx.setLineDash([14, 8]);
    ctx.beginPath();
    ctx.moveTo(240, 300);
    ctx.bezierCurveTo(300, 240, 360, 400, 440, 320);
    ctx.stroke();
    ctx.endGroup();
  },
};

/** A stress test: 10,000 small shapes to the right of the board, each its own object. Zoom out to see them all. */
const field: Sample = {
  name: "10,000 shapes",
  draw: (ctx) => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 10_000; i++) {
      ctx.save();
      ctx.translate(1000 + random() * 3000, random() * 2000);
      ctx.rotate(random() * Math.PI * 2);
      ctx.fillStyle = `hsl(${i % 360} 60% 60%)`;
      ctx.strokeStyle = `hsl(${(i * 7) % 360} 50% 35%)`;
      ctx.beginPath();
      switch (i % 4) {
        case 0:
          ctx.rect(-12, -8, 24, 16);
          ctx.fill();
          break;
        case 1:
          ctx.arc(0, 0, 4 + random() * 10, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 2:
          ctx.lineWidth = 1 + random() * 3;
          ctx.moveTo(-14, 0);
          ctx.bezierCurveTo(-6, -16, 6, 16, 14, 0);
          ctx.stroke();
          break;
        case 3:
          ctx.font = "9px system-ui, sans-serif";
          ctx.fillText(`#${i}`, -8, 3);
          break;
      }
      ctx.restore();
    }
  },
};

export const samples: readonly Sample[] = [
  { name: "Badge", svg: badge, at: { x: 40, y: 40 } },
  { name: "Chart", svg: chart, at: { x: 600, y: 60 } },
  { name: "Star", svg: star, at: { x: 200, y: 110 } },
  note,
  wrap,
  circle,
  controls,
  shapes,
  field,
];

/** The samples on the board at first; the rest are a button away. */
export const initialSamples: readonly Sample[] = samples.filter((s) => s !== shapes && s !== field);
