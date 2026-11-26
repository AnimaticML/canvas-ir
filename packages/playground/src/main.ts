// The playground: drawings recorded into one document, replayed onto a canvas,
// and made interactive through the scene and the event router.
import { Canvg } from "canvg";
import {
  EmbedLayer,
  type Matrix2D,
  RecordingContext,
  type RecordingContextOptions,
  type RouterEvent,
  Scene,
  applyToPoint,
  replayDocument,
  serializeDocument,
  imageToWorld,
  toSVG,
  transformOp,
  type ImageOp,
  type Op,
  type Point,
  type IRDocument,
  type JsonValue,
  parseDocument,
  type Rect,
} from "canvas-ir";
import { vectorize } from "@canvas-ir/vectorize";
import { LiveText } from "@canvas-ir/text";
import { Board, BoardFeed, CardLayer, type Connector, Desktop, ImageRegistry, TOOLS, snapControls, snapSettings, textSink, Windows } from "@canvas-ir/toolkit";
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
import { MAP_AT, MAP_ID, WorldMap } from "./map-demo";
import { BOOK_AT, BOOK_ID, warAndPeace } from "./book-demo";
import { DECLARATION_AT, DECLARATION_ID, declaration } from "./declaration-demo";
import { Reader } from "./reader";
import { type ControlHooks, type LiveSpec, type Sample, samples } from "./samples";
import { Chrome, type Settings } from "./ui/chrome";
import { type Glyph, ICON, drawGlyph, tintOf } from "./ui/features";
import { CONNECTORS, CONTENT as CONTENT_AT, DRAWINGS, ICONS, WINDOWS, origin } from "./collage";

const stage = document.getElementById("stage")!;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const cardCanvas = document.getElementById("cards") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
/** What the inspector's controls set. */
const settings: Settings = { snap: snapControls(), lod: true };

// Images seen while recording, by the src the IR stores, so replay draws the same objects; each traced, so hit tests,
// snapping and text wrap follow its opaque pixels.
const images = new ImageRegistry();
/** Op id to the line of code that drew it, for devtools. */
const sources = new Map<string, string>();
const recorderOptions: RecordingContextOptions = {
  captureSource: true,
  describeImage: images.describe,
};

