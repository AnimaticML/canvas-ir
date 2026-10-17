# CanvasIR

CanvasIR is a stand-in for `CanvasRenderingContext2D` that records drawing instead of painting it. Code that draws to a canvas (an SVG-to-canvas renderer, a chart library, your own shapes, a text layout) can draw into it unchanged. The result is a typed, JSON-safe document that geometry queries, transforms, rendering and interaction can all work from, without a browser.

Design: [docs/design.md](docs/design.md). What comes next: [docs/roadmap.md](docs/roadmap.md).

## Status

All five phases: recording, the IR, serialization and replay; geometry queries; the full Canvas 2D drawing API; rich text layout; groups, events and SVG export, with a playground.

| Works now | Not yet |
| --- | --- |
| Paths with the spec's construction rules, including `arc`, `arcTo`, `ellipse`, `roundRect`, and `Path2D` with SVG path data | Pixel access: `getImageData`, `putImageData`, `createImageData` |
| `fill`, `stroke`, `clip`, the rect helpers, `isPointInPath`, `isPointInStroke` | Patterns or gradients made by another context |
| Colors (normalized like browsers), gradients and patterns | Caret and selection helpers for editors |
| `drawImage`, `fillText`, `strokeText`, `measureText` | Image hit tests by their opaque pixels (batch 8) |
| All transform calls, `save`/`restore`/`reset`, line styles and dashes, alpha, compositing, shadows, filter, image smoothing | Canvas composite operations other than source-over and the blend modes, in SVG export |
| Replay onto any real 2D context; validated JSON round trip | |
| Groups, an event router with capture and bubbling, SVG export | |
| Rich text layout: paragraphs, headings, lists, mixed fonts, any-shaped containers, obstacles, bidi | |
| Geometry: exact bounds, hit tests, rect and lasso queries, closest point, intersections, anchors, snapping, outline offsetting, moving ops | |

Unsupported calls throw `UnsupportedCanvasCallError` rather than silently drawing nothing.

