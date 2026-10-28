// The playground: drawings recorded into one document, replayed onto a canvas,
// and made interactive through the scene and the event router.
import { Canvg } from "canvg";
import {
  AccessibilityLayer,
  type AccessibleNode,
  Components,
  EmbedLayer,
  EventRouter,
  Renderer,
  IDENTITY,
  type Matrix2D,
  RecordingContext,
  type RecordingContextOptions,
  type RouterEvent,
  Scene,
  type SnapKind,
  applyToPoint,
  multiply,
  replayDocument,
  serializeDocument,
  imageToWorld,
  toSVG,
  traceImageSource,
  transformOp,
  type ImageOp,
  type Op,
  type Point,
} from "canvas-ir";
import { vectorize } from "@canvas-ir/vectorize";
import { LiveText } from "@canvas-ir/text";
import { datumAt } from "./charts";
import { Devtools } from "./devtools";
import { createEmbed, destroyEmbed } from "./embeds";
import { MORPH_AT, MORPH_ID, dayToNight, morphControls } from "./morph-demo";
import { PELICAN_ID, POSES_PER_TURN, Ride, rideButton } from "./pelican";
import { PHYSICS_AT, PHYSICS_ID, type Sandbox, createSandbox, sandboxButton } from "./physics-demo";
import { GRAPH_AT, GRAPH_ID, type ForceGraph, createGraph, graphButton } from "./graph-demo";
import { PAINT_AT, PAINT_ID, type PaintSource, paintComponent, paintingSource, pictureSource } from "./paint-demo";
import { MillionRows, TABLE_AT, TABLE_ID } from "./table-demo";
import { POINTS_AT, POINTS_ID, TenMillionPoints } from "./points-demo";
import { GALAXY_AT, GALAXY_ID, StarsAndPlanets } from "./galaxy-demo";
import { type ToolName, Tools } from "./tools";
import { type ControlHooks, type LiveSpec, type Sample, initialSamples, samples } from "./samples";
import { Chrome, type Settings } from "./ui/chrome";
import { type Feature, ICON_REACH, featureIcon } from "./ui/features";
import { CardLayer } from "./ui/cards";
import { textSink } from "./ui/kit";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const cardCanvas = document.getElementById("cards") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const octx = overlay.getContext("2d")!;
/** What the inspector's controls set. */
const settings: Settings = { snapOn: true, snapRadius: 8, snapKinds: new Set(["points", "bounds", "path"]), snapText: false, lod: true };
/** The playground and inspector cards; made once the board's parts exist. */
let chrome: Chrome | null = null;
/** Whether key presses go to the cards, after a press on one, rather than the board. */
let keysToCards = false;
/** Whether the press that is down began on a card, and whether the pointer is over one. */
let cardPress = false;
let boardPress = false;
let overCards = false;

