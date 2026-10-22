# CanvasIR

CanvasIR is a stand-in for `CanvasRenderingContext2D` that records drawing instead of painting it. Code that draws to a canvas (an SVG-to-canvas renderer, a chart library, your own shapes, a text layout) can draw into it unchanged. The result is a typed, JSON-safe document that geometry queries, transforms, rendering and interaction can all work from, without a browser.

Design: [docs/design.md](docs/design.md). What comes next: [docs/roadmap.md](docs/roadmap.md).

## Status

All five phases: recording, the IR, serialization and replay; geometry queries; the full Canvas 2D drawing API; rich text layout; groups, events and SVG export, with a playground.

| Works now | Not yet |
| --- | --- |
| Paths with the spec's construction rules, including `arc`, `arcTo`, `ellipse`, `roundRect`, and `Path2D` with SVG path data | Pixel access: `getImageData`, `putImageData`, `createImageData` |
| `fill`, `stroke`, `clip`, the rect helpers, `isPointInPath`, `isPointInStroke` | Patterns or gradients made by another context |
| Colors (normalized like browsers), gradients and patterns | |
| `drawImage`, `fillText`, `strokeText`, `measureText`; images hit-test by their opaque pixels when traced | |
| All transform calls, `save`/`restore`/`reset`, line styles and dashes, alpha, compositing, shadows, filter, image smoothing | Canvas composite operations other than source-over and the blend modes, in SVG export |
| Replay onto any real 2D context; validated JSON round trip | |
| A renderer that redraws only what changed, culls what is out of view, caches layers while dragging and simplifies what is too small to see | |
| Groups, an event router with capture and bubbling, components drawn from state, SVG export | |
| Morphing between drawings; HTML and WebGL elements placed in drawing order; an accessibility tree | |
| Live transforms, a Flash-style timeline (clips, motion tweens, labels, frame scripts), 2D physics with planck.js | |
| Rich text layout: paragraphs, headings, lists, mixed fonts, decorations, links, any-shaped containers, obstacles, bidi, caret and selection | |
| Geometry: exact bounds, hit tests, rect and lasso queries, closest point, intersections, anchors, snapping, outline offsetting, moving ops | |
| Connected regions of a labeled image, traced with shared borders that tile it; vectorizing to a fixed palette with its index map | |

Unsupported calls throw `UnsupportedCanvasCallError` rather than silently drawing nothing.

