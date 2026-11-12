// The board as a collage: on a surface with no edge, things are put down once, where they belong, and stay there,
// gathered by what they have to do with each other rather than lined up on a grid. Reading in one corner, drawing and
// animation in another, data in a lab, the map and the stars out there, the toys in a box; and in the middle, drawn
// with the board's own pen and text, a day at this desk: what to open when, with arrows to the icons that hold on to
// what they join (see connectors.ts).
//
// These are the places things start in. Whatever is moved, drawn or deleted on the board is remembered over them
// (see `Layout` in main.ts), so this is only the first arrangement.
import type { RecordingContext } from "canvas-ir";
import type { Connector } from "./connectors";

export interface Place {
  readonly x: number;
  readonly y: number;
}

/** Each demo window's top left corner, title bar included. */
export const WINDOWS = {
  book: { x: -600, y: -1820 },
  declaration: { x: 720, y: -1660 },
  pelican: { x: 2400, y: -1820 },
  morph: { x: 3200, y: -1900 },
  paint: { x: 3260, y: -1380 },
  table: { x: 4900, y: -1180 },
  graph: { x: 5920, y: -1300 },
  points: { x: 4900, y: -440 },
  map: { x: -620, y: 1500 },
  galaxy: { x: 1000, y: 1700 },
  physics: { x: 3000, y: 1500 },
  many: { x: 4300, y: 1460 },
} as const satisfies Record<string, Place>;

/** How far each demo's own drawing starts from its window's corner: the frame and title bar drawn around it. */
const FRAME: Partial<Record<keyof typeof WINDOWS, Place>> = {
  pelican: { x: 16, y: 56 },
  physics: { x: 16, y: 56 },
  graph: { x: 16, y: 56 },
  morph: { x: 16, y: 56 },
  paint: { x: 32, y: 72 },
  table: { x: 1, y: 1 },
  map: { x: 0, y: 56 },
};

/** Where a demo draws from, for its window to have its corner at its place. */
export const origin = (name: keyof typeof WINDOWS): Place => ({ x: WINDOWS[name].x + (FRAME[name]?.x ?? 0), y: WINDOWS[name].y + (FRAME[name]?.y ?? 0) });

/** The icons' top left corners, with a slight turn each, as if put down by hand. */
export const ICONS: Record<string, Place & { readonly tilt: number }> = {
  book: { x: 420, y: -860, tilt: -5 },
  declaration: { x: 1660, y: -700, tilt: 4 },
  pelican: { x: 2440, y: -1150, tilt: -6 },
  morph: { x: 3830, y: -1860, tilt: 6 },
  paint: { x: 4150, y: -1230, tilt: -4 },
  picture: { x: 4170, y: -960, tilt: 5 },
  table: { x: 4690, y: -1150, tilt: -3 },
  graph: { x: 6560, y: -1250, tilt: 5 },
  points: { x: 6470, y: -420, tilt: -4 },
  map: { x: -560, y: 2520, tilt: 3 },
  galaxy: { x: 2480, y: 1720, tilt: -5 },
  physics: { x: 3080, y: 2100, tilt: 6 },
  many: { x: 3930, y: 1480, tilt: -3 },
};

/** The drawings, text and charts that lie on the board from the start, by their samples' names: their top left corners. */
export const CONTENT: Record<string, Place> = {
  "Text block": { x: -600, y: -790 },
  "Text in a circle": { x: -300, y: -730 },
  "Text around shapes": { x: 30, y: -800 },
  Badge: { x: 2700, y: -1120 },
  Star: { x: 2880, y: -1100 },
  "Canvas shapes": { x: 2620, y: -900 },
  Chart: { x: 4900, y: 160 },
  "Chart.js chart": { x: 5200, y: 140 },
  "D3 chart": { x: 5700, y: 140 },
  Controls: { x: 3300, y: 2120 },
  "HTML and 3D": { x: 3020, y: 2400 },
};

const INK = "#1f2937";
const MARKERS = { red: "#e11d48", blue: "#2563eb", green: "#059669", orange: "#ea580c", violet: "#7c3aed" } as const;
const NOTES = { yellow: "#fef08a", pink: "#fbcfe8", green: "#bbf7d0", blue: "#bfdbfe", orange: "#fed7aa" } as const;