All of it is checked in headless Chromium. Every fixture in [`packages/pixel`](packages/pixel/src/fixtures.ts), and every SVG in its [corpus](packages/pixel/corpus) drawn by [canvg](https://github.com/canvg/canvg), is drawn directly and also recorded, serialized, parsed and replayed, and the two canvases must match pixel for pixel. Hit tests on the same drawings must agree with Chromium's own `isPointInPath` and `isPointInStroke` everywhere away from an edge, and with the pixels painted for images and text. Each drawing's SVG export, rendered by Chromium, must match its replay everywhere away from anti-aliased edges. Rich text laid out by `@canvas-ir/text` must wrap where Chromium's DOM layout wraps the same paragraphs, with lines at the same heights and the same horizontal extents, in Latin, CJK, Thai, Arabic, Hebrew and mixed-direction text, and its underlines, line-throughs and overlines must land within a pixel of the DOM's in every fixture font. A benchmark keeps every query on a 10,000-op board under budget (`bun run bench`).

## Use

```ts
import { RecordingContext, Scene, replayDocument, serializeDocument } from "canvas-ir";

const ctx = new RecordingContext();
ctx.translate(50, 50);
ctx.beginPath();
ctx.arc(0, 0, 20, 0, Math.PI * 2);
ctx.fillStyle = "#0ea5e9";
ctx.fill();
ctx.drawImage(img, 0, 0);    // stored by reference: { src, width, height }
ctx.fillText("Hi", 10, 80);  // measured when drawn, so geometry needs no fonts

const doc = ctx.getDocument();
const json = serializeDocument(doc);

// Later, in a browser; images are looked up by the src they were recorded with:
replayDocument(canvas.getContext("2d")!, doc, { images: (src) => imageCache.get(src) });

// Anywhere, no browser needed:
const scene = new Scene(doc);
scene.hitTest({ x: 55, y: 50 });                           // [{ id: "o0", op }], topmost first
scene.bounds("o0");                                        // { x: 30, y: 30, width: 40, height: 40 }
scene.queryRect({ x: 0, y: 0, width: 100, height: 100 }); // ["o0"]
scene.transform("o0", { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
scene.queryPolygon(lassoPoints);                          // ops a lasso touches ("enclosed" for inside only)
scene.intersections("o0", "o1");                          // where two outlines cross
scene.anchors("o0");                                      // vertices, midpoints, centers, extremes, box points
scene.snap(pointer, { radius: 8, exclude: ["dragged"] }); // { point, kind, ids, distance } or null
```

## Groups, events and SVG

`beginGroup` and `endGroup` are extension calls on the recording context. Ops drawn between them belong to the group, groups nest, and a group can carry JSON `meta`. Hits report the op and its group chain, and the scene can bound, move and remove a group as one object. `scene.replaceGroup(id, document)` swaps a group's drawing for a newly recorded one in place, in drawing order, with nested ids prefixed by `id/`: that is how a component that draws itself into a group redraws after a change. Groups are separate from `save`/`restore`.

```ts
import { EventRouter, toSVG } from "canvas-ir";

ctx.beginGroup({ id: "badge", meta: { source: "badge.svg" } });
// ...draw...
ctx.endGroup();

const router = new EventRouter(scene, { view }); // view: world to host pixels
router.on("badge", "drag", (e) => scene.transform("badge", { a: 1, b: 0, c: 0, d: 1, e: e.delta!.x, f: e.delta!.y }));
router.on("*", "click", (e) => console.log(e.target, e.path)); // op id, then its groups
canvas.addEventListener("pointerdown", (e) => router.pointerDown({ x: e.offsetX, y: e.offsetY }));
// ...and pointerMove, pointerUp, pointerLeave, wheel, keyDown, keyUp

const svg = toSVG(scene.document, { width: 800, height: 600 });
```

The router dispatches `down`, `up`, `click`, `dragstart`, `drag`, `dragend`, `wheel`, `keydown` and `keyup` like the DOM: capture from `"*"` and the outermost group down to the op, then bubbling back up, with `stopPropagation`. `enter` and `leave` go to each op and group the pointer crosses and don't bubble. Hover and selection state stay with the host.

SVG export keeps arcs and ellipses as elliptical arcs under any transform, and writes groups as `<g data-group>` with their meta. Where SVG has no equal it draws the nearest thing: a conic gradient is a CSS `conic-gradient`, `clearRect` masks out what came before it, and shadows are filters drawn under the shape. Images are referenced by `src`, or by whatever `images` maps it to; an SVG shown with `<img>` needs data URLs.

### Components

A component is an interactive object drawn from state: a button, a knob, a link that highlights on hover. It owns a group, and draws it again through `replaceGroup` whenever its state or its pointer state changes. The ops are output, like pixels; what you change is the component's state, or your own document's object that a component draws.

```ts
import { Components } from "canvas-ir";

const components = new Components(scene, router, { onChange: () => render() });
components.mount({
  id: "save",
  state: { saved: false },
  cursor: "pointer",
  draw: (ctx, state, ui) => {
    // ui: { hovered, pressed, focused, hoveredParts } — hoveredParts names the inner groups under the pointer
    ctx.fillStyle = ui.pressed ? "#1d4ed8" : ui.hovered ? "#3b82f6" : "#2563eb";
    ctx.fillRect(0, 0, 90, 30);
  },
  on: { click: (e, c) => { c.setState({ saved: true }); e.stopPropagation(); } },
});
components.move("save", { a: 1, b: 0, c: 0, d: 1, e: 40, f: 0 }); // moves it now and in later drawings
canvas.style.cursor = components.cursor ?? "";
```

Handlers run in capture, before the board's own listeners, so a knob that stops its drags keeps them from moving it. Presses, drags and keys keep reaching a component that redraws mid-gesture under new op ids. A group whose meta has `hitArea: true` makes transparent shapes hit targets (a slider's grip); one with `snap: false` is never snapped to, and `snap` also takes a `filter`.

`packages/playground` puts this together: sample SVGs drawn through canvg, rich text (with decorations and a link that highlights on hover, in a circle, and flowing around a shape that re-lays it out as you drag it), a knob, a slider and a button built as components that change the wrapped text, and canvas shapes on one board, with snapping settings, hover and selection outlines, dragging, zoom and pan, and SVG and JSON export. Run it with `bun run --cwd packages/playground dev`, or build one self-contained file with `bun run --cwd packages/playground build`.

## Text layout

