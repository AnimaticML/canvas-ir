// A small board built only from public imports: cards with title bars to drag, a button on each, arrows between them,
// panned and zoomed by mouse, wheel, trackpad or two fingers, with the accessibility mirror reading and pressing the
// same buttons. Its document is a plain object with its own undo: the toolkit decides what the pointers did, and this
// page decides what that means and keeps it, as Harmonica's Codec document or Painter's state would.
import { AccessibilityLayer, RecordingContext, Renderer, Scene, type Point } from "canvas-ir";
import { Actions, Gestures, Viewport, bindGestures, mountCanvas, wheelZoom } from "@canvas-ir/toolkit";

interface Card {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}
interface Doc {
  readonly cards: readonly Card[];
  readonly links: readonly { readonly from: string; readonly to: string }[];
}

const W = 180;
const H = 110;
const BAR = 28;

// The application's document and its history: the toolkit never sees either.
let doc: Doc = {
  cards: [
    { id: "idea", title: "Idea", x: 40, y: 60, count: 0 },
    { id: "sketch", title: "Sketch", x: 300, y: 30, count: 0 },
    { id: "shot", title: "Shot", x: 300, y: 230, count: 0 },
  ],
  links: [
    { from: "idea", to: "sketch" },
    { from: "idea", to: "shot" },
  ],
};
const history: Doc[] = [];
const commit = (next: Doc): void => {
  history.push(doc);
  doc = next;
  draw(doc);
};
const undo = (): void => {
  const was = history.pop();
  if (was) {
    doc = was;
    draw(doc);
  }
};
const moved = (d: Doc, id: string, dx: number, dy: number): Doc => ({ ...d, cards: d.cards.map((c) => (c.id === id ? { ...c, x: c.x + dx, y: c.y + dy } : c)) });

// Drawing: everything under one "board" group, recorded again when the document changes. The view never re-records.
const record = (d: Doc) => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "board" });
  const byId = new Map(d.cards.map((c) => [c.id, c]));
  for (const link of d.links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) continue;
    ctx.beginGroup({ id: `link:${link.from}-${link.to}`, meta: { role: "img", label: `${a.title} leads to ${b.title}` } });
    const from = { x: a.x + W, y: a.y + H / 2 };
    const to = { x: b.x, y: b.y + H / 2 };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(from.x + 50, from.y, to.x - 50, to.y, to.x, to.y);
    ctx.strokeStyle = "#7a8aa0";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - 10, to.y - 5);
    ctx.lineTo(to.x - 10, to.y + 5);
    ctx.closePath();
    ctx.fillStyle = "#7a8aa0";
    ctx.fill();
    ctx.endGroup();
  }
  for (const c of d.cards) {
    ctx.beginGroup({ id: `card:${c.id}`, meta: { role: "region", label: `${c.title} card` } });
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, W, H, 10);
    ctx.fillStyle = "#fffdf8";
    ctx.fill();
    ctx.strokeStyle = "#9a9d97";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginGroup({ id: `card:${c.id}/title`, meta: { label: `Move ${c.title}` } });
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, W, BAR, [10, 10, 0, 0]);
    ctx.fillStyle = "#ece9e1";
    ctx.fill();
    ctx.fillStyle = "#2a2c2a";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText(c.title, c.x + 12, c.y + 19);
    ctx.endGroup();
    ctx.fillStyle = "#4a4d4a";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText(`Pressed ${c.count} times`, c.x + 12, c.y + BAR + 28);
    ctx.beginGroup({ id: `card:${c.id}/add`, meta: { role: "button", label: `Press ${c.title}` } });
    ctx.beginPath();
    ctx.roundRect(c.x + 12, c.y + H - 36, 72, 26, 6);
    ctx.fillStyle = "#1b5293";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Press", c.x + 30, c.y + H - 18);
    ctx.endGroup();
    ctx.endGroup();
  }
  ctx.endGroup();
  return ctx.getDocument();
};

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
// Recorded through replaceGroup from the start, so the ids are the same ("board/card:…") before and after a change.
const scene = new Scene({ version: 1, ops: [] });
scene.replaceGroup("board", record(doc));
const renderer = new Renderer(scene, canvas.getContext("2d")!, { background: "#f4f2ec" });
const viewport = new Viewport({ zoom: 1, x: 40, y: 40 }, { minZoom: 0.25, maxZoom: 4 });

// What the buttons do, by group id, for a tap and for Enter on the mirror alike.
const actions = new Actions();
const bindActions = (d: Doc): void => {
  actions.clear();
  for (const c of d.cards) {
    actions.set(`board/card:${c.id}/add`, {
      label: `Press ${c.title}`,
      run: () => commit({ ...doc, cards: doc.cards.map((x) => (x.id === c.id ? { ...x, count: x.count + 1 } : x)) }),
    });
  }
};
const a11y = new AccessibilityLayer(scene, stage, { onActivate: (id) => actions.run(id) });

function draw(d: Doc): void {
  scene.replaceGroup("board", record(d));
  bindActions(d);
  host.schedule();
}

const host = mountCanvas(canvas, {
  draw: ({ pixelRatio }) => {
    renderer.setView(viewport.device(pixelRatio), canvas.width, canvas.height);
    a11y.setView(viewport.matrix);
    renderer.render();
  },
});
viewport.onChange(() => host.schedule());

// The groups under a screen point, innermost first.
const groupsAt = (screen: Point): readonly string[] => scene.hitTest(viewport.toWorld(screen), { tolerance: 3 / viewport.zoom })[0]?.groups ?? [];
const cardOf = (groups: readonly string[]): string | null => {
  const title = groups.find((g) => g.endsWith("/title"));
  return title ? title.slice("board/card:".length, -"/title".length) : null;
};

// A drag on a title bar moves its card, shown as it goes and committed once when it ends; anywhere else pans.
let dragging: { id: string; start: Doc } | null = null;
let pressed: string | null = null;
const gestures = new Gestures({
  press: (p) => {
    pressed = cardOf(groupsAt(p));
  },
  dragStart: () => {
    if (pressed) dragging = { id: pressed, start: doc };
  },
  drag: (e) => {
    if (dragging) {
      scene.replaceGroup("board", record(moved(dragging.start, dragging.id, e.total.x / viewport.zoom, e.total.y / viewport.zoom)));
      host.schedule();
    } else viewport.panBy(e.delta.x, e.delta.y);
  },
  dragEnd: (e) => {
    if (dragging) commit(moved(dragging.start, dragging.id, e.total.x / viewport.zoom, e.total.y / viewport.zoom));
    dragging = null;
  },
  cancel: () => {
    // A second finger or a lost pointer: the card goes back where it was, and nothing is committed.
    if (dragging) draw(doc);
    dragging = null;
  },
  tap: (p) => {
    actions.run(groupsAt(p));
  },
  pinch: ({ scale, center, pan }) => {
    viewport.zoomAt(scale, center);
    viewport.panBy(pan.x, pan.y);
  },
  hover: (p) => {
    const g = groupsAt(p);
    canvas.style.cursor = cardOf(g) ? "move" : g.some((x) => actions.has(x)) ? "pointer" : "grab";
  },
});
bindGestures(canvas, gestures, {
  wheel: ({ point, deltaY }) => viewport.zoomAt(wheelZoom(deltaY), point),
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") undo();
  if (e.key === "Escape") gestures.cancel();
});
document.getElementById("undo")!.addEventListener("click", undo);
bindActions(doc);

// For the check script and for poking at it from the console.
Object.assign(window, { example: { get doc() { return doc; }, history, viewport, actions } });