// Images seen while recording, by the src the IR stores, so replay draws the same objects.
const images = new Map<string, CanvasImageSource>();
const imageIds = new Map<unknown, string>();
// Each image's traced silhouette, so hit tests, snapping and text wrap follow its opaque pixels.
const outlines = new Map<unknown, Point[][]>();
/** Op id to the line of code that drew it, for devtools. */
const sources = new Map<string, string>();
const recorderOptions: RecordingContextOptions = {
  captureSource: true,
  describeImage: (img) => {
    const source = img as { src?: string; width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const width = source.naturalWidth ?? source.width ?? 0;
    const height = source.naturalHeight ?? source.height ?? 0;
    if (!(width > 0 && height > 0)) return null;
    let src = imageIds.get(img);
    if (src === undefined) {
      src = typeof source.src === "string" && source.src !== "" ? source.src : `image-${imageIds.size}`;
      imageIds.set(img, src);
      images.set(src, img as CanvasImageSource);
    }
    let outline = outlines.get(img);
    if (!outline) {
      outline = traceImageSource(img as CanvasImageSource, width, height);
      outlines.set(img, outline);
    }
    return { src, width, height, outline };
  },
};

let scene = new Scene({ version: 1, ops: [] });
let liveTexts: LiveText[] = [];
let view: Matrix2D = IDENTITY;
let router = new EventRouter(scene);
let renderer = new Renderer(scene, ctx);
// The playground's controls: cards in a scene of their own, drawn over the board with its view.
const cards = new CardLayer(cardCanvas, stage, {
  recorder: recorderOptions,
  onCursor: (cursor) => {
    if (overCards) canvas.style.cursor = cursor ?? "default";
  },
  onFocus: () => {
    keysToCards = true;
  },
});
/** The board's cursor: a hovered component's, or the drawing tool's. */
const boardCursor = (): string => components?.cursor ?? (tools.current === "select" ? "" : tools.current === "text" ? "text" : "crosshair");
// HTML and WebGL elements of embed ops, beneath the board.
const embeds = new EmbedLayer(scene, stage, canvas, { create: createEmbed, destroy: destroyEmbed });
// What screen readers read and Tab reaches: a DOM mirror of the board's roles and text.
const outlineOf = (nodes: readonly AccessibleNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.role}${n.label ? ` "${n.label.length > 48 ? `${n.label.slice(0, 47)}…` : n.label}"` : ""}${n.value !== undefined ? ` = ${n.value}` : ""}`, ...outlineOf(n.children, depth + 1)]);
const a11y = new AccessibilityLayer(scene, stage, {
  onFocus: (id) => {
    keysToCards = false;
    router.focusOn(id);
  },
  // Enter or Space presses the control where it is drawn, as a click would.
  onActivate: (id) => {
    const b = scene.bounds(id);
    if (!b) return;
    const p = applyToPoint(view, b.x + b.width / 2, b.y + b.height / 2);
    router.pointerDown({ x: p.x, y: p.y, button: 0 });
    router.pointerUp({ x: p.x, y: p.y, button: 0 });
  },
  onChange: (tree) => {
    a11yText = outlineOf(tree).join("\n");
    chrome?.setText("a11y", a11yText);
  },
});
let a11yText = "";
/** The view and canvas size the renderer last had, so it redraws everything only when they change. */
let viewKey = "";
const makeRenderer = (): void => {
  renderer.dispose();
  renderer = new Renderer(scene, ctx, { images: (src) => images.get(src), ...(settings.lod ? {} : { lod: false }) });
  viewKey = "";
};
/** Set when a wheel on the board reaches the end of its path unclaimed, so it zooms. */
let wheelFree = false;
/** The ten-million-point chart, once added. */
let points: TenMillionPoints | null = null;
let galaxy: StarsAndPlanets | null = null;
/** The million-row table, once added. */
let table: MillionRows | null = null;
/** Interactive objects (the note, the controls), drawn from their state. */
let components: Components | null = null;
/** Selected objects (outermost groups, or single ops picked with Alt), in the order picked. */
let selected: string[] = [];
let hovered: string | null = null;
/** The op under the pointer and its groups, innermost first, for chart tooltips. */
let hoverPath: readonly string[] = [];
/** A chart's datum under the pointer, drawn on the overlay next to it. */
let tooltip: { text: string; x: number; y: number } | null = null;
const showTooltip = (screen: { x: number; y: number }): void => {
  const text = hoverPath.length > 0 && !tools.drawing ? datumAt(scene, hoverPath, router.toWorld(screen)) : null;
  const next = text === null ? null : { text, x: screen.x + 14, y: screen.y + 14 };
  if (next?.text === tooltip?.text && next?.x === tooltip?.x && next?.y === tooltip?.y) return;
  tooltip = next;
  render();
};
/** While dragging objects: what moves, their snap anchors where the drag began, and how far they've moved. */
let drag: { ids: string[]; anchors: { x: number; y: number }[]; moved: { x: number; y: number } } | null = null;
/** The snap target shown while dragging. */
let snapMark: { x: number; y: number; kind: string } | null = null;
/** While lassoing (Shift-drag on empty space): the outline so far, in world space. */
let lasso: { x: number; y: number }[] | null = null;
/** While panning empty space: the last pointer position, in host pixels. */
let panFrom: { x: number; y: number } | null = null;
/** A physics body or graph node being dragged: it follows the pointer through its simulation, not by moving its ops. */
let grabbed: "physics" | "graph" | null = null;

/** What a click or drag acts on: the outermost group around the op, or the op itself with Alt held. */
const objectOf = (e: RouterEvent): string | null => {
  if (e.target === null) return null;
  if ("altKey" in e.input && e.input.altKey) return e.target;
  return e.path[e.path.length - 1] ?? e.target;
};

let logLines: string[] = [];
const log = (line: string): void => {
  logLines = [line, ...logLines].slice(0, 200);
  chrome?.setText("log", logLines.join("\n"));
};

const describe = (id: string): string => {
  const group = scene.getGroup(id);
  const lines: string[] = [];
  if (group) {
    lines.push(`group ${id}`);
    if (group.meta) lines.push(`meta ${JSON.stringify(group.meta)}`);
    lines.push(`${scene.groupOps(id).length} ops`);
  } else {
    const op = scene.get(id)!;
    lines.push(`${op.kind} op ${id}`);
    if (op.kind === "text") lines.push(`"${op.text}"`);
  }
  const chain = scene.groupChain(id);
  if (chain.length > 0) lines.push(`inside ${chain.join(" < ")}`);
  const b = scene.bounds(id);
  if (b) lines.push(`bounds ${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.width.toFixed(1)} × ${b.height.toFixed(1)}`);
  return lines.join("\n");
};

const parentOf = (live: LiveText): string => (live.settings as LiveSpec).parent;

/** After `moved` moved by (dx, dy): containers inside it follow, and text whose obstacles moved is laid out again. */
const followMove = (moved: string, dx: number, dy: number): void => {
  const inside = (id: string) => id === moved || scene.groupChain(id).includes(moved);
  for (const live of liveTexts) {
    if (inside(parentOf(live))) live.translate(dx, dy);
    else if (live.dependsOn(moved)) live.update();
  }
  if (table?.alive && inside(TABLE_ID)) table.moved(dx, dy);
  if (points?.alive && inside(POINTS_ID)) points.moved(dx, dy);
  if (galaxy?.alive && inside(GALAXY_ID)) galaxy.moved(dx, dy);
};

let stepped = false;
const render = (): void => {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = stage.getBoundingClientRect();
  for (const c of [canvas, cardCanvas, overlay]) {
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
  }
  const device = multiply({ a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 }, view);
  // The board redraws only what changed since the last frame; selection marks go on the overlay, redrawn whole.
  const key = `${canvas.width}x${canvas.height} ${Object.values(device).join(",")}`;
  if (key !== viewKey) {
    renderer.setView(device, canvas.width, canvas.height);
    embeds.setView(view);
    a11y.setView(view);
    cards.setView(view, device);
    viewKey = key;
  }
  const start = performance.now();
  // While devtools steps through the ops, it draws the board itself; the renderer starts over afterwards.
  if (devtools.drawBoard(canvas.getContext("2d")!, device)) stepped = true;
  else if (stepped) {
    stepped = false;
    renderer.invalidate();
  }
  const stats = stepped ? ({ mode: "idle", ops: 0, rects: [] } as const) : renderer.render();
  if (stats.mode !== "idle") {
    const ms = performance.now() - start;
    chrome?.setText("render-stats", `${stats.mode} redraw: ${stats.ops} of ${scene.document.ops.length} ops in ${ms.toFixed(1)} ms${stats.rects.length > 0 ? `, ${stats.rects.length} rect${stats.rects.length > 1 ? "s" : ""}` : ""}`);
  }
  const ctx = octx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Outlines, drawn in device pixels so they stay thin at any zoom.
  const outline = (id: string, color: string, dash: number[]): void => {
    const b = scene.bounds(id);
    if (!b) return;
    const p = applyToPoint(device, b.x, b.y);
    const q = applyToPoint(device, b.x + b.width, b.y + b.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash(dash.map((d) => d * dpr));
    ctx.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, Math.round(q.x - p.x), Math.round(q.y - p.y));
  };
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim();
  if (hovered && !selected.includes(hovered)) outline(hovered, style.getPropertyValue("--hover").trim(), [4, 3]);
  for (const id of selected) outline(id, accent, []);
  ctx.setLineDash([]);
  if (lasso && lasso.length > 1) {
    ctx.beginPath();
    for (const p of lasso) {
      const q = applyToPoint(device, p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = dpr;
    ctx.stroke();
  }
  devtools.preview(octx, device, dpr);
  tools.preview(octx, device, dpr);
  if (snapMark) {
    const q = applyToPoint(device, snapMark.x, snapMark.y);
    const r = 6 * dpr;
    ctx.strokeStyle = "#e11d48";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(q.x - r, q.y - r);
    ctx.lineTo(q.x + r, q.y + r);
    ctx.moveTo(q.x + r, q.y - r);
    ctx.lineTo(q.x - r, q.y + r);
    ctx.stroke();
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = "#e11d48";
    ctx.fillText(snapMark.kind, q.x + r + 2 * dpr, q.y - r);
  }
  if (tooltip) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "12px system-ui, sans-serif";
    const lines = tooltip.text.split("\n");
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const h = lines.length * 16 + 8;
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.roundRect(tooltip.x, tooltip.y, w, h, 4);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, tooltip!.x + 8, tooltip!.y + 5 + i * 16));
  }
};

const showSelection = (): void => {
  chrome?.setText(
    "selection",
    selected.length === 0
      ? "Click something on the board."
      : selected.length === 1
        ? describe(selected[0]!)
        : `${selected.length} objects\n${selected.join(", ")}`,
  );
  if (selected.length === 1) devtools.show(selected[0]!);
};

const select = (ids: string[]): void => {
  selected = ids;
  showSelection();
  render();
};

const shiftHeld = (e: RouterEvent): boolean => "shiftKey" in e.input && e.input.shiftKey === true;
const snapping = (e: RouterEvent): boolean => !("ctrlKey" in e.input && (e.input.ctrlKey || e.input.metaKey));

const KIND_GROUPS: Record<string, readonly SnapKind[]> = {
  points: ["vertex", "intersection", "center", "midpoint", "extreme", "baseline"],
  bounds: ["bounds"],
  path: ["path"],
};
const snapKinds = (): SnapKind[] => [...settings.snapKinds].flatMap((k) => KIND_GROUPS[k] ?? []);

/** Moves the dragged objects so that, if one of their anchors lands near another object's snap point, it lands on it. */
const dragTo = (total: { x: number; y: number }, snap: boolean): void => {
  if (!drag) return;
  let target = total;
  snapMark = null;
  const kinds = snapKinds();
  if (snap && settings.snapOn && kinds.length > 0) {
    const radius = settings.snapRadius / Math.hypot(view.a, view.b);
    // Text laid out against what moves moves with it: snapping to it would chase a moving target.
    const exclude = [...drag.ids, ...liveTexts.filter((l) => drag!.ids.some((id) => l.dependsOn(id))).map((l) => l.id)];
    const filter = settings.snapText ? undefined : (op: { kind: string }) => op.kind !== "text";
    let best: { dx: number; dy: number; distance: number; x: number; y: number; kind: string } | null = null;
    for (const a of drag.anchors) {
      const p = { x: a.x + total.x, y: a.y + total.y };
      const found = scene.snap(p, { radius, kinds, exclude, ...(filter ? { filter } : {}) });
      if (found && (!best || found.distance < best.distance)) {
        best = { dx: found.point.x - p.x, dy: found.point.y - p.y, distance: found.distance, x: found.point.x, y: found.point.y, kind: found.kind };
      }
    }
    if (best) {
      target = { x: total.x + best.dx, y: total.y + best.dy };
      snapMark = { x: best.x, y: best.y, kind: best.kind };
    }
  }
  const step = { x: target.x - drag.moved.x, y: target.y - drag.moved.y };
  if (step.x === 0 && step.y === 0) return;
  for (const id of drag.ids) {
    components!.move(id, { a: 1, b: 0, c: 0, d: 1, e: step.x, f: step.y });
    followMove(id, step.x, step.y);
  }
  drag.moved = target;
};

const wire = (): void => {
  router = new EventRouter(scene, { view, tolerance: 3 });
  devtools.attach(scene);
  embeds.setScene(scene);
  a11y.setScene(scene);
  makeRenderer();
  if (components) components.bind(scene, router);
  else {
    components = new Components(scene, router, {
      recorder: recorderOptions,
      onChange: () => {
        if (!overCards) canvas.style.cursor = boardCursor();
        render();
      },
    });
  }
  if (table?.alive) table.bind(scene, router);
  if (points?.alive) points.bind(scene, router);
  if (galaxy?.alive) galaxy.bind(scene, router);
  router.on("*", "wheel", () => {
    wheelFree = true;
  });
  router.on("*", "enter", (e) => {
    hoverPath = e.path;
    // Over an embed, the pointer goes to its element (a form, a WebGL view); with Alt held, the board keeps it, to drag the embed.
    if (e.op?.kind === "embed" && !drag && !tools.drawing && !("altKey" in e.input && e.input.altKey)) embeds.passThrough(e.op.id);
    hovered = objectOf(e);
    render();
  });
  router.on("*", "leave", () => {
    // An enter for whatever is under the pointer now follows, if anything is.
    hovered = null;
    hoverPath = [];
    render();
  });
  router.on("*", "click", (e) => {
    const id = objectOf(e);
    if (shiftHeld(e)) select(id === null ? selected : selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    else select(id === null ? [] : [id]);
    log(`click ${e.target ?? "empty space"}${e.path.length > 1 ? ` in ${e.path.slice(1).join(" < ")}` : ""}`);
  });
  router.on("*", "dragstart", (e) => {
    // A body or node is dragged through its simulation, so it keeps colliding or pulling on its links.
    const parts = e.target === null ? [] : [e.target, ...e.path];
    const body = sandbox && scene.getGroup(PHYSICS_ID) ? parts.find((p) => sandbox!.physics.body(p)?.isDynamic()) : undefined;
    if (body && sandbox!.physics.grab(body, e.point)) {
      grabbed = "physics";
      runPhysics();
      return;
    }
    const node = graph && scene.getGroup(GRAPH_ID) ? parts.find((p) => graph!.nodeOf(p)) : undefined;
    if (node) {
      graph!.grab(node, e.point);
      grabbed = "graph";
      return;
    }
    const id = objectOf(e);
    if (id === null) {
      if (shiftHeld(e)) lasso = [router.toWorld(e.screen)];
      else panFrom = e.screen;
      return;
    }
    // Dragging a selected object moves the whole selection.
    const ids = selected.includes(id) ? selected : [id];
    if (!selected.includes(id)) select([id]);
    // Bounds points and vertices are what usually lines up; keep the list short so each move stays cheap.
    const anchors = ids
      .flatMap((i) => scene.anchors(i).filter((a) => a.kind === "bounds" || (a.kind === "vertex" && ids.length === 1)))
      .slice(0, 120)
      .map((a) => a.point);
    drag = { ids, anchors, moved: { x: 0, y: 0 } };
    // What is below and above the dragged objects is cached, so each frame draws two bitmaps and them.
    renderer.lift(ids);
    log(`drag ${ids.join(", ")}`);
  });
  router.on("*", "drag", (e) => {
    if (grabbed === "physics") sandbox?.physics.drag(e.point);
    if (grabbed === "graph") graph?.drag(e.point);
    if (grabbed) return;
    if (drag) {
      dragTo(e.total!, snapping(e));
      showSelection();
    } else if (lasso) {
      lasso.push(router.toWorld(e.screen));
    } else if (panFrom) {
      // Pan by the pointer's movement in host pixels; world-space deltas shift as the view moves.
      const d = { x: e.screen.x - panFrom.x, y: e.screen.y - panFrom.y };
      panFrom = e.screen;
      setView(multiply({ a: 1, b: 0, c: 0, d: 1, e: d.x, f: d.y }, view));
      return;
    }
    render();
  });
  router.on("*", "dragend", () => {
    if (grabbed === "physics") sandbox?.physics.release();
    if (grabbed === "graph") graph?.release();
    grabbed = null;
    if (lasso && lasso.length > 2) {
      // Select the outermost object of every op the lasso touches.
      const picked = new Set<string>();
      for (const opId of scene.queryPolygon(lasso)) picked.add(scene.groupChain(opId).at(-1) ?? opId);
      select([...picked]);
      log(`lasso picked ${picked.size}`);
    }
    drag = null;
    renderer.drop();
    lasso = null;
    snapMark = null;
    panFrom = null;
    render();
  });
  router.on("*", "keydown", (e) => {
    const key = (e.input as { key: string }).key;
    if ((key === "Delete" || key === "Backspace") && selected.length > 0) {
      log(`remove ${selected.join(", ")}`);
      for (const id of selected) if (scene.get(id) || scene.getGroup(id)) scene.remove(id);
      for (const id of components!.ids) if (!scene.getGroup(id)) components!.unmount(id);
      liveTexts = liveTexts.filter((live) => scene.getGroup(parentOf(live)));
      for (const live of liveTexts) live.update();
      hovered = null;
      select([]);
    }
  });
};

const setView = (next: Matrix2D): void => {
  view = next;
  router.setView(view);
  points?.zoomed();
  galaxy?.zoomed();
  render();
};

const point = (e: MouseEvent): { x: number; y: number } => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const pointer = (e: PointerEvent) => ({ ...point(e), button: e.button, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });

// The cards get the pointer where they are; the board gets it everywhere else, and keeps a press it began.
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  // Keeps focus where it is, so the text tool's hidden textarea keeps the keyboard.
  e.preventDefault();
  textSink().release();
  if (cards.hits(point(e))) {
    cardPress = true;
    keysToCards = true;
    cards.router.pointerDown(pointer(e));
    return;
  }
  keysToCards = false;
  boardPress = true;
  // A drawing tool takes the press; the select tool hands it to the router.
  if (tools.down(point(e), e.shiftKey)) return;
  router.pointerDown(pointer(e));
});
canvas.addEventListener("pointermove", (e) => {
  if (cardPress) {
    cards.router.pointerMove(pointer(e));
    return;
  }
  if (!boardPress && cards.hits(point(e))) {
    if (!overCards) {
      router.pointerLeave(pointer(e));
      tooltip = null;
      render();
    }
    overCards = true;
    cards.router.pointerMove(pointer(e));
    canvas.style.cursor = cards.components.cursor ?? "default";
    return;
  }
  if (overCards) {
    cards.router.pointerLeave(pointer(e));
    overCards = false;
    canvas.style.cursor = boardCursor();
  }
  if (tools.drawing) tools.move(point(e), e.shiftKey);
  else router.pointerMove(pointer(e));
  showTooltip(point(e));
});
canvas.addEventListener("pointerup", (e) => {
  if (cardPress) {
    cardPress = false;
    cards.router.pointerUp(pointer(e));
    return;
  }
  boardPress = false;
  if (tools.drawing) tools.up();
  else router.pointerUp(pointer(e));
});
canvas.addEventListener("pointercancel", () => {
  cardPress = false;
  boardPress = false;
  cards.router.pointerCancel();
  router.pointerCancel();
});
canvas.addEventListener("pointerleave", (e) => {
  overCards = false;
  cards.router.pointerLeave(pointer(e));
  router.pointerLeave(pointer(e));
  tooltip = null;
  render();
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = point(e);
    // A card or anything on the board that scrolls (the million rows) keeps the wheel; anywhere else it zooms the board.
    const input = { ...p, deltaX: e.deltaX, deltaY: e.deltaY, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
    if (cards.hits(p) && cards.wheel(input)) return;
    wheelFree = false;
    router.wheel(input);
    if (!wheelFree) return;
    const k = Math.exp(-e.deltaY * 0.0015);
    setView(multiply({ a: k, b: 0, c: 0, d: k, e: p.x - k * p.x, f: p.y - k * p.y }, view));
  },
  { passive: false },
);
const TOOL_KEYS: Record<string, ToolName> = { v: "select", p: "pen", r: "rect", o: "ellipse", t: "text" };
const useTool = (name: ToolName): void => {
  tools.cancel();
  tools.current = name;
  chrome?.setTool(name);
  canvas.style.cursor = boardCursor();
  render();
};
window.addEventListener("keydown", (e) => {
  // Typing in a text field goes through its hidden textarea, which keeps its keys.
  if (textSink().active) return;
  const keys = { key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  if (keysToCards) {
    if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
    cards.router.keyDown(keys);
    return;
  }
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) {
    useTool(tool);
    return;
  }
  if (e.key === "Escape" && tools.current !== "select") {
    useTool("select");
    return;
  }
  router.keyDown({ key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
});
new ResizeObserver(render).observe(stage);

const tools = new Tools({
  scene: () => scene,
  toWorld: (screen) => router.toWorld(screen),
  pixel: () => 1 / Math.hypot(view.a, view.b),
  snap: (world) => {
    const kinds = snapKinds();
    if (!settings.snapOn || kinds.length === 0) return null;
    const found = scene.snap(world, { radius: settings.snapRadius / Math.hypot(view.a, view.b), kinds });
    return found ? { point: found.point, kind: found.kind } : null;
  },
  commit: (id, draw) => {
    const recorder = new RecordingContext(recorderOptions);
    recorder.beginGroup({ id, meta: { source: "drawn" } });
    draw(recorder);
    recorder.endGroup();
    const drawn = recorder.getSources();
    const doc = recorder.getDocument();
    scene.replaceGroup(id, doc).forEach((opId, i) => {
      const source = drawn.get(doc.ops[i]!.id);
      if (source !== undefined) sources.set(opId, source);
    });
    select([id]);
  },
  recorder: recorderOptions,
  stage,
  redraw: () => render(),
  log: (line) => log(line),
});

const devtools = new Devtools({
  scene: () => scene,
  sources,
  select: (id) => select([id]),
  redraw: () => render(),
  images: (src) => images.get(src),
});

/** Texts that flow around shapes: the ones the controls change. */
const wrapped = (): LiveText[] => liveTexts.filter((l) => (l.settings.obstacles?.length ?? 0) > 0);
const hooks: ControlHooks = {
  setMargin: (px) => {
    for (const l of wrapped()) l.set({ obstacleMargin: px });
    render();
  },
  setSize: (px) => {
    for (const l of wrapped()) l.set({ theme: { ...l.settings.theme, fontSize: px } });
    render();
  },
  openLink: (href) => {
    log(`open link ${href}`);
    window.open(href, "_blank", "noopener");
  },
  get: (id) => components?.get(id),
};

/** How many times each sample was added from its icon, so copies step aside from each other. */
const copies = new Map<string, number>();

/**
 * Draws more onto the board: the current document is replayed into a new
 * recorder, then the sample is drawn after it. Added from an icon, it is
 * moved to the right of `near`, as a drag would move it.
 */
const add = async (sample: Sample, near?: { x: number; y: number }): Promise<void> => {
  const recorder = new RecordingContext(recorderOptions);
  const before = scene.document.ops;
  replayDocument(recorder, scene.document, { images: (src) => images.get(src) });
  if ("svg" in sample) {
    recorder.beginGroup({ meta: { source: sample.name } });
    const canvg = Canvg.fromString(recorder as unknown as CanvasRenderingContext2D, sample.svg, {
      ignoreDimensions: true,
      ignoreClear: true,
      ignoreMouse: true,
      ignoreAnimation: true,
      offsetX: sample.at.x,
      offsetY: sample.at.y,
    });
    await canvg.render();
    recorder.endGroup();
  }
  const drawn = "svg" in sample ? undefined : sample.draw(recorder, hooks);
  // Replayed ops keep the source of the op they copy; new ones get the recorder's.
  const document = recorder.getDocument();
  const recorded = recorder.getSources();
  const kept = new Map<string, string>();
  document.ops.forEach((op, i) => {
    const old = i < before.length && before.length <= document.ops.length ? before[i] : undefined;
    const source = old ? sources.get(old.id) : recorded.get(op.id);
    if (source !== undefined) kept.set(op.id, source);
  });
  sources.clear();
  for (const [id, source] of kept) sources.set(id, source);
  scene = new Scene(document);
  wire();
  // Texts and components already on the board were replayed with it; bind them to the new scene.
  liveTexts = liveTexts.map((l) => new LiveText(scene, l.settings));
  for (const spec of drawn?.live ?? []) {
    const l = new LiveText(scene, { ...spec, meta: { source: "live text" } });
    l.update();
    liveTexts.push(l);
  }
  for (const spec of drawn?.components ?? []) components!.mount(spec);
  log(`added ${sample.name}; the board has ${scene.document.ops.length} ops`);
  const added = scene.document.ops.slice(before.length).map((op) => op.id);
  let box = boxOf(added);
  if (near && box) {
    const n = copies.get(sample.name) ?? 0;
    copies.set(sample.name, n + 1);
    const dx = near.x + ICON_REACH + n * 36 - box.x;
    const dy = near.y + n * 36 - box.y;
    // Each new outermost group moves as one, with what is laid out against it.
    for (const id of new Set(added.map((op) => scene.groupChain(op).at(-1) ?? op))) {
      components!.move(id, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
      followMove(id, dx, dy);
    }
    box = { ...box, x: box.x + dx, y: box.y + dy };
  }
  render();
  if (box && !initial) reveal(box);
};

/** The world box around some ops. */
const boxOf = (ids: readonly string[]): { x: number; y: number; width: number; height: number } | null => {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const id of ids) {
    const b = scene.bounds(id);
    if (!b) continue;
    box = box
      ? { minX: Math.min(box.minX, b.x), minY: Math.min(box.minY, b.y), maxX: Math.max(box.maxX, b.x + b.width), maxY: Math.max(box.maxY, b.y + b.height) }
      : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
  }
  return box && { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
};
let initial = true;

const download = (name: string, type: string, text: string): void => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** Draws pasted SVG markup into the board. */
const addSvg = (text: string): void => {
  const svg = text.trim();
  if (!svg.includes("<svg")) {
    log("paste SVG markup: what was pasted has no <svg>");
    return;
  }
  void add({ name: "pasted SVG", svg, at: { x: 40, y: 40 } }).catch((error) => log(`could not draw it: ${error}`));
};
window.addEventListener("paste", (e) => {
  if (textSink().active) return;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (text.includes("<svg")) {
    e.preventDefault();
    addSvg(text);
  }
});
const pasteSvg = (): void => {
  navigator.clipboard
    .readText()
    .then(addSvg)
    .catch(() => log("the browser didn't let the page read the clipboard: press Ctrl+V (⌘V) instead"));
};
const exportSvg = (): void => {
  const b = stage.getBoundingClientRect();
  download("board.svg", "image/svg+xml", toSVG(scene.document, { width: Math.round(b.width), height: Math.round(b.height) }));
};
const vectorizeSelection = (): void => {
  // Images in the selection become fills, one per color, drawn where the image was.
  const ops = selected.flatMap((id) => (scene.getGroup(id) ? scene.groupOps(id) : [id])).map((id) => scene.get(id)).filter((op): op is ImageOp => op?.kind === "image");
  if (ops.length === 0) {
    log("select an image to vectorize, such as the orange sticker");
    return;
  }
  for (const op of ops) {
    const img = images.get(op.image.src);
    if (!img) continue;
    const { width, height } = op.image;
    const pixels = new OffscreenCanvas(width, height).getContext("2d")!;
    pixels.drawImage(img, 0, 0, width, height);
    const result = vectorize(pixels.getImageData(0, 0, width, height), { curves: true });
    const at = scene.document.ops.findIndex((o) => o.id === op.id);
    scene.remove(op.id);
    result.document.ops.forEach((fill, i) => {
      const { group: _, ...rest } = transformOp(fill, imageToWorld(op));
      scene.insert({ ...rest, id: `${op.id}/v${i}`, ...(op.group !== undefined ? { group: op.group } : {}), ...(op.clip ? { clip: op.clip } : {}) } as Op, at + i);
    });
    log(`vectorized ${op.id}: ${result.palette.length} colors, ${result.rings} rings, ${result.points} points`);
  }
  for (const live of liveTexts) live.update();
  showSelection();
  render();
};

/** The view that shows the cards and the drawing on the board, at most at full size. */
const home = (): Matrix2D => {
  let box = cards.bounds();
  for (const op of scene.document.ops) {
    const b = scene.bounds(op.id);
    if (!b || !box) {
      box ??= b;
      continue;
    }
    const x = Math.min(box.x, b.x);
    const y = Math.min(box.y, b.y);
    box = { x, y, width: Math.max(box.x + box.width, b.x + b.width) - x, height: Math.max(box.y + box.height, b.y + b.height) - y };
  }
  if (!box) return IDENTITY;
  const { width, height } = stage.getBoundingClientRect();
  const k = Math.min(1, (width - 48) / box.width, (height - 48) / box.height);
  return { a: k, b: 0, c: 0, d: k, e: (width - box.width * k) / 2 - box.x * k, f: Math.max(24, (height - box.height * k) / 2) - box.y * k };
};

/** Glides the view from where it is to `to`, zooming out and back in on the way when the move is long. */
let flight = 0;
const flyTo = (to: Matrix2D): void => {
  const from = view;
  const run = ++flight;
  const { width, height } = stage.getBoundingClientRect();
  // The world points at the center of the screen, and the zooms, at both ends.
  const center = (m: Matrix2D) => ({ x: (width / 2 - m.e) / m.a, y: (height / 2 - m.f) / m.d });
  const c0 = center(from);
  const c1 = center(to);
  const k0 = Math.log(from.a);
  const k1 = Math.log(to.a);
  // Far apart, the view backs out so both ends are in sight midway.
  const span = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  const out = Math.min(k0, k1, Math.log(Math.max(0.05, Math.min(width, height) / Math.max(1, span * 1.4))));
  const start = performance.now();
  const ms = 450 + Math.min(450, span / 8);
  const frame = (now: number): void => {
    if (run !== flight) return;
    const t = Math.min(1, (now - start) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const bump = Math.min(k0, k1) - out;
    const k = Math.exp(k0 + (k1 - k0) * e - bump * Math.sin(Math.PI * e));
    const x = c0.x + (c1.x - c0.x) * e;
    const y = c0.y + (c1.y - c0.y) * e;
    setView({ a: k, b: 0, c: 0, d: k, e: width / 2 - k * x, f: height / 2 - k * y });
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

/** Flies to a world rect, fitting it on the screen at most at full size. */
const reveal = (b: { x: number; y: number; width: number; height: number }): void => {
  const { width, height } = stage.getBoundingClientRect();
  const k = Math.min(1, (width - 120) / b.width, (height - 120) / b.height);
  flyTo({ a: k, b: 0, c: 0, d: k, e: width / 2 - k * (b.x + b.width / 2), f: height / 2 - k * (b.y + b.height / 2) });
};

// The morph demo: day and night drawn apart, blended by controls drawn on the board under them.
const morphTo = (t: number): void => {
  scene.replaceGroup(MORPH_ID, dayToNight().at(t));
  render();
};
const morphDemo = (): void => {
  if (scene.getGroup(MORPH_ID) === undefined) {
    morphTo(0);
    const m = dayToNight();
    log(`morph demo: ${m.paired} ops paired by their groups' names, ${m.removed} fading out, ${m.added} fading in`);
  }
  for (const spec of morphControls(morphTo, (id) => components?.get(id))) if (!components!.get(spec.id)) components!.mount(spec);
  const b = scene.bounds(MORPH_ID)!;
  reveal({ ...b, height: b.height + 70 });
};

