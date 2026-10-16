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
  replayDocument,
  serializeDocument,
  toSVG,
} from "canvas-ir";
import { type Sample, samples } from "./samples";

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
let view: Matrix2D = IDENTITY;
let router = new EventRouter(scene);
let selected: string | null = null;
let hovered: string | null = null;
let moving: string | null = null;
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
  if (hovered && hovered !== selected) outline(hovered, style.getPropertyValue("--hover").trim(), [4, 3]);
  if (selected) outline(selected, style.getPropertyValue("--accent").trim(), []);
  ctx.setLineDash([]);
};

const select = (id: string | null): void => {
  selected = id;
  selectionView.textContent = id ? describe(id) : "Click something on the board.";
  render();
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
    select(objectOf(e));
    log(`click ${e.target ?? "empty space"}${e.path.length > 1 ? ` in ${e.path.slice(1).join(" < ")}` : ""}`);
  });
  router.on("*", "dragstart", (e) => {
    moving = objectOf(e);
    panFrom = moving === null ? e.screen : null;
    if (moving) {
      select(moving);
      log(`drag ${moving}`);
    }
  });
  router.on("*", "drag", (e) => {
    if (moving) {
      scene.transform(moving, { a: 1, b: 0, c: 0, d: 1, e: e.delta!.x, f: e.delta!.y });
      if (selected === moving) selectionView.textContent = describe(moving);
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
    moving = null;
    panFrom = null;
  });
  router.on("*", "keydown", (e) => {
    const key = (e.input as { key: string }).key;
    if ((key === "Delete" || key === "Backspace") && selected) {
      log(`remove ${selected}`);
      scene.remove(selected);
      hovered = null;
      select(null);
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
  } else {
    sample.draw(recorder);
  }
  scene = new Scene(recorder.getDocument());
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

for (const sample of samples) await add(sample);
