// The playground: drawings recorded into one document, replayed onto a canvas,
// and made interactive through the scene and the event router.
import { Canvg } from "canvg";
import {
  Components,
  EventRouter,
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
import { type ControlHooks, type LiveSpec, type Sample, initialSamples, samples } from "./samples";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const selectionView = document.getElementById("selection")!;
const logView = document.getElementById("log")!;

// Images seen while recording, by the src the IR stores, so replay draws the same objects.
const images = new Map<string, CanvasImageSource>();
const imageIds = new Map<unknown, string>();
// Each image's traced silhouette, so hit tests, snapping and text wrap follow its opaque pixels.
const outlines = new Map<unknown, Point[][]>();
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
/** Interactive objects (the note, the controls), drawn from their state. */
let components: Components | null = null;
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

const parentOf = (live: LiveText): string => (live.settings as LiveSpec).parent;

/** After `moved` moved by (dx, dy): containers inside it follow, and text whose obstacles moved is laid out again. */
const followMove = (moved: string, dx: number, dy: number): void => {
  const inside = (id: string) => id === moved || scene.groupChain(id).includes(moved);
  for (const live of liveTexts) {
    if (inside(parentOf(live))) live.translate(dx, dy);
    else if (live.dependsOn(moved)) live.update();
  }
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
  scene = new Scene(recorder.getDocument());
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
    const result = vectorize(pixels.getImageData(0, 0, width, height));
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

for (const sample of initialSamples) await add(sample);
