import type { Direction, LayoutOptions, Region, RichText, TextLayout, Theme } from "../src";

/**
 * Rich text for the layout tests. In Chromium, each one with a `width` is laid
 * out by `layoutText` and by the browser's own DOM layout, and the lines must
 * agree. All of them are laid out there once more to capture the measurements
 * and layouts that the Bun tests replay (see packages/pixel/src/capture-text.ts).
 */
export interface TextFixture {
  readonly name: string;
  readonly text: RichText;
  /** A column this wide at the origin, growing downwards. */
  readonly width?: number;
  /** Or a region to fill, with text flowing around obstacles. */
  readonly container?: Region;
  readonly obstacles?: readonly Region[];
  readonly theme?: Partial<Theme>;
  readonly direction?: Direction;
}

const circle = (cx: number, cy: number, r: number, n = 64): Region => ({
  rings: [Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }))],
});

const LOREM =
  "Canvas text has no layout of its own, so every line break here comes from Pretext, which follows the browser's rules for where a line may break and how wide each piece is. The browser lays out the same paragraph with CSS, and the two must wrap at the same places.";

const sans: Partial<Theme> = { fontFamily: '"Liberation Sans", sans-serif', codeFamily: '"DejaVu Sans Mono", monospace' };

export const textFixtures: readonly TextFixture[] = [
  {
    name: "plain paragraph",
    width: 320,
    theme: sans,
    text: { blocks: [{ type: "paragraph", content: [LOREM] }] },
  },
  {
    name: "narrow column with long words",
    width: 140,
    theme: { ...sans, fontSize: 15 },
    text: {
      blocks: [
        { type: "paragraph", content: ["Supercalifragilisticexpialidocious words break between letters when nothing else fits."] },
        { type: "paragraph", content: ["See https://example.com/a/very/long/path/that/keeps/going?query=string&more=yes for details."] },
      ],
    },
  },
  {
    name: "marks and mixed sizes",
    width: 300,
    theme: sans,
    text: {
      blocks: [
        {
          type: "paragraph",
          content: [
            "Some text is ",
            { text: "bold", bold: true },
            ", some ",
            { text: "italic", italic: true },
            ", some ",
            { text: "inline code()", code: true },
            ", and a ",
            { text: "much larger phrase", size: 26, color: "#a03" },
            " makes its line taller than the others around it, while ",
            { text: "small print", size: 11 },
            " does not.",
          ],
        },
      ],
    },
  },
  {
    name: "headings, paragraphs and lists",
    width: 360,
    theme: { ...sans, fontFamily: '"DejaVu Serif", serif', fontSize: 15 },
    text: {
      blocks: [
        { type: "heading", level: 1, content: ["A heading that wraps onto two lines"] },
        { type: "paragraph", content: ["A paragraph after the heading, long enough to wrap at least once in this column."] },
        { type: "heading", level: 3, content: ["Lists"] },
        {
          type: "list",
          items: [
            [{ type: "paragraph", content: ["A bulleted item that is long enough to wrap under its own first line."] }],
            [
              { type: "paragraph", content: ["An item with a nested list:"] },
              {
                type: "list",
                ordered: true,
                items: [
                  [{ type: "paragraph", content: ["First nested, numbered item."] }],
                  [{ type: "paragraph", content: ["Second nested item, which also wraps because it goes on for a while."] }],
                ],
              },
            ],
            [{ type: "paragraph", content: ["Last item."] }],
          ],
        },
        { type: "paragraph", content: ["And a closing paragraph."] },
      ],
    },
  },
  {
    name: "alignment",
    width: 280,
    theme: sans,
    text: {
      blocks: [
        { type: "paragraph", align: "center", content: ["Centered text wraps the same way and sits in the middle of each line."] },
        { type: "paragraph", align: "right", content: ["Right-aligned text ends at the right edge of the column."] },
        { type: "paragraph", align: "end", content: ["End-aligned, which is right in a left-to-right paragraph."] },
      ],
    },
  },
  {
    name: "punctuation, numbers and dashes",
    width: 250,
    theme: { ...sans, fontFamily: '"Liberation Serif", serif', fontSize: 17 },
    text: {
      blocks: [
        {
          type: "paragraph",
          content: [
            "“Quoted,” she said—then paused. Prices rose 12.5% (from $1,024.00 to $1,152.00) in 2025–2026; see pp. 14–16, §3.2, and fig. 7/b… well-known, self-evident, hyphen-ated.",
          ],
        },
      ],
    },
  },
  {
    name: "Chinese and Japanese",
    width: 230,
    theme: { fontFamily: '"WenQuanYi Zen Hei", "IPAGothic", sans-serif', fontSize: 16 },
    text: {
      blocks: [
        { type: "paragraph", content: ["春天到了，花园里的花都开了。孩子们在草地上奔跑，老人们坐在长椅上聊天，一切都显得那么美好。"] },
        { type: "paragraph", content: ["吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。「何でも薄暗いじめじめした所」で泣いていた事だけは記憶している。"] },
      ],
    },
  },
  {
    name: "right-to-left paragraphs",
    width: 260,
    direction: "rtl",
    theme: { fontFamily: '"DejaVu Sans", sans-serif', fontSize: 16 },
    text: {
      blocks: [
        { type: "paragraph", content: ["بدأت الرحلة في الصباح الباكر، وكانت الشمس تشرق فوق الجبال البعيدة بينما كان المسافرون يستعدون للمغادرة."] },
        { type: "paragraph", content: ["הספר יצא לאור בשנת 1998 ונמכר ביותר מ-200,000 עותקים ברחבי העולם, כולל בארצות הברית."] },
      ],
    },
  },
  {
    name: "mixed directions in one paragraph",
    width: 300,
    theme: { fontFamily: '"DejaVu Sans", sans-serif', fontSize: 15 },
    text: {
      blocks: [
        { type: "paragraph", content: ["The word for peace is سلام in Arabic and שלום in Hebrew; both appear here inside an English sentence that wraps."] },
        { type: "paragraph", direction: "auto", content: ["مرحبا بالعالم: this paragraph starts in Arabic, so its base direction is right to left."] },
      ],
    },
  },
  {
    name: "Thai without spaces",
    width: 200,
    theme: { fontFamily: '"Loma", sans-serif', fontSize: 16 },
    text: { blocks: [{ type: "paragraph", content: ["ภาษาไทยเขียนติดกันโดยไม่มีช่องว่างระหว่างคำ จึงต้องใช้พจนานุกรมในการตัดคำเมื่อขึ้นบรรทัดใหม่"] }] },
  },
  {
    name: "circle container",
    container: circle(150, 150, 140),
    theme: { ...sans, fontSize: 14 },
    text: { blocks: [{ type: "paragraph", align: "center", content: [LOREM, " ", LOREM] }] },
  },
  {
    name: "rectangle around a circular obstacle",
    container: { rings: [[{ x: 0, y: 0 }, { x: 360, y: 0 }, { x: 360, y: 400 }, { x: 0, y: 400 }]] },
    obstacles: [circle(180, 120, 60)],
    theme: sans,
    text: { blocks: [{ type: "paragraph", content: [LOREM, " ", LOREM] }] },
  },
  {
    name: "triangle that runs out of room",
    container: { rings: [[{ x: 150, y: 0 }, { x: 300, y: 260 }, { x: 0, y: 260 }]] },
    theme: sans,
    text: { blocks: [{ type: "paragraph", content: [LOREM, " ", LOREM, " ", LOREM] }] },
  },
];