All of it is checked in headless Chromium. Every fixture in [`packages/pixel`](packages/pixel/src/fixtures.ts), and every SVG in its [corpus](packages/pixel/corpus) drawn by [canvg](https://github.com/canvg/canvg), is drawn directly and also recorded, serialized, parsed and replayed, and the two canvases must match pixel for pixel. Hit tests on the same drawings must agree with Chromium's own `isPointInPath` and `isPointInStroke` everywhere away from an edge, and with the pixels painted for images and text. Each drawing's SVG export, rendered by Chromium, must match its replay everywhere away from anti-aliased edges. Rich text laid out by `@canvas-ir/text` must wrap where Chromium's DOM layout wraps the same paragraphs, with lines at the same heights and the same horizontal extents, in Latin, CJK, Thai, Arabic, Hebrew and mixed-direction text, and its underlines, line-throughs and overlines must land within a pixel of the DOM's in every fixture font. Traced image outlines, under transforms, crops and smoothing, must hit-test exactly where Chromium paints the image opaque, away from the outline. After random edits to a board of every fixture, the renderer's partial redraws must match a full replay away from anti-aliased edges, and its cached layers within rounding; a drag on a 10,000-op board must stay under a 16 ms frame. A benchmark keeps every query on a 10,000-op board, and text layout around a traced outline, under budget (`bun run bench`).

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

`packages/playground` puts this together: sample SVGs drawn through canvg, rich text (with decorations and a link that highlights on hover, in a circle, and flowing around a shape that re-lays it out as you drag it), a knob, a slider and a button built as components that change the wrapped text, canvas shapes, D3 and Chart.js charts, a day-to-night morph, a pelican riding a bicycle (eight drawn poses per pedal turn, morphed into every frame between), a physics sandbox of crates, balls and stars to throw around, a force-directed graph, an HTML form and a WebGL cube embedded on the board, and pen, rectangle, ellipse and text tools, on one board, with snapping settings, hover and selection outlines, dragging, zoom and pan, SVG and JSON export, a Devtools panel and an accessibility tree. It renders through `Renderer` and shows what each frame redrew; a button adds 10,000 shapes to try it on a big board. Its **Pelican Ride** page is a small game built the same way: the pelican pedals a bicycle on sprung wheel joints over hills, crates and lakes, flaps over the water and catches fish. Run it with `bun run --cwd packages/playground dev`, or build self-contained files with `bun run --cwd packages/playground build` (`dist/index.html` and `dist/game.html`).

## Rendering

`Renderer` keeps a canvas in step with a scene. It listens to the scene's changes, and each `render()` redraws only where ops were and are now, shadows and filters included, replaying just the ops there, found through the scene's index. Ops out of view are never replayed.

```ts
const renderer = new Renderer(scene, canvas.getContext("2d")!, { images: (src) => images.get(src), background: "#fff" });
renderer.setView(deviceMatrix, canvas.width, canvas.height);
scene.transform("g1", { a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 });
renderer.render(); // { mode: "partial", ops: 12, rects: [...] }

renderer.lift(["g1"]); // while dragging g1: cache what is below and above it
renderer.drop();
```

- Damaged areas are redrawn on a scratch canvas the size of the target and copied over, rather than replayed under a clip: Chromium rasterizes a path differently under a clip, so this keeps every pixel away from an edge what a full replay paints.
- `lift(ids)` caches everything below and above the lifted ops as two layers, so a drag frame draws a bitmap, the lifted ops and another bitmap, in the damaged area only. Layers aren't used when something above isn't composited `source-over`.
- A pan by whole pixels moves the canvas's pixels and redraws the uncovered strips. Any other view change redraws everything.
- `copy`, `destination-in` and the other composite operations that clear outside their shape, and filters it can't bound, make a change redraw everything.
- What is too small to see is simplified by default: text under 3 device pixels becomes a bar, ops under half a pixel are skipped, and images shown at under half size are drawn from halved copies. `lod: false` draws everything as a full replay does; `lod: { textBelow, skipBelow, images }` tunes it.

The scene's index is a hierarchical grid: each op sits at the level where its box covers at most 2 x 2 cells, so specks and huge shapes alike are found quickly at any zoom, and moving one is constant time. Groups keep their ops indexed, so moving or removing a group touches only its own ops.

## Tools and demos

- **Where each op came from:** `new RecordingContext({ captureSource: true })` keeps the stack line of the call that drew each op; `getSources()` maps op ids to lines such as `drawBadge (app.js:12:7)`. The playground's Devtools panel lists ops with them, shows an op's state and steps through the drawing.
- **Morph:** `morph(from, to).at(t)` blends two drawings, pairing ops by id or, with `keyByMeta("name")`, by a name on their groups. Transforms turn rather than squash, colors blend in OKLab, paths become matching cubics, and what has no partner fades.

```ts
const m = morph(day, night, { key: keyByMeta("name") });
scene.replaceGroup("scene", m.at(0.4));
```

- **Live transforms:** `scene.setTransform(id, matrix)` places a group (or op) where it is drawn, relative to how it was drawn. Setting it again replaces it, so a body moved by physics sixty times a second is never recorded again and never drifts. Nested live transforms compose, and ops redrawn into a moving group, by a component or `replaceGroup`, are drawn in its moving space.
- **Timeline:** Flash's time model. A `Clip` is drawn keyframes and the morph between each pair (a shape tween), looping or held; `motionAt` keyframes a transform (a motion tween). A `Timeline` runs tracks, each a group with a clip, a motion or a nested timeline on its own clock, and a `Player` plays it with `play`, `stop`, `gotoAndPlay(label)` and scripts on frames.

```ts
const pedal = new Clip(crankAngles.map((crank, i) => ({ at: i / 8, drawing: () => drawing("rider", (ctx) => drawRider(ctx, crank)) })), { loop: true });
const timeline = new Timeline([
  { target: "bike", motion: [{ at: 0, transform: pose({ x: 0 }) }, { at: 4, transform: pose({ x: 800 }) }] },
  { target: "rider", parent: "bike", clip: pedal, speed: 2 },
], { labels: { finish: 4 } });
new Player(timeline, scene).play();
```

- **Physics:** `@canvas-ir/physics` runs [planck.js](https://github.com/piqnt/planck.js), a port of Box2D, over a scene. `physics.add(id, { collider })` makes a group a body, with its collider read off what was drawn: its box, a circle, the convex hull of what was painted, or for ground of any shape the painted outline itself. `step(seconds)` advances in fixed steps and moves awake bodies by live transforms; `grab`, `drag` and `release` pull a body on a spring; `attach` binds a body built directly with planck (the game's bicycle frame on wheel joints).

```ts
const physics = new Physics(scene, { gravity: { x: 0, y: 980 } });
physics.add("ground", { collider: "outline" });
physics.add("crate");
requestAnimationFrame(function frame(now) { physics.step(1 / 60); renderer.render(); requestAnimationFrame(frame); });
```

- **Embeds:** `ctx.embed(x, y, w, h, { type: "video" })` reserves a place in drawing order for an HTML element. On a canvas it cuts a hole; `EmbedLayer` puts your element beneath the canvas in that hole, so shapes drawn later cover it and earlier ones don't, and lets the pointer through to it.

```ts
const layer = new EmbedLayer(scene, container, canvas, { create: (op) => makeElement(op.content) });
layer.setView(view); // world to CSS pixels
router.on("*", "enter", (e) => e.op?.kind === "embed" && layer.passThrough(e.op.id));
```

- **Accessibility:** give groups `role` and `label` meta (`{ role: "button", label: "Save" }`, or `{ role: "slider", value, min, max }`). `accessibilityTree(scene)` reads them with the text drawn; `AccessibilityLayer` mirrors the tree as DOM over the canvas for screen readers and the keyboard, and `router.focusOn(id)` sends keys to what Tab reached.
- **Charts:** D3 and Chart.js draw into the recorder unchanged (see `packages/playground/src/charts.ts`); every bar and point is an object you can hover and select.

## Images

`traceImageOutline(imageData, { threshold, tolerance, minArea })` traces where an image is opaque into rings in its pixel space: pixel edges, simplified to within `tolerance`. Give it to the recording context through `describeImage`, and hit tests, closest points, snapping and text layout use the silhouette instead of the box. `traceImageSource(image, width, height)` does the reading through an `OffscreenCanvas`.

```ts
const recorder = new RecordingContext({
  describeImage: (img) => ({ src: srcOf(img), width: 180, height: 140, outline: traceImageSource(img, 180, 140) }),
});
```

`@canvas-ir/vectorize` is an experiment for flat art and UI screenshots: `vectorize(imageData)` picks a small palette (folding anti-aliased blends of two palette colors into them), traces each color's pixels, and returns a document of fills, largest first, so smaller regions sit on top and larger ones need no holes for them. `curves: true` fits cubic Béziers to the outlines instead of polygons, keeping sharp corners. The pixel run reports how close the replay comes to each source, in both modes; it isn't gated.

For paint-by-number style work it takes a fixed palette and gives back its index map. `palette: [{ id, color }]` assigns every opaque pixel to the nearest color by OKLab distance, adds none and keeps the ids and order (`colors` lists each with its pixel count, unused ones too); `indices` is each pixel's index into `colors`, -1 for transparent, and is what the fills trace. `layout: "regions"` draws each 4-connected area as its own fill, holes kept, with `{ region, color, colorId, pixels }` meta and the `regions` map; `minArea` there folds smaller areas into the neighbour they share the longest border with, in `indices` too. For photos and gradients, `quantize: "kmeans"` clusters `maxColors` colors in OKLab instead of taking the most common ones, and `smooth: radius` runs a Gaussian mode filter over the index map (each pixel takes the color most of its surroundings took), so grain doesn't speckle every region and shading bands come out as smooth shapes. The playground's Paint by numbers demo shows both: a painting matched to a fixed palette, and "Paint my image…" for a picture of your own.

## Regions

`labelRegions(width, height, values, { connectivity: 4 | 8, empty })` splits a labeled image (palette indices, say) into connected regions: a label per pixel, and per region its value, area, bounds and neighbours with the length of each shared border, ids in scan order so the same values give the same ids. `traceRegion(map, id)` traces one region within its bounds, holes included; `traceMask(width, height, inside, { bounds })` does the same for any mask, visiting only the box. `traceBorders(map, { tolerance, curves, cornerAngle })` traces all regions at once: each border between two regions is found, simplified or fitted with curves once and walked forwards by one and backwards by the other, so filling every region (`traceRegionPath(ctx, outlines, id)`, or `regionRings` for points) leaves no gap and no overlap. Junctions and the image's frame stay on the pixel lattice, and a border that would cross another, or turn a region inside out at a junction, goes back to the exact pixel edges. With `tolerance` below 0.5 every pixel's center also stays in its own region; 0 keeps every border exact.

## Curves

`simplifyPolyline(points, tolerance, closed)` drops points a line stays within `tolerance` of. `smoothPolyline(points, closed)` turns a polyline into cubic pieces through every point (centripetal Catmull–Rom). `fitCurve(points, tolerance, { closed, cornerAngle, cornerWindow })` fits as few cubics as stay within `tolerance`, keeping turns sharper than `cornerAngle` as corners; a `cornerWindow` of a few points measures turns over a span, so a traced pixel staircase reads as a curve and a box keeps its corners. `traceCurve(ctx, pieces, closed)` draws the pieces, straight ones as `lineTo`. For freehand strokes: `traceCurve(ctx, fitCurve(simplifyPolyline(points, 0.5, false), 1), false)`.

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
- A hierarchical grid narrows each query to nearby ops, at any object size. Moving or replacing an op recomputes only that op.
- A `clearRect` hides whatever it covers from hit tests. Ops that paint nothing visible (`globalAlpha` 0, or a fully transparent color or gradient) are skipped unless asked for, so a click goes through them to what's underneath.
- Snapping ranks candidates by kind (vertex, intersection, center, midpoint, extreme, baseline, bounds, then the nearest point on an outline), and the nearest within a kind. Anchors come from the recorded segments, so arc centers and curve extremes are exact; intersections are exact for straight edges and within the tolerance for curves.
- `offsetRings` grows an outline with round corners, and `outlineBand` is the strip along it. Text layout uses them for `obstacleMargin` and `padding`.
- A point must be inside every clip path of an op to hit it. Images hit-test as the part of their destination the source covers, or, when their `ImageRef` carries an `outline`, as that silhouette within it; text hit-tests as its ink box from the recorded measurement.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run bench
bun run test:pixel   # needs Chromium; set CHROMIUM_PATH if Playwright can't find one
```

`packages/core` is the library, `packages/text` the text layout layer on top of it, `packages/physics` the physics layer, `packages/vectorize` the vectorizer experiment, `packages/pixel` holds the browser checks, and `packages/playground` is a demo app that depends on both libraries. After changing a text fixture, run `bun run --cwd packages/pixel capture-text` to capture its measurements and layout from Chromium for the Bun tests. Tooling depends on the libraries, never the reverse. `SVG_DEBUG=<drawing name>` on the pixel run writes that drawing's SVG export and both renderings to `SVG_DEBUG_DIR`.

### Optional short-detour cleanup for shared borders

`traceBorders(map, { curves: true, tolerance: 1.2, cornerAngle: 90,
 detourSize: 2.5 })` can remove tiny hairpins before curve fitting. The default
`detourSize: 0` retains existing behavior. A shortcut requires a neck no wider
than the requested size, an excursion bounded by four times that size, and a
path length bounded by twelve times the size. Long thin limbs or strokes are
not removed merely because they are narrow. Junction endpoints stay fixed;
closed rings retain winding and at least half their area. Both regions use the
same modified border. Existing intersection/junction checks reduce the cleanup
or return to exact edges where necessary. Canonical labels and region IDs are
unchanged; applications should hit-test the resulting paths when selecting
what is visibly painted. Cleanup intentionally permits more displacement than
the ordinary fitting tolerance. `simplifyDetours` exposes the polyline operation
separately, without a region topology guarantee.

`traceBorders(..., { microLoopSize: 3.25 })` optionally repairs actual fitted
self-intersections inside a cubic or across up to four neighboring pieces.
Single-cubic loops are solved analytically; crossings between pieces use
curvature-bounded sampling followed by Newton refinement. Only loops fitting
inside the requested size are removed. If the entire intersecting window is
microscopic it becomes a tangent-preserving curved connector; otherwise the unaffected portions
are kept by exact Bézier splitting. Open endpoints stay fixed, regular tiny
holes and long narrow shapes are not removed, and closed-ring winding and at
least half its signed area are retained. This is independent of smoothing and
`detourSize`, disabled by default. Shared-border intersection guards still run.
The standalone helper is `removeMicroLoops`.

`traceBorders(..., { curves: true, localFallback: true })` limits topology
fallback to source-anchored curve groups. An intersection near a junction no
longer coarsens a distant wave on the same shared border. Artificial joins keep
the original tangent directions where curved fitting is safe; exact pixel edges
remain the final local fallback. Default false preserves existing behavior.
Microscopic loop connectors preserve incoming and outgoing tangents rather than
replacing the entire window with a straight chord. Canonical labels and shared
border/ring IDs remain unchanged.
