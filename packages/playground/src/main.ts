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
import { MORPH_ID, dayToNight } from "./morph-demo";
import { type ToolName, Tools } from "./tools";
import { type ControlHooks, type LiveSpec, type Sample, initialSamples, samples } from "./samples";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const octx = overlay.getContext("2d")!;
const renderStats = document.getElementById("render-stats")!;
const lodOn = document.getElementById("lod-on") as HTMLInputElement;
const selectionView = document.getElementById("selection")!;
const logView = document.getElementById("log")!;

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
// HTML and WebGL elements of embed ops, beneath the board.
const embeds = new EmbedLayer(scene, stage, canvas, { create: createEmbed, destroy: destroyEmbed });
// What screen readers read and Tab reaches: a DOM mirror of the board's roles and text.
const a11yView = document.getElementById("a11y-tree")!;
const outlineOf = (nodes: readonly AccessibleNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.role}${n.label ? ` "${n.label.length > 48 ? `${n.label.slice(0, 47)}…` : n.label}"` : ""}${n.value !== undefined ? ` = ${n.value}` : ""}`, ...outlineOf(n.children, depth + 1)]);
const a11y = new AccessibilityLayer(scene, stage, {
  onFocus: (id) => router.focusOn(id),
  // Enter or Space presses the control where it is drawn, as a click would.
  onActivate: (id) => {
    const b = scene.bounds(id);
    if (!b) return;
    const p = applyToPoint(view, b.x + b.width / 2, b.y + b.height / 2);
    router.pointerDown({ x: p.x, y: p.y, button: 0 });
    router.pointerUp({ x: p.x, y: p.y, button: 0 });
  },
  onChange: (tree) => {
    const lines = outlineOf(tree);
    a11yView.textContent = lines.length > 60 ? `${lines.slice(0, 60).join("\n")}\n… ${lines.length - 60} more` : lines.join("\n");
  },
});
/** The view and canvas size the renderer last had, so it redraws everything only when they change. */
let viewKey = "";
const makeRenderer = (): void => {
  renderer.dispose();
  renderer = new Renderer(scene, ctx, { images: (src) => images.get(src), ...(lodOn.checked ? {} : { lod: false }) });
  viewKey = "";
};
/** Interactive objects (the note, the controls), drawn from their state. */
let components: Components | null = null;
/** Selected objects (outermost groups, or single ops picked with Alt), in the order picked. */
let selected: string[] = [];
let hovered: string | null = null;
/** The op under the pointer and its groups, innermost first, for chart tooltips. */
let hoverPath: readonly string[] = [];
const tooltip = document.createElement("div");
tooltip.className = "tooltip";
tooltip.hidden = true;
stage.append(tooltip);
const showTooltip = (screen: { x: number; y: number }): void => {
  const text = hoverPath.length > 0 && !tools.drawing ? datumAt(scene, hoverPath, router.toWorld(screen)) : null;
  tooltip.hidden = text === null;
  if (text === null) return;
  tooltip.textContent = text;
  tooltip.style.left = `${screen.x + 14}px`;
  tooltip.style.top = `${screen.y + 14}px`;
};
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

const parentOf = (live: LiveText): string => (live.settings as LiveSpec).parent;

/** After `moved` moved by (dx, dy): containers inside it follow, and text whose obstacles moved is laid out again. */
const followMove = (moved: string, dx: number, dy: number): void => {
  const inside = (id: string) => id === moved || scene.groupChain(id).includes(moved);
  for (const live of liveTexts) {
    if (inside(parentOf(live))) live.translate(dx, dy);
    else if (live.dependsOn(moved)) live.update();
  }
};

let stepped = false;
const render = (): void => {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = stage.getBoundingClientRect();
  for (const c of [canvas, overlay]) {
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
    renderStats.textContent = `${stats.mode} redraw: ${stats.ops} of ${scene.document.ops.length} ops in ${ms.toFixed(1)} ms${stats.rects.length > 0 ? `, ${stats.rects.length} rect${stats.rects.length > 1 ? "s" : ""}` : ""}`;
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
};

const showSelection = (): void => {
  selectionView.textContent =
    selected.length === 0
      ? "Click something on the board."
      : selected.length === 1
        ? describe(selected[0]!)
        : `${selected.length} objects\n${selected.join(", ")}`;
  if (selected.length === 1) devtools.show(selected[0]!);
};

const select = (ids: string[]): void => {
  selected = ids;
  showSelection();
  render();
};

const shiftHeld = (e: RouterEvent): boolean => "shiftKey" in e.input && e.input.shiftKey === true;
const snapping = (e: RouterEvent): boolean => !("ctrlKey" in e.input && (e.input.ctrlKey || e.input.metaKey));

const snapOn = document.getElementById("snap-on") as HTMLInputElement;
const snapRadius = document.getElementById("snap-radius") as HTMLInputElement;
const snapText = document.getElementById("snap-text") as HTMLInputElement;
snapRadius.addEventListener("input", () => (document.getElementById("snap-radius-value")!.textContent = `${snapRadius.value}px`));
const KIND_GROUPS: Record<string, readonly SnapKind[]> = {
  points: ["vertex", "intersection", "center", "midpoint", "extreme", "baseline"],
  bounds: ["bounds"],
  path: ["path"],
};
const snapKinds = (): SnapKind[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>(".snap-kind")).filter((c) => c.checked).flatMap((c) => KIND_GROUPS[c.value] ?? []);

/** Moves the dragged objects so that, if one of their anchors lands near another object's snap point, it lands on it. */
const dragTo = (total: { x: number; y: number }, snap: boolean): void => {
  if (!drag) return;
  let target = total;
  snapMark = null;
  const kinds = snapKinds();
  if (snap && snapOn.checked && kinds.length > 0) {
    const radius = Number(snapRadius.value) / Math.hypot(view.a, view.b);
    // Text laid out against what moves moves with it: snapping to it would chase a moving target.
    const exclude = [...drag.ids, ...liveTexts.filter((l) => drag!.ids.some((id) => l.dependsOn(id))).map((l) => l.id)];
    const filter = snapText.checked ? undefined : (op: { kind: string }) => op.kind !== "text";
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
        canvas.style.cursor = components?.cursor ?? "";
        render();
      },
    });
  }
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
  render();
};

const point = (e: MouseEvent): { x: number; y: number } => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const pointer = (e: PointerEvent) => ({ ...point(e), button: e.button, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  // A drawing tool takes the press; the select tool hands it to the router.
  if (tools.down(point(e), e.shiftKey)) return;
  router.pointerDown(pointer(e));
});
canvas.addEventListener("pointermove", (e) => {
  if (tools.drawing) tools.move(point(e), e.shiftKey);
  else router.pointerMove(pointer(e));
  showTooltip(point(e));
});
canvas.addEventListener("pointerup", (e) => {
  if (tools.drawing) tools.up();
  else router.pointerUp(pointer(e));
});
canvas.addEventListener("pointerleave", (e) => {
  router.pointerLeave(pointer(e));
  tooltip.hidden = true;
});
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
const TOOL_KEYS: Record<string, ToolName> = { v: "select", p: "pen", r: "rect", o: "ellipse", t: "text" };
const useTool = (name: ToolName): void => {
  tools.cancel();
  tools.current = name;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset["tool"] === name));
  canvas.style.cursor = name === "select" ? "" : name === "text" ? "text" : "crosshair";
  render();
};
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => useTool(b.dataset["tool"] as ToolName)));
const styleInput = (id: string, set: (value: string) => void): void => {
  const input = document.getElementById(id) as HTMLInputElement;
  input.addEventListener("input", () => set(input.value));
};
styleInput("tool-fill", (v) => (tools.style.fill = v));
styleInput("tool-stroke", (v) => (tools.style.stroke = v));
styleInput("tool-width", (v) => (tools.style.lineWidth = Number(v)));
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
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
    if (!snapOn.checked || kinds.length === 0) return null;
    const found = scene.snap(world, { radius: Number(snapRadius.value) / Math.hypot(view.a, view.b), kinds });
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

/** Draws more onto the board: the current document is replayed into a new recorder, then the sample is drawn after it. */
const add = async (sample: Sample): Promise<void> => {
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
  render();
  // Bring what was added into sight, unless it is too big to (the 10,000 shapes).
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const op of scene.document.ops.slice(before.length)) {
    const b = scene.bounds(op.id);
    if (!b) continue;
    box = box
      ? { minX: Math.min(box.minX, b.x), minY: Math.min(box.minY, b.y), maxX: Math.max(box.maxX, b.x + b.width), maxY: Math.max(box.maxY, b.y + b.height) }
      : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
  }
  if (box && box.maxX - box.minX < 1500 && !initial) reveal({ x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY });
};
let initial = true;

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
document.getElementById("vectorize")!.addEventListener("click", () => {
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
});
document.getElementById("export-json")!.addEventListener("click", () => download("board.json", "application/json", serializeDocument(scene.document)));
document.getElementById("reset-view")!.addEventListener("click", () => setView(IDENTITY));

/** Pans so a world rect is in sight, keeping the zoom, when it isn't already. */
const reveal = (b: { x: number; y: number; width: number; height: number }): void => {
  const { width, height } = stage.getBoundingClientRect();
  const p = applyToPoint(view, b.x, b.y);
  const q = applyToPoint(view, b.x + b.width, b.y + b.height);
  if (p.x >= 0 && p.y >= 0 && q.x <= width && q.y <= height) return;
  setView({ ...view, e: view.e + width / 2 - (p.x + q.x) / 2, f: view.f + height / 2 - (p.y + q.y) / 2 });
};

// The morph demo: day and night drawn apart, blended by the slider.
const morphSlider = document.getElementById("morph-t") as HTMLInputElement;
const morphTo = (t: number): void => {
  const fresh = scene.getGroup(MORPH_ID) === undefined;
  scene.replaceGroup(MORPH_ID, dayToNight().at(t));
  if (fresh) {
    const m = dayToNight();
    log(`morph demo: ${m.paired} ops paired by their groups' names, ${m.removed} fading out, ${m.added} fading in`);
    reveal(scene.bounds(MORPH_ID)!);
  }
  render();
};
morphSlider.addEventListener("input", () => morphTo(Number(morphSlider.value)));
let playing = 0;
document.getElementById("morph-play")!.addEventListener("click", () => {
  const start = performance.now();
  const from = Number(morphSlider.value) < 0.5 ? 0 : 1;
  const run = ++playing;
  const frame = (now: number): void => {
    if (run !== playing) return;
    const k = Math.min(1, (now - start) / 1600);
    const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const t = from === 0 ? eased : 1 - eased;
    morphSlider.value = String(t);
    morphTo(t);
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
lodOn.addEventListener("change", () => {
  makeRenderer();
  render();
});

for (const sample of initialSamples) await add(sample);
initial = false;