// The playground's controls: cards in a scene of their own, drawn over the board with its view.
const cards = new CardLayer(cardCanvas, stage, {
  recorder: recorderOptions,
  onCursor: (cursor) => {
    if (board.pointerOverCards) canvas.style.cursor = cursor ?? "default";
  },
  onFocus: () => board.keysToCardsLayer(),
});
// The board (the toolkit's): picking, outlines, dragging with snapping, the lasso, the tools, connectors, the cards'
// pointers, pinch and wheel zoom, and the frame loop. What is on it, and what a change means, is this page's.
const board: Board = new Board({
  stage,
  canvas,
  overlay,
  cards,
  recorder: recorderOptions,
  renderer: () => ({ images: images.resolve, ...(settings.lod ? {} : { lod: false }) }),
  snap: () => snapSettings(settings.snap),
  hooks: {
    bound: (s, r) => {
      devtools.attach(s);
      embeds.setScene(s);
      if (table?.alive) table.bind(s, r);
      if (points?.alive) points.bind(s, r);
      if (galaxy?.alive) galaxy.bind(s, r);
      if (worldMap?.alive) worldMap.bind(s, r);
      if (book?.alive) book.bind(s, r);
      if (rights?.alive) rights.bind(s, r);
    },
    // What the map records now is drawn in this frame, not the next.
    beforeDraw: () => worldMap?.flush(),
    // While devtools steps through the ops, it draws the board itself.
    paint: (c, device) => devtools.drawBoard(c, device),
    overlay: (c, device, ui) => devtools.preview(c, device, ui),
    viewChanged: (next) => {
      view = next;
      embeds.setView(next);
      points?.zoomed();
      galaxy?.zoomed();
      worldMap?.zoomed();
    },
    // A body or node is dragged through its simulation, so it keeps colliding or pulling on its links.
    grab: (e) => {
      const parts = e.target === null ? [] : [e.target, ...e.path];
      const body = sandbox && scene.getGroup(PHYSICS_ID) ? parts.find((p) => sandbox!.physics.body(p)?.isDynamic()) : undefined;
      if (body && sandbox!.physics.grab(body, e.point)) {
        holding = true;
        runPhysics();
        return {
          drag: (p) => sandbox?.physics.drag(p),
          end: () => {
            holding = false;
            sandbox?.physics.release();
          },
        };
      }
      const node = graph && scene.getGroup(GRAPH_ID) ? parts.find((p) => graph!.nodeOf(p)) : undefined;
      if (node) {
        graph!.grab(node, e.point);
        return { drag: (p) => graph?.drag(p), end: () => graph?.release() };
      }
      return null;
    },
    // A window's frame, its drawing and its controls move as one.
    expand: (ids) => withWindows(ids),
    // Text laid out against what moves moves with it: snapping to it would chase a moving target.
    following: (ids) => liveTexts.filter((l) => ids.some((id) => l.dependsOn(id))).map((l) => l.id),
    moved: (id, dx, dy) => followMove(id, dx, dy),
    changed: () => remember(),
    removed: () => {
      liveTexts = liveTexts.filter((live) => scene.getGroup(parentOf(live)));
      for (const live of liveTexts) live.update();
    },
    selected: (ids) => {
      if (ids.length === 1) devtools.show(ids[0]!);
    },
    // Over an embed, the pointer goes to its element (a form, a WebGL view); with Alt held, the board keeps it, to drag the embed.
    enter: (e) => {
      if (e.op?.kind === "embed" && !board.dragActive && !board.tools.drawing && !("altKey" in e.input && e.input.altKey)) embeds.passThrough(e.op.id);
    },
    tooltip: (world, path) => datumAt(scene, path, world),
    keyAt: (screen) => keyAt(screen),
    boxOf: (key) => boxOfKey(key),
    recorded: (opId, source) => sources.set(opId, source),
  },
});
// What the inspector shows of the board: the selection, the last redraw, the accessibility tree and the log.
const feed = new BoardFeed(board);
let scene = board.scene;
/** Whether a physics body is held, so the simulation keeps running while it is. */
let holding = false;
let liveTexts: LiveText[] = [];
/** The board's view, kept beside it for the many places that read one. */
let view: Matrix2D = board.view;
// HTML and WebGL elements of embed ops, beneath the board.
const embeds = new EmbedLayer(scene, stage, canvas, { create: createEmbed, destroy: destroyEmbed });
const render = (): void => board.render();
const setView = (next: Matrix2D): void => board.setView(next);
const select = (ids: string[]): void => board.select(ids);
const boxOf = (ids: readonly string[]): Rect | null => board.boxOf(ids);
const reveal = (b: Rect): void => board.reveal(b);
/** The ten-million-point chart, once added. */
let points: TenMillionPoints | null = null;
let galaxy: StarsAndPlanets | null = null;
let worldMap: WorldMap | null = null;
let book: Reader | null = null;
let rights: Reader | null = null;
/** The million-row table, once added. */
let table: MillionRows | null = null;
const log = (line: string): void => feed.log(line);

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
  if (worldMap?.alive && inside(MAP_ID)) worldMap.moved(dx, dy);
  if (book?.alive && inside(BOOK_ID)) book.moved(dx, dy);
  if (rights?.alive && inside(DECLARATION_ID)) rights.moved(dx, dy);
};

/**
 * The part of the page a host showing it on a 3D screen wants, in CSS pixels,
 * and how many canvas pixels to draw per CSS pixel: the canvases then hold
 * only that part, as sharp as the host's view of it needs. Null draws the
 * whole page at the device's pixel ratio. The host reads what was drawn from
 * `canvasIrDrawn`, as the canvases change size a frame after it asks.
 */
type Capture = { x: number; y: number; width: number; height: number; scale: number; ui?: number };
const host = window as unknown as { canvasIrCapture?: (c: Capture | null) => void; canvasIrDrawn?: Capture };
host.canvasIrCapture = (c) => {
  board.part = c;
  render();
};
Object.defineProperty(host, "canvasIrDrawn", { get: () => board.drawnPart ?? undefined, configurable: true });

/** A thing standing on the floor of a 3D room the board is laid out as: its footprint on the board, in board units. */
interface FloorThing {
  readonly id: string;
  readonly kind: "ball" | "crate";
  readonly x: number;
  readonly y: number;
  /** Its turn about the vertical, in radians, as seen from above. */
  readonly angle: number;
  readonly size: number;
  readonly color: string;
}
/**
 * For a host that lays the board flat as the floor of a 3D room: the board's
 * scenes, to draw them itself at any part and detail; what is under a board
 * point, to send presses there; and footprints of the things standing on the
 * floor, drawn on the board in 2D, which the host moves when a footprint is
 * dragged.
 */
