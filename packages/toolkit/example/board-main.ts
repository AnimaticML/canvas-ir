// A board from the toolkit with a document of its own. The board picks, outlines, drags with snapping, lassos, draws
// with the tools, keeps arrows on what they join, pans and zooms; this page keeps what is on it as a list of documents,
// one per drawing, and an undo history of those lists. Each change the board reports is committed here; undo loads the
// last list back onto the board.
import type { IRDocument } from "canvas-ir";
import { Board, CardLayer, boardPanels, snapControls, snapSettings } from "@canvas-ir/toolkit";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const cards = new CardLayer(document.getElementById("cards") as HTMLCanvasElement, stage, {
  recorder: {},
  onCursor: (cursor) => {
    if (board.pointerOverCards) canvas.style.cursor = cursor ?? "default";
  },
  onFocus: () => board.keysToCardsLayer(),
});

// The application's document and its history: what is on the board, as the board's own documents.
let doc: IRDocument[] = [];
const history: IRDocument[][] = [];
const changes: string[] = [];
const commit = (kind: string): void => {
  history.push(doc);
  doc = board.documents();
  changes.push(kind);
};
const undo = (): void => {
  const was = history.pop();
  if (!was) return;
  doc = was;
  board.load(doc);
};

// What the snapping controls in the inspector set, and the board reads.
const snap = snapControls();
const board: Board = new Board({
  stage,
  canvas,
  overlay: document.getElementById("overlay") as HTMLCanvasElement,
  cards,
  snap: () => snapSettings(snap),
  hooks: {
    changed: ({ kind }) => commit(kind),
  },
});

// A few shapes and arrows to start with: drawn on the board, then taken as the first document.
const shape = (id: string, x: number, y: number, fill: string, round = false) =>
  board.drawGroup(id, (c) => {
    c.beginPath();
    if (round) c.ellipse(x + 70, y + 45, 70, 45, 0, 0, Math.PI * 2);
    else c.roundRect(x, y, 140, 90, 12);
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = "#1f2937";
    c.lineWidth = 2;
    c.stroke();
  });
shape("idea", 80, 80, "#fde68a");
shape("sketch", 360, 40, "#bfdbfe");
shape("shot", 360, 240, "#bbf7d0", true);
const arrow = (id: string, from: string, to: string) =>
  board.drawConnector(id, { kind: "arrow", from: { key: `board:${from}`, x: 0, y: 0 }, to: { key: `board:${to}`, x: 0, y: 0 }, bend: 0.15, color: "#475569", seed: id.length * 97 });
arrow("idea-sketch", "idea", "sketch");
arrow("idea-shot", "idea", "shot");
doc = board.documents();
board.adoptConnectors();
board.setView({ a: 1, b: 0, c: 0, d: 1, e: 700, f: 20 });

// The toolkit's toolbar and inspector, with this page's undo among the toolbar's actions.
boardPanels(board, cards, { x: -660, y: 0, snap, height: 560, actions: [{ text: "Undo", look: "primary", onClick: undo }] });
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") undo();
});

Object.assign(window, { boardExample: { board, history, changes, get doc() { return doc; } } });
