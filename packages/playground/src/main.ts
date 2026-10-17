// The playground: drawings recorded into one document, replayed onto a canvas,
// and made interactive through the scene and the event router.
import { Canvg } from "canvg";
import {
  EventRouter,
  IDENTITY,
  type Matrix2D,
  RecordingContext,
  type RecordingContextOptions,
  type RouterEvent,
  Scene,
  applyToPoint,
  multiply,
  pathRings,
  replayDocument,
  serializeDocument,
  toSVG,
} from "canvas-ir";
import { type Region, drawTextLayout, layoutText } from "@canvas-ir/text";
import { type LiveText, type Sample, initialSamples, samples } from "./samples";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const selectionView = document.getElementById("selection")!;
const logView = document.getElementById("log")!;

// Images seen while recording, by the src the IR stores, so replay draws the same objects.
const images = new Map<string, CanvasImageSource>();
const imageIds = new Map<unknown, string>();
const recorderOptions: RecordingContextOptions = {
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
    return { src, width, height };
  },
};

let scene = new Scene({ version: 1, ops: [] });
let liveTexts: LiveText[] = [];
let view: Matrix2D = IDENTITY;
let router = new EventRouter(scene);
/** Selected objects (outermost groups, or single ops picked with Alt), in the order picked. */
let selected: string[] = [];
let hovered: string | null = null;
/** While dragging objects: what moves, their snap anchors where the drag began, and how far they've moved. */
let drag: { ids: string[]; anchors: { x: number; y: number }[]; moved: { x: number; y: number } } | null = null;
/** The snap target shown while dragging. */
let snapMark: { x: number; y: number; kind: string } | null = null;
/** While lassoing (Shift-drag on empty space): the outline so far, in world space. */
let lasso: { x: number; y: number }[] | null = null;
/** While panning empty space: the last pointer position, in host pixels. */
let panFrom: { x: number; y: number } | null = null;

/** What a click or drag acts on: the outermost group around the op, or the op itself with Alt held. */
const objectOf = (e: RouterEvent): string | null => {
  if (e.target === null) return null;
  if ("altKey" in e.input && e.input.altKey) return e.target;
  return e.path[e.path.length - 1] ?? e.target;
};

const log = (line: string): void => {
  logView.textContent = `${line}\n${logView.textContent ?? ""}`.split("\n").slice(0, 40).join("\n");
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

/** Lays a live text out against where its obstacles are now, and swaps its ops in the scene. */
const relayout = (live: LiveText): void => {
  const obstacles: Region[] = [];
  for (const group of live.obstacles) {
    if (!scene.getGroup(group)) continue;
    for (const id of scene.groupOps(group)) {
      const op = scene.get(id)!;
      if (op.kind === "fill") obstacles.push({ rings: pathRings(op.path), fillRule: op.fillRule });
    }
  }
  const layout = layoutText(live.text, {
    container: live.container,
    obstacles,
    obstacleMargin: live.margin,
    ...(live.theme ? { theme: live.theme } : {}),
  });
  const recorder = new RecordingContext();
  recorder.beginGroup({ id: live.parent });
  drawTextLayout(recorder, layout, { id: live.id, meta: { source: "live text" } });
  recorder.endGroup();
  const drawn = recorder.getDocument();
  if (scene.getGroup(live.id)) scene.remove(live.id);
  // Line groups and ops get ids under the block's, so they can't collide with the board's.
  const rename = (id: string): string => (id === live.id || id === live.parent ? id : `${live.id}/${id}`);
  for (const g of drawn.groups ?? []) if (g.id !== live.parent) scene.addGroup({ ...g, id: rename(g.id), ...(g.parent ? { parent: rename(g.parent) } : {}) });
  for (const op of drawn.ops) scene.insert({ ...op, id: rename(op.id), ...(op.group ? { group: rename(op.group) } : {}) });
};

const translateContainer = (live: LiveText, dx: number, dy: number): LiveText => ({
  ...live,
  container:
    "rings" in live.container
      ? { ...live.container, rings: live.container.rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy }))) }
      : { ...live.container, x: live.container.x + dx, y: live.container.y + dy },
});

/** After `moved` moved by (dx, dy): containers inside it follow, and text whose obstacles moved is laid out again. */
const followMove = (moved: string, dx: number, dy: number): void => {
  const inside = (id: string) => id === moved || scene.groupChain(id).includes(moved);
  liveTexts = liveTexts.map((live) => (inside(live.parent) ? translateContainer(live, dx, dy) : live));
  for (const live of liveTexts) if (!inside(live.parent) && live.obstacles.some(inside)) relayout(live);
};

const render = (): void => {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = stage.getBoundingClientRect();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const device = multiply({ a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 }, view);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  replayDocument(ctx, scene.document, { view: device, images: (src) => images.get(src) });

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
};

const showSelection = (): void => {
  selectionView.textContent =
    selected.length === 0
      ? "Click something on the board."
      : selected.length === 1
        ? describe(selected[0]!)
        : `${selected.length} objects\n${selected.join(", ")}`;
};