const floorHost = window as unknown as {
  canvasIrFloor?: {
    scene(): Scene;
    cards(): Scene;
    images(src: string): CanvasImageSource | undefined;
    lod(): boolean;
    view(): Matrix2D;
    setView(view: Matrix2D): void;
    bounds(): { x: number; y: number; width: number; height: number } | null;
    background(): string;
    hits(point: Point): boolean;
    footprints(things: readonly FloorThing[] | null): void;
    onFootprint: ((id: string, phase: "start" | "move" | "end", point: Point) => void) | null;
    windows(): FloorWindow[];
    moveWindow(id: string, dx: number, dy: number): void;
    wheel(point: Point, deltaX: number, deltaY: number): boolean;
  };
};
/** An open demo window on the board: its group, its title and its box, title bar included. */
interface FloorWindow {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How tall its title bar is. */
  readonly bar: number;
}
const footprints = new Set<string>();
floorHost.canvasIrFloor = {
  scene: () => scene,
  cards: () => cards.scene,
  images: images.resolve,
  lod: () => settings.lod,
  view: () => view,
  setView: (next) => setView(next),
  bounds: () => board.contentBox(),
  background: () => getComputedStyle(stage).backgroundColor || getComputedStyle(document.body).backgroundColor,
  hits: (point) => scene.hitTest(point).length > 0 || cards.scene.hitTest(point).length > 0,
  windows: () => openWindows(),
  moveWindow: (id, dx, dy) => {
    moveWindowBy(id, dx, dy);
    board.select(board.selected);
    render();
    remember();
  },
  // A wheel at a board point, for what keeps one there (the map, the stars, the million rows); false when nothing does.
  wheel: (at, deltaX, deltaY) => {
    const p = { x: view.a * at.x + view.c * at.y + view.e, y: view.b * at.x + view.d * at.y + view.f };
    return board.wheel({ ...p, deltaX, deltaY, timeStamp: performance.now(), altKey: false, shiftKey: false, ctrlKey: false, metaKey: false });
  },
  footprints: (things) => {
    const components = board.components;
    const keep = new Set((things ?? []).map((t) => `floor/${t.id}`));
    for (const id of footprints) {
      if (keep.has(id)) continue;
      components.unmount(id);
      footprints.delete(id);
    }
    for (const t of things ?? []) {
      const id = `floor/${t.id}`;
      if (!footprints.has(id)) {
        footprints.add(id);
        const send = (phase: "start" | "move" | "end") => (e: RouterEvent): void => {
          e.stopPropagation();
          floorHost.canvasIrFloor?.onFootprint?.(t.id, phase, e.point);
        };
        components.mount({
          id,
          state: {},
          cursor: "grab",
          meta: { role: "img", label: `the ${t.kind} ${t.id}, seen from above` },
          draw: (c, _s, ui) => {
            const r = t.size / 2;
            c.shadowColor = "rgba(15, 23, 42, 0.25)";
            c.shadowBlur = r * 0.35;
            c.shadowOffsetY = r * 0.12;
            c.fillStyle = t.color;
            c.beginPath();
            if (t.kind === "ball") c.arc(0, 0, r, 0, Math.PI * 2);
            else c.roundRect(-r, -r, t.size, t.size, r * 0.12);
            c.fill();
            c.shadowColor = "transparent";
            c.lineWidth = r * (ui.hovered ? 0.16 : 0.1);
            c.strokeStyle = "rgba(255, 255, 255, 0.85)";
            c.stroke();
            c.fillStyle = "#ffffff";
            c.font = `700 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(t.id.replace(/\D+/g, ""), 0, r * 0.04);
          },
          on: { down: (e) => e.stopPropagation(), dragstart: send("start"), drag: send("move"), dragend: send("end") },
        });
      }
      const cos = Math.cos(t.angle);
      const sin = Math.sin(t.angle);
      scene.setTransform(id, { a: cos, b: sin, c: -sin, d: cos, e: t.x, f: t.y });
    }
    render();
  },
  onFootprint: null,
};

const devtools = new Devtools({
  scene: () => scene,
  sources,
  select: (id) => select([id]),
  redraw: () => render(),
  images: images.resolve,
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
  get: (id) => board.components.get(id),
};

/**
 * Draws more onto the board: the current document is replayed into a new
 * recorder, then the sample is drawn after it. Given a place, it is moved
 * there, as a drag would move it: its top left at `at`, or its middle at
 * `at.y` with `middle`.
 */
const add = async (sample: Sample, at?: { x: number; y: number; middle?: boolean }): Promise<string[]> => {
  const recorder = new RecordingContext(recorderOptions);
  const before = scene.document.ops;
  replayDocument(recorder, scene.document, { images: images.resolve });
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
  board.setScene(scene);
  // Texts and components already on the board were replayed with it; bind them to the new scene.
  liveTexts = liveTexts.map((l) => new LiveText(scene, l.settings));
  for (const spec of drawn?.live ?? []) {
    const l = new LiveText(scene, { ...spec, meta: { source: "live text" } });
    l.update();
    liveTexts.push(l);
  }
  for (const spec of drawn?.components ?? []) board.components.mount(spec);
  log(`added ${sample.name}; the board has ${scene.document.ops.length} ops`);
  const added = scene.document.ops.slice(before.length).map((op) => op.id);
  const outer = [...new Set(added.map((op) => scene.groupChain(op).at(-1) ?? op))];
  let box = boxOf(added);
  if (at && box) {
    const dx = at.x - box.x;
    const dy = at.y - (at.middle ? box.height / 2 : 0) - box.y;
    // Each new outermost group moves as one, with what is laid out against it.
    for (const id of outer) {
      board.components.move(id, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
      followMove(id, dx, dy);
    }
    box = { ...box, x: box.x + dx, y: box.y + dy };
  }
  render();
  if (box && !initial) reveal(box);
  return outer;
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
  const ops = board.selected.flatMap((id) => (scene.getGroup(id) ? scene.groupOps(id) : [id])).map((id) => scene.get(id)).filter((op): op is ImageOp => op?.kind === "image");
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
  board.select(board.selected);
  render();
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
  const controls = morphControls(morphTo, (id) => board.components.get(id));
  for (const spec of controls) if (!board.components.get(spec.id)) board.components.mount(spec);
  frameAround(MORPH_ID, "Morph: day to night", [MORPH_ID, ...controls.map((c) => c.id)], closeMorph);
  const b = scene.bounds(MORPH_ID)!;
  reveal({ ...b, height: b.height + 70 });
};

// The pelican on its bicycle: poses drawn an eighth of a pedal turn apart, morphed into every frame between.
const PELICAN_AT = origin("pelican");
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
  board.components.get<{ riding: boolean }>("pelican-ride")?.setState({ riding: false });
};
const startRiding = (): void => {
  const run = ++riding;
  board.components.get<{ riding: boolean }>("pelican-ride")?.setState({ riding: true });
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
  if (!board.components.get("pelican-ride")) {
    board.components.mount(rideButton(PELICAN_AT, () => (board.components.get<{ riding: boolean }>("pelican-ride")?.state.riding ? stopRiding() : startRiding())));
  }
  frameAround(PELICAN_ID, "A pelican riding a bicycle", [PELICAN_ID, "pelican-ride"], closePelican);
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
    if (!awake && !holding) {
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
  if (!board.components.get("physics-drop")) {
    board.components.mount(
      sandboxButton(() => {
        if (sandbox!.physics.scene !== scene) sandbox!.physics.rebind(scene);
        sandbox!.drop(6);
        board.components.get<{ bodies: number }>("physics-drop")?.setState({ bodies: count() });
        runPhysics();
      }),
    );
  }
  board.components.get<{ bodies: number }>("physics-drop")?.setState({ bodies: count() });
  frameAround(PHYSICS_ID, "Physics: crates, balls and stars", [PHYSICS_ID, "physics-drop"], closePhysics);
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
        if (frames++ % 20 === 0) board.components.get<{ ms: number }>("graph-shake")?.setState({ ms: graph?.stats.ms ?? 0 });
        render();
      },
    );
  }
  if (!board.components.get("graph-shake")) board.components.mount(graphButton(() => graph?.simulation.alpha(1).restart()));
  frameAround(GRAPH_ID, "A force-directed graph", [GRAPH_ID, "graph-shake"], closeGraph);
  const b = scene.bounds(GRAPH_ID)!;
  reveal({ ...b, height: b.height + 50 });
};

// Paint by numbers: a painting, or a picture of yours, vectorized into regions with shared borders.
const showPaint = (source: PaintSource): void => {
  if (board.components.get(PAINT_ID)) board.components.unmount(PAINT_ID);
  const t0 = performance.now();
  board.components.mount(paintComponent(source));
  frameAround(PAINT_ID, `Paint by numbers: ${source.name}`, [PAINT_ID], closePaint);
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
  if (!table?.alive) table = new MillionRows(scene, board.router, { components: () => board.components, render: () => render(), log, closed: refreshIcons });
  reveal(table.bounds);
};

// Ten million points: a chart whose plot draws a bar per pixel, a line or dots, by how many readings share a pixel.
const pointsDemo = (): void => {
  if (!points?.alive) points = new TenMillionPoints(scene, board.router, { components: () => board.components, zoom: () => Math.hypot(view.a, view.b), render: () => render(), log, closed: refreshIcons });
  reveal(points.bounds);
};

// Stars and planets: a galaxy made region by region as you look, from the whole of it down to a planet's face.
const galaxyDemo = (): void => {
  if (!galaxy?.alive) galaxy = new StarsAndPlanets(scene, board.router, { components: () => board.components, zoom: () => Math.hypot(view.a, view.b), render: () => render(), log, closed: refreshIcons, recorder: { ...recorderOptions, captureSource: false } });
  reveal(galaxy.bounds);
};

// A world map of real data, from Natural Earth: tiles at four levels of detail, read as they come into view, and Wikipedia's articles about the places in view.
const mapDemo = (): void => {
  if (!worldMap?.alive) worldMap = new WorldMap(scene, board.router, { components: () => board.components, zoom: () => Math.hypot(view.a, view.b), render: () => render(), log, closed: refreshIcons, recorder: { ...recorderOptions, captureSource: false }, reader: readerHost });
  reveal(worldMap.bounds);
};

// Long documents of real text, read as books: laid out a section at a time as it comes into view and the rest between frames.
const readerHost = () => ({
  components: () => board.components,
  render: () => render(),
  log,
  toPage: (x: number, y: number) => {
    const r = canvas.getBoundingClientRect();
    const p = applyToPoint(view, x, y);
    return { x: r.left + p.x, y: r.top + p.y };
  },
  recorder: { ...recorderOptions, captureSource: false },
});
const bookDemo = (): void => {
  if (!book?.alive) book = new Reader(scene, board.router, readerHost(), { ...warAndPeace, onClose: () => closeReader(book) });
  reveal(book.bounds);
};
const declarationDemo = (): void => {
  if (!rights?.alive) rights = new Reader(scene, board.router, readerHost(), { ...declaration, onClose: () => closeReader(rights) });
  reveal(rights.bounds);
};

/**
 * What was moved, drawn or deleted on the board, kept in this browser so the board opens as it was left: where the
 * content, the windows and the icons are, which content was deleted, and every drawing (the collage's notes and arrows
 * and what was drawn with the tools), as documents. Export layout saves it as a file, Reset layout forgets it.
 */
interface Layout {
  version: 1;
  content: Record<string, Point>;
  windows: Record<string, Point>;
  icons: Record<string, Point>;
  removed: string[];
  /** Null until something is drawn, moved or deleted: the collage's drawings then. */
  drawings: IRDocument[] | null;
}
const LAYOUT = "canvasIrLayout";
const layout: Layout = ((): Layout => {
  const empty: Layout = { version: 1, content: {}, windows: {}, icons: {}, removed: [], drawings: null };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT) ?? "null") as Partial<Layout> | null;
    return saved?.version === 1 ? { ...empty, ...saved } : empty;
  } catch {
    return empty;
  }
})();
/** The content on the board, by its sample's name: its outermost groups. */
const contentIds = new Map<string, string[]>();
/** Off while the board is first laid out, so laying it out isn't taken for a change. */
let remembering = false;
const exists = (id: string): boolean => scene.getGroup(id) !== undefined || scene.get(id) !== undefined;
/** Each demo window's group on the board, by its icon's id. */
const WINDOW_OF: Record<string, string> = {
  pelican: `${PELICAN_ID}:window`,
  physics: `${PHYSICS_ID}:window`,
  graph: `${GRAPH_ID}:window`,
  morph: `${MORPH_ID}:window`,
  paint: `${PAINT_ID}:window`,
  table: TABLE_ID,
  points: POINTS_ID,
  galaxy: GALAXY_ID,
  map: MAP_ID,
  book: BOOK_ID,
  declaration: DECLARATION_ID,
};
const documentOf = (id: string): IRDocument => board.documentOf(id);
/** Notes the board as it is now, and keeps it. */
function remember(): void {
  if (!remembering) return;
  for (const [name, ids] of contentIds) {
    const there = ids.filter(exists);
    const box = there.length > 0 ? boxOf(there) : null;
    if (box) layout.content[name] = { x: box.x, y: box.y };
    else if (!layout.removed.includes(name)) layout.removed.push(name);
  }
  if (fieldOpen()) {
    const box = boxOf(field.filter(exists));
    if (box) layout.content[FIELD] = { x: box.x, y: box.y };
  }
  for (const [key, id] of Object.entries(WINDOW_OF)) {
    const box = scene.getGroup(id) ? scene.bounds(id, "geometry") : null;
    if (box) layout.windows[key] = { x: box.x, y: box.y };
  }
  layout.drawings = (scene.document.groups ?? []).filter((g) => g.parent === undefined && g.meta?.source === "drawn").map((g) => documentOf(g.id));
  try {
    localStorage.setItem(LAYOUT, JSON.stringify(layout));
  } catch {
    // Without storage the board is laid out afresh next time.
  }
}
/** Moves a window by (dx, dy): its frame, its drawing and its controls. */
function moveWindowBy(id: string, dx: number, dy: number): void {
  windows.moveBy(id, dx, dy);
}
/** A window just opened goes where it was last put, if it was moved, and the view follows it there. */
function placeWindow(key: string): void {
  const id = WINDOW_OF[key];
  const to = layout.windows[key];
  if (!id || !to || !scene.getGroup(id)) return;
  const box = scene.bounds(id, "geometry");
  if (!box || (box.x === to.x && box.y === to.y)) return;
  moveWindowBy(id, to.x - box.x, to.y - box.y);
  reveal({ ...box, x: to.x, y: to.y });
}
/** Records a drawing into a group of its own on the board, as the drawing tools do. */
const drawOnBoard = (id: string, draw: (c: RecordingContext) => void, meta: Record<string, JsonValue> = {}): void => board.drawGroup(id, draw, meta);

// Connectors: arrows that hold on to the things they join and are drawn again when those move (see the toolkit's connectors.ts).
/** The box of what a connector's end holds: an icon, content, a demo window or anything else on the board; null when it isn't there. */
const boxOfKey = (key: string): Rect | null => {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === "icon") return desktop.boxOf(id);
  if (kind === "content") {
    const ids = (id === FIELD ? field : (contentIds.get(id) ?? [])).filter(exists);
    return ids.length > 0 ? boxOf(ids) : null;
  }
  if (kind === "window") {
    const group = WINDOW_OF[id];
    return group && scene.getGroup(group) ? (scene.bounds(group, "geometry") ?? null) : null;
  }
  return exists(id) ? (scene.bounds(id) ?? null) : null;
};
/** What a connector's end would hold at a point on the screen: an icon, content, a window or a drawing; null over empty board. */
const keyAt = (screen: Point): string | null => {
  if (cards.hits(screen)) {
    const icon = cards.scene.hitTest(board.router.toWorld(screen)).flatMap((h) => h.groups).map((g) => desktop.iconOf(g)).find((i) => i !== null);
    return icon ? `icon:${icon}` : null;
  }
  const outer = board.outerAt(screen);
  if (outer === null || board.isConnector(outer)) return null;
  for (const [name, ids] of contentIds) if (ids.includes(outer)) return `content:${name}`;
  if (field.includes(outer)) return `content:${FIELD}`;
  const held = withWindows([outer]);
  for (const [key, group] of Object.entries(WINDOW_OF)) if (held.includes(group)) return `window:${key}`;
  return `board:${outer}`;
};
const drawConnector = (id: string, c: Connector): void => board.drawConnector(id, c);

/** Frames around demos drawn straight on the board, moved with all they hold (the toolkit's `Windows`). */
const windows = new Windows({
  board,
  moved: (id, dx, dy) => followMove(id, dx, dy),
  onClose: () => {
    desktop.refresh();
    render();
  },
});
/** The ids, with every window any of them belongs to: its frame and all it holds. */
function withWindows(ids: readonly string[]): string[] {
  return windows.with(ids);
}
/** The demos' windows open now: each one's group (a frame for a drawn demo), title and box. */
function openWindows(): FloorWindow[] {
  const groups: readonly (readonly [string, string, number])[] = [
    [`${PELICAN_ID}:window`, "Pelican", 40],
    [`${PHYSICS_ID}:window`, "Physics", 40],
    [`${GRAPH_ID}:window`, "Graph", 40],
    [`${MORPH_ID}:window`, "Morph", 40],
    [`${PAINT_ID}:window`, "Paint by numbers", 40],
    [TABLE_ID, "A million rows", 44],
    [POINTS_ID, "Ten million points", 46],
    [GALAXY_ID, "Stars and planets", 46],
    [MAP_ID, "World map", 46],
    [BOOK_ID, "War and Peace", 46],
    [DECLARATION_ID, "Human rights in 529 languages", 46],
  ];
  const out: FloorWindow[] = [];
  for (const [id, title, bar] of groups) {
    if (!scene.getGroup(id)) continue;
    const b = scene.bounds(id, "geometry");
    if (b) out.push({ id, title, bar, x: b.x, y: b.y, width: b.width, height: b.height });
  }
  return out;
}
/** Puts a frame with a title bar and a close button around a demo and its controls, as they are now. */
const frameAround = (id: string, title: string, held: readonly string[], close: () => void): void => windows.frame(id, title, held, close);
const unframe = (id: string): void => windows.unframe(id);

const closeReader = (reader: Reader | null): void => {
  reader?.close();
  refreshIcons();
};

// Closing a demo takes its window, and whatever runs it, off the board.
const closePelican = (): void => {
  unframe(PELICAN_ID);
  stopRiding();
  board.components.unmount("pelican-ride");
  if (scene.getGroup(PELICAN_ID)) scene.remove(PELICAN_ID);
};
const closePhysics = (): void => {
  unframe(PHYSICS_ID);
  board.components.unmount("physics-drop");
  if (scene.getGroup(PHYSICS_ID)) scene.remove(PHYSICS_ID);
  sandbox = null;
};
const closeGraph = (): void => {
  unframe(GRAPH_ID);
  graph?.stop();
  graph = null;
  board.components.unmount("graph-shake");
  if (scene.getGroup(GRAPH_ID)) scene.remove(GRAPH_ID);
};
const closeMorph = (): void => {
  unframe(MORPH_ID);
  for (const spec of morphControls(morphTo, (id) => board.components.get(id))) board.components.unmount(spec.id);
  if (scene.getGroup(MORPH_ID)) scene.remove(MORPH_ID);
};
/** The ten thousand shapes' outermost ops and groups, while they're on the board. */
let field: string[] = [];
const fieldOpen = (): boolean => field.some((id) => scene.get(id) !== undefined || scene.getGroup(id) !== undefined);

const closePaint = (): void => {
  unframe(PAINT_ID);
  board.components.unmount(PAINT_ID);
};

// Every demo is an icon on the board, as on a desktop (the toolkit's `Desktop`): pressing one opens its demo's window
// where the window lives and flies there, and pressing it again closes it. Dragged, an icon moves, and stays where it
// was put.
const desktop = new Desktop({
  layer: cards,
  colors: () => cards.colors,
  size: ICON,
  prefix: "feature-",
  // The board stays light in dark mode, so the names keep dark ink.
  ink: "#1f2937",
  moved: layout.icons,
  onMoved: (id, at) => {
    layout.icons[id] = at;
    remember();
  },
  onToggle: (id, opened) => {
    if (opened) placeWindow(id);
    else log("closed it");
  },
  redraw: () => {
    cards.render();
    render();
  },
});
/** An icon with its glyph, at its place in the collage, opening and closing a demo's window. */
const icon = (id: string, name: string, glyph: Glyph, open: (() => boolean) | null, show: () => void, hide?: () => void): void => {
  const at = ICONS[id] ?? { x: 0, y: 0, tilt: 0 };
  desktop.add({ id, name, x: at.x, y: at.y, tilt: at.tilt, tint: tintOf(glyph), show, ...(open ? { open } : {}), ...(hide ? { hide } : {}), draw: (c) => drawGlyph(c, glyph) });
};
icon("pelican", "Pelican", "pelican", () => scene.getGroup(PELICAN_ID) !== undefined, pelicanDemo, closePelican);
icon("physics", "Physics", "physics", () => scene.getGroup(PHYSICS_ID) !== undefined, physicsDemo, closePhysics);
icon("graph", "Graph", "graph", () => scene.getGroup(GRAPH_ID) !== undefined, graphDemo, closeGraph);
icon("morph", "Morph", "morph", () => scene.getGroup(MORPH_ID) !== undefined, morphDemo, closeMorph);
icon("paint", "Paint by numbers", "paint", () => board.components.get(PAINT_ID) !== undefined, () => showPaint(paintingSource()), closePaint);
icon("table", "A million rows", "table", () => table?.alive === true, tableDemo, () => table?.close());
icon("points", "Ten million points", "points", () => points?.alive === true, pointsDemo, () => points?.close());
icon("galaxy", "Stars and planets", "galaxy", () => galaxy?.alive === true, galaxyDemo, () => galaxy?.close());
icon("map", "World map", "map", () => worldMap?.alive === true, mapDemo, () => worldMap?.close());
icon("book", "War and Peace", "book", () => book?.alive === true, bookDemo, () => book?.close());
icon("declaration", "Human rights in 529 languages", "languages", () => rights?.alive === true, declarationDemo, () => rights?.close());
icon("picture", "Paint my image…", "picture", null, () => pictureInput.click());
icon(
  "many",
  "10,000 shapes",
  "many",
  fieldOpen,
  () =>
    void add(sampleNamed(FIELD), layout.content[FIELD] ?? WINDOWS.many).then((ids) => {
      field = ids;
      refreshIcons();
    }),
  () => {
    for (const id of field) if (scene.get(id) !== undefined || scene.getGroup(id) !== undefined) scene.remove(id);
    field = [];
  },
);
/** Draws the icons again, so each shows whether its window is open. */
function refreshIcons(): void {
  desktop.refresh();
}

// Drawings, text and graphics need no icon: they are on the board from the start and explain themselves.
const sampleNamed = (name: string): Sample => samples.find((sample) => sample.name === name)!;
/** The ten thousand shapes: content too, but behind an icon, since it is heavy. */
const FIELD = "10,000 shapes";

/** Opens the board in 3D, starting above what this view shows. */
function viewIn3d(): void {
  try {
    sessionStorage.setItem("canvasIrView", JSON.stringify(view));
  } catch {
    // Without storage the 3D page starts from the whole board.
  }
  (window.top ?? window).location.assign("./babylon.html#tilt");
}
const to3dButton = document.getElementById("to3d") as HTMLButtonElement | null;
if (to3dButton && window === window.top) {
  to3dButton.hidden = false;
  to3dButton.addEventListener("click", viewIn3d);
}

// The controls: the playground and inspector cards.
new Chrome(cards, {
  board,
  feed,
  tools: TOOLS,
  actions: [
    { text: "Play Pelican Ride", look: "accent", onClick: () => (window.top ?? window).location.assign("./game.html") },
    { text: "Drawings in 3D", onClick: () => (window.top ?? window).location.assign("./space.html") },
    { text: "The board in 3D", onClick: () => viewIn3d() },
    { text: "Vectorize image", onClick: vectorizeSelection, title: "select an image, such as the orange sticker, first" },
    { text: "Export SVG", onClick: exportSvg },
    { text: "Export JSON", onClick: () => download("board.json", "application/json", serializeDocument(scene.document)) },
    { text: "Fit the board", onClick: () => setView(board.home()) },
    { text: "Export layout", onClick: () => download("layout.json", "application/json", JSON.stringify(layout, null, 1)), title: "where things are and what is drawn, as a file" },
    {
      text: "Reset layout",
      onClick: () => {
        try {
          localStorage.removeItem(LAYOUT);
        } catch {}
        location.reload();
      },
      title: "forget what was moved, drawn or deleted",
    },
  ],
  settings,
  onLod: () => board.resetRenderer(),
  devtools,
  pasteSvg,
});

// The content goes where it was last put, or to its place in the collage; then the drawings on it, the ones made here
// last time or the collage's own notes and arrows.
for (const [name, at] of Object.entries(CONTENT_AT)) {
  if (layout.removed.includes(name)) continue;
  contentIds.set(name, await add(sampleNamed(name), layout.content[name] ?? at));
}
if (layout.drawings) {
  for (const doc of layout.drawings) {
    try {
      const d = parseDocument(doc);
      const root = d.groups?.find((g) => g.parent === undefined);
      if (root && !scene.getGroup(root.id)) scene.replaceGroup(root.id, d);
    } catch (error) {
      log(`could not draw a saved drawing: ${error}`);
    }
  }
} else {
  for (const d of DRAWINGS) drawOnBoard(d.id, d.draw);
  for (const { id, connector } of CONNECTORS) drawConnector(id, connector);
}
board.adoptConnectors();
remembering = true;
render();
initial = false;
// The board in 3D shows this page in a frame: opened from here, it starts where this view is and tilts down into the room.
const KEPT = "canvasIrView";
const kept = ((): Matrix2D | null => {
  if (window === window.top) return null;
  try {
    const text = sessionStorage.getItem(KEPT);
    sessionStorage.removeItem(KEPT);
    return text ? (JSON.parse(text) as Matrix2D) : null;
  } catch {
    return null;
  }
})();
setView(kept ?? board.home());