`@canvas-ir/text` lays out rich text with [Pretext](https://github.com/chenglou/pretext), so lines break where a browser would break them, and draws it as `fillText` calls into any context, a `RecordingContext` included.

```ts
import { drawTextLayout, layoutText } from "@canvas-ir/text";
import { pathRings } from "canvas-ir";

const layout = layoutText(
  {
    blocks: [
      { type: "heading", level: 2, content: ["Release notes"] },
      { type: "paragraph", content: ["Text can be ", { text: "bold", bold: true }, " or ", { text: "code", code: true }, "."] },
      { type: "list", items: [[{ type: "paragraph", content: ["Lists nest and number."] }]] },
    ],
  },
  {
    container: { x: 0, y: 0, width: 320 },     // or { rings: pathRings(path) } for any shape
    obstacles: [{ rings: pathRings(imagePath) }], // text flows around these
    theme: { fontFamily: '"Inter", sans-serif', fontSize: 16 },
  },
);
drawTextLayout(ctx, layout); // one fillText per run; layout.lines has every line's box and baseline
```

The layout records the Pretext version, the line-breaking engine and every font it measured in `layout.fingerprint`, so a host can tell when a stored layout came from another environment.

Runs can be `underline`, `strikethrough` or `overline`; the lines are filled rects placed where Chromium's DOM places `text-decoration` (`decorationMetrics`), within a pixel. A run with an `href` or a `data` object is drawn in a group of its own, one per line it spans, with `{ type: "text-run", paragraph, run, href, data }` as meta, so a hit names the link. Links take the theme's `linkColor` and are underlined unless `linkUnderline` is off.

```ts
import { LiveText, caretRect, positionAtPoint, selectionRects } from "@canvas-ir/text";

// Text bound to the scene: obstacles are read from it, and update() swaps the block's group.
const live = new LiveText(scene, { id: "caption", text, container, obstacles: ["photo"], obstacleMargin: 8 });
live.update();
if (live.dependsOn(movedId)) live.update();

const p = positionAtPoint(live.layout!, point); // { paragraph, run, offset, line }, at a grapheme boundary
caretRect(live.layout!, p!);                     // { x, top, height, line }
selectionRects(live.layout!, p!, other);         // one rect per line, bidi-aware
```

## How the IR stores drawing

- Each op (`fill`, `stroke`, `clear`, `image`, `text`) keeps the transform, drawing state and clip in effect when it was painted. A clip is stored on each op it applies to as a list of paths, so every op stands alone.
- Paints are plain data: a color string, or a gradient or pattern with its stops, geometry and transform as they were when the op was drawn.
- Images are references (`src`, width, height); `describeImage` decides what a reference is, and replay resolves it with `images`. Text keeps its string, font state and the measurement taken when it was drawn; measurement can be injected with `measureText`.
- Path coordinates are stored as the caller passed them. Each subpath start and segment points at the matrix that was current when it was added, so a path built across transform changes stays exact, and `arc`/`ellipse` stay true curves under any transform.
- `arc` and `ellipse` are kept as separate segment kinds, and a path an `arc` or `ellipse` began records that it had no `moveTo`, because browsers rasterize those cases differently.
- Calls follow the Canvas 2D spec: `lineTo` with no subpath acts as `moveTo`, `arc` adds a line to its start point, `closePath` starts a new subpath at the old start, and calls with `NaN` or `Infinity` are ignored.

## How geometry works

- `Scene` derives a shape per op on first use and caches it: the path flattened in world space for fills, and for strokes a union of convex pieces (a quad per segment, plus joins and caps) built in the stroke's own space, so width, dashes and joins stay right under non-uniform scale and skew.
- Bounds are exact: curve and arc extrema are solved analytically. Hit tests and rect queries are exact for lines and within the flattening tolerance (default 0.1 world units) for curves.
- A uniform grid narrows each query to nearby ops. Moving or replacing an op recomputes only that op.
- A `clearRect` hides whatever it covers from hit tests. Ops that paint nothing visible (`globalAlpha` 0, or a fully transparent color or gradient) are skipped unless asked for, so a click goes through them to what's underneath.
- Snapping ranks candidates by kind (vertex, intersection, center, midpoint, extreme, baseline, bounds, then the nearest point on an outline), and the nearest within a kind. Anchors come from the recorded segments, so arc centers and curve extremes are exact; intersections are exact for straight edges and within the tolerance for curves.
- `offsetRings` grows an outline with round corners, and `outlineBand` is the strip along it. Text layout uses them for `obstacleMargin` and `padding`.
- A point must be inside every clip path of an op to hit it. Images hit-test as the part of their destination the source covers, text as its ink box from the recorded measurement.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run bench
bun run test:pixel   # needs Chromium; set CHROMIUM_PATH if Playwright can't find one
```

`packages/core` is the library, `packages/text` the text layout layer on top of it, `packages/pixel` holds the browser checks, and `packages/playground` is a demo app that depends on both libraries. After changing a text fixture, run `bun run --cwd packages/pixel capture-text` to capture its measurements and layout from Chromium for the Bun tests. Tooling depends on the libraries, never the reverse. `SVG_DEBUG=<drawing name>` on the pixel run writes that drawing's SVG export and both renderings to `SVG_DEBUG_DIR`.
