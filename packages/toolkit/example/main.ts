// A small board built only from public imports: cards with title bars to drag, a button on each, connectors between
// them, and a card of controls over the board, panned and zoomed by mouse, wheel, trackpad or two fingers, with the
// accessibility mirror reading and pressing the same buttons. Its document is a plain object with its own undo: the
// toolkit decides what the pointers did and draws its parts, and this page decides what that means and keeps it.
import { AccessibilityLayer, RecordingContext, Renderer, Scene, type Point, type Rect } from "canvas-ir";
import { Actions, CardLayer, Gestures, Viewport, bindGestures, button, drawArrow, mountCanvas, route, slider, wheelZoom } from "@canvas-ir/toolkit";

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
  /** How far every connector bows, set from the controls card. */
  readonly bend: number;
  /** Where the controls card is: moving it is an edit like any other, so undo puts it back. */
  readonly controls: Point;
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
  bend: 0.15,
  controls: { x: 40, y: 260 },
};
const history: Doc[] = [];
/** What the last commit changed, so a slider's run of changes is one step to undo. */
let lastKind: string | null = null;
const commit = (next: Doc, kind: string | null = null): void => {
  if (kind === null || kind !== lastKind) history.push(doc);
  lastKind = kind;
  doc = next;
  draw(doc);
};
const undo = (): void => {
  const was = history.pop();
  lastKind = null;
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
    // Each end holds on to its card, so the arrow follows a card as it is dragged, edge to edge.
    const connector = { kind: "arrow", from: { key: a.id, x: a.x, y: a.y }, to: { key: b.id, x: b.x, y: b.y }, bend: d.bend, color: "#7a8aa0", seed: 7 } as const;
    const ends = route(connector, (key) => {
      const c = byId.get(key);
      return c ? ({ x: c.x, y: c.y, width: W, height: H } satisfies Rect) : null;
    });
    drawArrow(ctx, ends.from, ends.to, connector);
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
const cardCanvas = document.getElementById("cards") as HTMLCanvasElement;
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

// A card of controls over the board, on a layer of its own: it pans and zooms with the board but isn't in its drawing.
// Its widgets call back into this page, which commits; dragging its frame moves it, committed when the drag ends.
const layer = new CardLayer(cardCanvas, stage, {
  recorder: {},
  onCursor: (cursor) => (canvas.style.cursor = cursor ?? ""),
  onFocus: () => {},
});
let added = 0;
const controls = layer.card({
  id: "controls",
  title: "Controls",
  x: doc.controls.x,
  y: doc.controls.y,
  width: 220,
  build: (card, width) => {
    card.mount(
      button({
        id: "add",
        panel: card,
        box: { x: 12, y: 12, w: width - 24, h: 30 },
        text: "Add a card",
        look: "primary",
        onClick: () => {
          const id = `new${++added}`;
          const last = doc.cards[doc.cards.length - 1]!;
          commit({ ...doc, cards: [...doc.cards, { id, title: `Card ${added}`, x: last.x + 40, y: last.y + 140, count: 0 }], links: [...doc.links, { from: last.id, to: id }] });
        },
      }),
    );
    card.mount(
      slider({
        id: "bend",
        panel: card,
        box: { x: 12, y: 54, w: width - 24, h: 28 },
        text: "Bend",
        min: -0.5,
        max: 0.5,
        step: 0.05,
        value: doc.bend,
        format: (v) => v.toFixed(2),
        onChange: (bend) => commit({ ...doc, bend }, "bend"),
      }),
    );
    return 94;
  },
  onMove: (x, y) => commit({ ...doc, controls: { x, y } }),
});

function draw(d: Doc): void {
  scene.replaceGroup("board", record(d));
  bindActions(d);
  // The controls card shows the document too: after an undo, its place and its slider's value.
  controls.moveTo(d.controls.x, d.controls.y);
  const bend = controls.get<{ value: number }>("bend");
  if (bend && bend.state.value !== d.bend) bend.setState({ value: d.bend });
  host.schedule();
}

const host = mountCanvas(canvas, {
  draw: ({ pixelRatio }) => {
    renderer.setView(viewport.device(pixelRatio), canvas.width, canvas.height);
    a11y.setView(viewport.matrix);
    renderer.render();
    if (cardCanvas.width !== canvas.width || cardCanvas.height !== canvas.height) {
      cardCanvas.width = canvas.width;
      cardCanvas.height = canvas.height;
    }
    layer.setView(viewport.matrix, viewport.device(pixelRatio));
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
  // Presses and hovers over the controls card go to it; the rest are the board's.
  above: layer,
  wheel: (input) => {
    if (layer.hits(input.point) && layer.wheel({ x: input.point.x, y: input.point.y, deltaX: input.deltaX, deltaY: input.deltaY, ctrlKey: input.ctrlKey, metaKey: input.metaKey })) return;
    viewport.zoomAt(wheelZoom(input.deltaY), input.point);
  },
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") undo();
  if (e.key === "Escape") gestures.cancel();
});
document.getElementById("undo")!.addEventListener("click", undo);
bindActions(doc);

// For the check script and for poking at it from the console.
Object.assign(window, { example: { get doc() { return doc; }, history, viewport, actions, layer, scene, controls } });