/** One drawing on the board: a note, a label or an arrow, each its own thing to move or delete. */
export interface Drawing {
  readonly id: string;
  readonly draw: (c: RecordingContext) => void;
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** A heading written with a marker, turned a little. */
const label = (id: string, text: string, x: number, y: number, o: { size?: number; color?: string; turn?: number } = {}): Drawing => ({
  id,
  draw: (c) => {
    c.save();
    c.translate(x, y);
    c.rotate(((o.turn ?? 0) * Math.PI) / 180);
    c.font = `800 ${o.size ?? 120}px ${FONT}`;
    c.fillStyle = o.color ?? INK;
    c.textBaseline = "top";
    c.fillText(text, 0, 0);
    c.restore();
  },
});

/** A sticky note with a line or a few of text. */
const note = (id: string, lines: readonly string[], x: number, y: number, o: { color?: string; turn?: number; width?: number; size?: number } = {}): Drawing => ({
  id,
  draw: (c) => {
    const size = o.size ?? 30;
    const width = o.width ?? 300;
    const height = 36 + lines.length * size * 1.3;
    c.save();
    c.translate(x + width / 2, y + height / 2);
    c.rotate(((o.turn ?? 0) * Math.PI) / 180);
    c.translate(-width / 2, -height / 2);
    c.shadowColor = "rgba(15, 23, 42, 0.18)";
    c.shadowBlur = 16;
    c.shadowOffsetY = 6;
    c.fillStyle = o.color ?? NOTES.yellow;
    c.fillRect(0, 0, width, height);
    c.shadowColor = "transparent";
    c.font = `600 ${size}px ${FONT}`;
    c.fillStyle = INK;
    c.textBaseline = "top";
    lines.forEach((line, i) => c.fillText(line, 20, 20 + i * size * 1.3));
    c.restore();
  },
});

/** What is drawn on the board at first: each corner's name, and the day at this desk as a flowchart in the middle. */
export const DRAWINGS: readonly Drawing[] = [
  label("note/reading", "Reading room", -600, -2110, { color: MARKERS.blue, turn: -2 }),
  label("note/studio", "Studio", 2400, -2110, { color: MARKERS.violet, turn: 2 }),
  label("note/lab", "Lab", 4900, -1450, { color: MARKERS.green, turn: -3 }),
  label("note/out", "Out there", -600, 1290, { color: MARKERS.blue, turn: 3 }),
  label("note/toys", "Toy box", 3000, 1290, { color: MARKERS.orange, turn: -2 }),
  label("note/tools", "Tools: draw and write on the desk", -740, -90, { size: 40, color: MARKERS.red, turn: -1 }),

  // A day at this desk.
  label("note/day", "A day at this desk", 1100, 120, { size: 64, turn: -1 }),
  note("note/woke", ["Woke up"], 1250, 300, { color: NOTES.yellow, turn: -2, width: 230 }),
  note("note/news", ["Curious what's", "out there?"], 380, 640, { color: NOTES.blue, turn: 3, width: 290 }),
  note("note/bored", ["Bored?", "Play something"], 1780, 560, { color: NOTES.pink, turn: -3, width: 280 }),
  note("note/deadline", ["Deadline close?", "Crunch numbers"], 2800, 300, { color: NOTES.green, turn: 2, width: 300 }),
  note("note/tired", ["Tired?", "Read a chapter"], 1100, 860, { color: NOTES.orange, turn: -2, width: 270 }),
  note("note/small", ["Feeling small?", "Look at the stars"], 2100, 1060, { color: NOTES.blue, turn: 4, width: 310 }),
];

/** An arrow from one thing to another, by the keys the board knows them by. */
const arrow = (id: string, from: string, to: string, o: { bend?: number; color?: string; word?: string; seed: number }): { id: string; connector: Connector } => ({
  id,
  connector: { kind: "arrow", from: { key: from, x: 0, y: 0 }, to: { key: to, x: 0, y: 0 }, bend: o.bend ?? 0.15, color: o.color ?? INK, seed: o.seed, ...(o.word ? { word: o.word } : {}) },
});

/** The flowchart's arrows, from note to note and from the notes to the icons they mean, held on at both ends. */
export const CONNECTORS: readonly { id: string; connector: Connector }[] = [
  arrow("note/woke-news", "board:note/woke", "board:note/news", { bend: -0.2, word: "morning", seed: 3 }),
  arrow("note/woke-bored", "board:note/woke", "board:note/bored", { bend: 0.2, word: "weekend", seed: 5 }),
  arrow("note/woke-deadline", "board:note/woke", "board:note/deadline", { bend: -0.12, word: "workday", seed: 9 }),
  arrow("note/news-tired", "board:note/news", "board:note/tired", { bend: 0.25, word: "evening", seed: 11 }),
  arrow("note/bored-small", "board:note/bored", "board:note/small", { bend: -0.2, word: "at night", seed: 13 }),
  arrow("note/to-map", "board:note/news", "icon:map", { bend: 0.15, color: MARKERS.blue, seed: 17 }),
  arrow("note/to-book", "board:note/tired", "icon:book", { bend: -0.12, color: MARKERS.orange, seed: 19 }),
  arrow("note/to-pelican", "board:note/bored", "icon:pelican", { bend: 0.15, color: MARKERS.violet, seed: 23 }),
  arrow("note/to-physics", "board:note/bored", "icon:physics", { bend: -0.22, color: MARKERS.orange, word: "or throw things", seed: 29 }),
  arrow("note/to-table", "board:note/deadline", "icon:table", { bend: 0.15, color: MARKERS.green, seed: 31 }),
  arrow("note/to-galaxy", "board:note/small", "icon:galaxy", { bend: -0.2, color: MARKERS.blue, seed: 37 }),
  { id: "note/ring-table", connector: { kind: "ring", from: { key: "icon:table", x: 0, y: 0 }, bend: 0, color: MARKERS.green, seed: 41 } },
];