const select = (ids: string[]): void => {
  selected = ids;
  showSelection();
  render();
};

const shiftHeld = (e: RouterEvent): boolean => "shiftKey" in e.input && e.input.shiftKey === true;
const snapping = (e: RouterEvent): boolean => !("ctrlKey" in e.input && (e.input.ctrlKey || e.input.metaKey));

/** Moves the dragged objects so that, if one of their anchors lands near another object's snap point, it lands on it. */
const dragTo = (total: { x: number; y: number }, snap: boolean): void => {
  if (!drag) return;
  let target = total;
  snapMark = null;
  if (snap) {
    const radius = 8 / Math.hypot(view.a, view.b);
    let best: { dx: number; dy: number; distance: number; x: number; y: number; kind: string } | null = null;
    for (const a of drag.anchors) {
      const p = { x: a.x + total.x, y: a.y + total.y };
      const found = scene.snap(p, { radius, exclude: drag.ids });
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
    scene.transform(id, { a: 1, b: 0, c: 0, d: 1, e: step.x, f: step.y });
    followMove(id, step.x, step.y);
  }
  drag.moved = target;
};

const wire = (): void => {
  router = new EventRouter(scene, { view, tolerance: 3 });
  router.on("*", "enter", (e) => {
    hovered = objectOf(e);
    render();
  });
  router.on("*", "leave", () => {
    // An enter for whatever is under the pointer now follows, if anything is.
    hovered = null;
    render();
  });
  router.on("*", "click", (e) => {
    const id = objectOf(e);
    if (shiftHeld(e)) select(id === null ? selected : selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    else select(id === null ? [] : [id]);
    log(`click ${e.target ?? "empty space"}${e.path.length > 1 ? ` in ${e.path.slice(1).join(" < ")}` : ""}`);
  });
  router.on("*", "dragstart", (e) => {
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
    log(`drag ${ids.join(", ")}`);
  });
  router.on("*", "drag", (e) => {
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
    if (lasso && lasso.length > 2) {
      // Select the outermost object of every op the lasso touches.
      const picked = new Set<string>();
      for (const opId of scene.queryPolygon(lasso)) picked.add(scene.groupChain(opId).at(-1) ?? opId);
      select([...picked]);
      log(`lasso picked ${picked.size}`);
    }
    drag = null;
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
      liveTexts = liveTexts.filter((live) => scene.getGroup(live.parent));
      for (const live of liveTexts) relayout(live);
      hovered = null;
      select([]);
    }
  });
};

const setView = (next: Matrix2D): void => {
  view = next;
  router.setView(view);
  render();
};

const point = (e: MouseEvent): { x: number; y: number } => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const pointer = (e: PointerEvent) => ({ ...point(e), button: e.button, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  router.pointerDown(pointer(e));
});
canvas.addEventListener("pointermove", (e) => router.pointerMove(pointer(e)));
canvas.addEventListener("pointerup", (e) => router.pointerUp(pointer(e)));
canvas.addEventListener("pointerleave", (e) => router.pointerLeave(pointer(e)));
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = point(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    setView(multiply({ a: k, b: 0, c: 0, d: k, e: p.x - k * p.x, f: p.y - k * p.y }, view));
  },
  { passive: false },
);
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement) return;
  router.keyDown({ key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
});
new ResizeObserver(render).observe(stage);

/** Draws more onto the board: the current document is replayed into a new recorder, then the sample is drawn after it. */
const add = async (sample: Sample): Promise<void> => {
  const recorder = new RecordingContext(recorderOptions);
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
  const live = "svg" in sample ? undefined : sample.draw(recorder);
  scene = new Scene(recorder.getDocument());
  liveTexts = [...liveTexts, ...(live ?? [])];
  for (const l of live ?? []) relayout(l);
  wire();
  log(`added ${sample.name}; the board has ${scene.document.ops.length} ops`);
  render();
};

const download = (name: string, type: string, text: string): void => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const samplesBar = document.getElementById("samples")!;
for (const sample of samples) {
  const button = document.createElement("button");
  button.textContent = `+ ${sample.name}`;
  button.addEventListener("click", () => void add(sample));
  samplesBar.append(button, " ");
}
document.getElementById("add-svg")!.addEventListener("click", () => {
  const svg = (document.getElementById("svg-input") as HTMLTextAreaElement).value.trim();
  if (svg) void add({ name: "pasted SVG", svg, at: { x: 40, y: 40 } }).catch((error) => log(`could not draw it: ${error}`));
});
document.getElementById("export-svg")!.addEventListener("click", () => {
  const b = stage.getBoundingClientRect();
  download("board.svg", "image/svg+xml", toSVG(scene.document, { width: Math.round(b.width), height: Math.round(b.height) }));
});
document.getElementById("export-json")!.addEventListener("click", () => download("board.json", "application/json", serializeDocument(scene.document)));
document.getElementById("reset-view")!.addEventListener("click", () => setView(IDENTITY));

for (const sample of initialSamples) await add(sample);