// The pelican on its bicycle: poses drawn an eighth of a pedal turn apart, morphed into every frame between.
const PELICAN_AT = { x: 1850, y: -40 };
const ride = new Ride(PELICAN_AT);
let position = 0;
let riding = 0;
const rideTo = (p: number): void => {
  position = p;
  scene.replaceGroup(PELICAN_ID, ride.frame(p));
  render();
};
const stopRiding = (): void => {
  riding++;
  components?.get<{ riding: boolean }>("pelican-ride")?.setState({ riding: false });
};
const startRiding = (): void => {
  const run = ++riding;
  components?.get<{ riding: boolean }>("pelican-ride")?.setState({ riding: true });
  let last = performance.now();
  const frame = (now: number): void => {
    // Stop when this run was stopped or the pelican was deleted.
    if (run !== riding || scene.getGroup(PELICAN_ID) === undefined) return;
    // A pedal turn every 1.1 s.
    rideTo(position + ((now - last) / 1100) * POSES_PER_TURN);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
const pelicanDemo = (): void => {
  if (scene.getGroup(PELICAN_ID) === undefined) rideTo(0);
  if (!components!.get("pelican-ride")) {
    components!.mount(rideButton(PELICAN_AT, () => (components?.get<{ riding: boolean }>("pelican-ride")?.state.riding ? stopRiding() : startRiding())));
  }
  const b = scene.bounds(PELICAN_ID)!;
  reveal({ ...b, height: b.height + 50 });
  startRiding();
  const stats = ride.stats;
  if (stats) log(`pelican: each frame morphs ${stats.paired} ops between two drawn poses`);
};

// Physics: bodies drawn as canvas code, simulated by planck.js, moved by live transforms.
let sandbox: Sandbox | null = null;
let physicsRun = 0;
const runPhysics = (): void => {
  if (physicsRun > 0) return;
  physicsRun = 1;
  let last = performance.now();
  const frame = (now: number): void => {
    if (!sandbox || !scene.getGroup(PHYSICS_ID)) {
      physicsRun = 0;
      return;
    }
    // A board replayed into a new scene (after adding a sample) holds the bodies where they are now.
    if (sandbox.physics.scene !== scene) sandbox.physics.rebind(scene);
    sandbox.physics.step((now - last) / 1000);
    last = now;
    render();
    // Asleep and not held: stop until something wakes it.
    const awake = sandbox.physics.bodies.some((id) => {
      const body = sandbox!.physics.body(id)!;
      return body.isDynamic() && body.isAwake();
    });
    if (!awake && grabbed !== "physics") {
      physicsRun = 0;
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
const physicsDemo = (): void => {
  if (!sandbox || !scene.getGroup(PHYSICS_ID)) {
    if (sandbox) sandbox = null;
    sandbox = createSandbox(scene);
    log(`physics: ${sandbox.physics.bodies.length} bodies, colliders read off their drawings (boxes, circles, hulls, outlines)`);
  }
  const count = (): number => sandbox!.physics.bodies.filter((id) => sandbox!.physics.body(id)!.isDynamic()).length;
  if (!components!.get("physics-drop")) {
    components!.mount(
      sandboxButton(() => {
        if (sandbox!.physics.scene !== scene) sandbox!.physics.rebind(scene);
        sandbox!.drop(6);
        components?.get<{ bodies: number }>("physics-drop")?.setState({ bodies: count() });
        runPhysics();
      }),
    );
  }
  components?.get<{ bodies: number }>("physics-drop")?.setState({ bodies: count() });
  const b = scene.bounds(PHYSICS_ID)!;
  reveal({ ...b, height: b.height + 50 });
  runPhysics();
};

// A force-directed graph: d3-force moves the nodes, each drawn once.
let graph: ForceGraph | null = null;
const graphDemo = (): void => {
  if (!graph || !scene.getGroup(GRAPH_ID)) {
    graph?.stop();
    let frames = 0;
    graph = createGraph(
      () => scene,
      () => {
        // Show the cost now and then; every tick would redraw the caption too.
        if (frames++ % 20 === 0) components?.get<{ ms: number }>("graph-shake")?.setState({ ms: graph?.stats.ms ?? 0 });
        render();
      },
    );
  }
  if (!components!.get("graph-shake")) components!.mount(graphButton(() => graph?.simulation.alpha(1).restart()));
  const b = scene.bounds(GRAPH_ID)!;
  reveal({ ...b, height: b.height + 50 });
};

// Paint by numbers: a painting, or a picture of yours, vectorized into regions with shared borders.
const showPaint = (source: PaintSource): void => {
  if (components!.get(PAINT_ID)) components!.unmount(PAINT_ID);
  const t0 = performance.now();
  components!.mount(paintComponent(source));
  log(`paint by numbers: ${source.name}, ${source.canvas.width}×${source.canvas.height}, vectorized and drawn in ${(performance.now() - t0).toFixed(0)} ms`);
  reveal(scene.bounds(PAINT_ID)!);
};
// A picture comes from the file dialog (an input never shown) or is dropped on the board.
const paintPicture = (file: File): void => {
  createImageBitmap(file)
    .then((bitmap) => showPaint(pictureSource(file.name, bitmap)))
    .catch((error) => log(`could not read ${file.name}: ${error}`));
};
const pictureInput = document.createElement("input");
pictureInput.type = "file";
pictureInput.accept = "image/*";
pictureInput.hidden = true;
pictureInput.addEventListener("change", () => {
  const file = pictureInput.files?.[0];
  pictureInput.value = "";
  if (file) paintPicture(file);
});
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
  if (file) paintPicture(file);
});

// A million rows: a table whose body records only the rows that show.
const tableDemo = (): void => {
  if (!table?.alive) table = new MillionRows(scene, router, { components: () => components!, render: () => render(), log });
  reveal(table.bounds);
};

// Ten million points: a chart whose plot draws a bar per pixel, a line or dots, by how many readings share a pixel.
const pointsDemo = (): void => {
  if (!points?.alive) points = new TenMillionPoints(scene, router, { components: () => components!, zoom: () => Math.hypot(view.a, view.b), render: () => render(), log });
  reveal(points.bounds);
};

// Stars and planets: a galaxy made region by region as you look, from the whole of it down to a planet's face.
const galaxyDemo = (): void => {
  if (!galaxy?.alive) galaxy = new StarsAndPlanets(scene, router, { components: () => components!, zoom: () => Math.hypot(view.a, view.b), render: () => render(), log, recorder: { ...recorderOptions, captureSource: false } });
  reveal(galaxy.bounds);
};

// Every feature is an icon somewhere on the board; what it adds goes to its right.
const DEMO = (at: { x: number; y: number }) => ({ x: at.x - ICON_REACH, y: at.y });
const sampleNamed = (name: string): Sample => samples.find((sample) => sample.name === name)!;
const features: Feature[] = [
  { id: "pelican", name: "Pelican", glyph: "pelican", ...DEMO(PELICAN_AT), tilt: -6, onClick: pelicanDemo },
  { id: "physics", name: "Physics", glyph: "physics", ...DEMO(PHYSICS_AT), tilt: 5, onClick: physicsDemo },
  { id: "graph", name: "Graph", glyph: "graph", ...DEMO(GRAPH_AT), tilt: -4, onClick: graphDemo },
  { id: "morph", name: "Morph", glyph: "morph", ...DEMO(MORPH_AT), tilt: 7, onClick: morphDemo },
  { id: "paint", name: "Paint by numbers", glyph: "paint", ...DEMO(PAINT_AT), tilt: -5, onClick: () => showPaint(paintingSource()) },
  { id: "table", name: "A million rows", glyph: "table", ...DEMO(TABLE_AT), tilt: -3, onClick: tableDemo },
  { id: "points", name: "Ten million points", glyph: "points", ...DEMO(POINTS_AT), tilt: 5, onClick: pointsDemo },
  { id: "galaxy", name: "Stars and planets", glyph: "galaxy", ...DEMO(GALAXY_AT), tilt: -4, onClick: galaxyDemo },
  { id: "picture", name: "Paint my image…", glyph: "picture", x: PAINT_AT.x - ICON_REACH, y: PAINT_AT.y + 240, tilt: 4, onClick: () => pictureInput.click() },
  ...(
    [
      ["Badge", "badge", -650, -720, 6],
      ["Chart", "chart", 0, -780, -7],
      ["Star", "star", 800, -700, 9],
      ["Text block", "text", 1300, -760, -3],
      ["Text around shapes", "wrap", 2050, -720, 5],
      ["Text in a circle", "circle", 2800, -760, -6],
      ["Canvas shapes", "shapes", 2650, 40, 4],
      ["Controls", "controls", 1700, 560, -8],
      ["Chart.js chart", "chartjs", 2650, 620, 6],
      ["D3 chart", "d3", 2300, 1080, -5],
      ["HTML and 3D", "embed", 1000, 1900, 3],
      ["10,000 shapes", "many", 2000, 1850, -4],
    ] as const
  ).map(([name, glyph, x, y, tilt]): Feature => ({ id: glyph, name, glyph, x, y, tilt, onClick: () => void add(sampleNamed(name), { x, y }) })),
];
for (const f of features) cards.components.mount(featureIcon(f, () => cards.colors));

// The controls: the playground and inspector cards.
chrome = new Chrome(cards, {
  tools: [
    { name: "select", text: "Select", key: "V" },
    { name: "pen", text: "Pen", key: "P" },
    { name: "rect", text: "Rectangle", key: "R" },
    { name: "ellipse", text: "Ellipse", key: "O" },
    { name: "text", text: "Text", key: "T" },
  ],
  onTool: (name) => useTool(name),
  actions: [
    { text: "Play Pelican Ride", look: "accent", onClick: () => location.assign("./game.html") },
    { text: "Vectorize image", onClick: vectorizeSelection, title: "select an image, such as the orange sticker, first" },
    { text: "Export SVG", onClick: exportSvg },
    { text: "Export JSON", onClick: () => download("board.json", "application/json", serializeDocument(scene.document)) },
    { text: "Fit the board", onClick: () => setView(home()) },
  ],
  style: tools.style,
  settings,
  onLod: () => {
    makeRenderer();
    render();
  },
  devtools,
  pasteSvg,
});
chrome.setText("log", logLines.join("\n"));
chrome.setText("a11y", a11yText);
showSelection();

for (const sample of initialSamples) await add(sample);
initial = false;
setView(home());