/** The layout options a fixture stands for. */
export const fixtureOptions = (f: TextFixture): LayoutOptions => ({
  container: f.container ?? { x: 0, y: 0, width: f.width ?? 300 },
  ...(f.obstacles ? { obstacles: f.obstacles } : {}),
  ...(f.theme ? { theme: f.theme } : {}),
  ...(f.direction ? { direction: f.direction } : {}),
  engine: "blink",
});

/** A layout as plain data, for golden files. */
export const layoutSnapshot = (layout: TextLayout) => ({
  overflow: layout.overflow,
  top: layout.top,
  bottom: layout.bottom,
  fingerprint: layout.fingerprint,
  lines: layout.lines.map((l) => ({
    paragraph: l.paragraph,
    top: l.top,
    height: l.height,
    baseline: l.baseline,
    left: l.left,
    right: l.right,
    fragments: [...(l.marker ? [l.marker] : []), ...l.fragments].map((f) => [f.text, f.x, f.width, f.font, f.direction] as const),
  })),
});

/** Measurements captured from a browser canvas, keyed by the context state that affects them and the text. */
export type MeasurementTable = Record<string, Record<string, number>>;

/** The context state a measurement depends on, as assigned (the font) or as read back (the rest). */
export interface MeasureState {
  readonly font: string;
  readonly letterSpacing: string;
  readonly wordSpacing: string;
  readonly fontKerning: string;
}

export const measurementKey = (state: MeasureState, text: string): string =>
  [state.font, state.letterSpacing, state.wordSpacing, state.fontKerning, text].join("\u0000");
