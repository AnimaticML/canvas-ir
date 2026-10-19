# CanvasIR: roadmap after phase 5

Phases 1 to 5 in [design.md](design.md) are done. These are the batches since, in order. Each batch, like each phase, is done when its gate passes in CI.

## Where the document lives

CanvasIR stays a recording, geometry, rendering and interaction layer. It doesn't own the application's document, its components or its undo history.

An app keeps its own document model (for example HTML web components synced through an operational-transformation codec, with ProseMirror for rich text). That model has higher-level components, such as stickers, connectors and text blocks, and its own undo and redo semantics. Each component renders itself into a CanvasIR group with the component's id. When a component changes, only its group is drawn again and swapped into the scene. Undo and redo happen in the document model, and the canvas follows.

What the library needs for that is incremental updates by group, not an undo stack:

- `Scene.replaceGroup(id, document)` swaps a group's ops and nested groups for newly recorded ones in place, keeping its position in drawing order. `LiveText` in `@canvas-ir/text` uses it (done in batch 7).
- Recording a component's drawing on its own, into a document whose group ids are prefixed or scoped to that component, so that two components' ids can't collide.
- A change report from the scene listing which ids changed and the area they covered before and after: `scene.onChange` (done in batch 9). The renderer and the app's own bookkeeping both use it.

## Batch 6: geometry and selection (done)

- **Intersections:** `scene.intersections(a, b)` gives the points where two ops' outlines cross, for fills, strokes, text boxes and image boxes. Lines are exact. Curves are found by subdividing Bézier pieces, then refined with Newton steps.
- **Anchors:** `scene.anchors(id)` returns vertices, curve extremes, segment midpoints, centers, bounding-box corners and edge midpoints, and text baselines and box corners. Each anchor has a kind.
- **Snapping:** `scene.snap(point, { radius, kinds, exclude })` returns the best candidate within the radius from anchors, intersections and closest points on outlines, ranked by kind and then distance. In the playground, drag snapping shows guide marks.
- **Lasso and marquee:** `scene.queryPolygon(points, mode)`, with the same modes as `queryRect` (intersects, contains, enclosed). The playground gets shift-click and marquee multi-select, and moves several objects at once.
- **Offsetting:** `offsetRings(rings, distance)` grows closed outlines with round corners, as rings whose nonzero fill is the union of the region and the band along its outline (`outlineBand`). Shrinking is subtracting that band, which is how text layout pads a container; obstacles get `obstacleMargin`.
- **Transparent paints:** hit tests skip fills and strokes whose paint is fully transparent (`rgba(…, 0)`, `transparent`, or gradients whose stops all have alpha 0), just as they already skip `globalAlpha` 0. `includeInvisible` keeps them for deliberate invisible hit areas.
- **Gate:** intersections of random curves under random transforms match those of a flattening 100 times finer; a grown region holds exactly the points within the distance of the original, away from its edge by the tolerance; text with a margin and padding keeps its distance from obstacles and outline. Snapping and lasso have unit tests.

## Batch 7: text (done)

- **Run data and hyperlinks:** `TextRun` gains `href` and an open `data` object. `drawTextLayout` puts each run that has them in a group, inside its line group, with `{ type: "text-run", href, data }` as meta. A link that wraps becomes one group per line, all sharing the run's index. The playground shows a hover cursor and opens the link on click.
- **Decorations:** underline, strikethrough and overline on runs, drawn as filled rects: underlines and overlines before the text, line-throughs after, as browsers do. Canvas can't read the font's own values, so `decorationMetrics(size, ascent)` reproduces where Chromium draws them: a tenth of the size thick, the underline 0.106 em below the baseline, the line-through centered a third of the ascent above it, the overline on the ascent. Underlines don't skip descenders.
- **Live layout in the library:** `LiveText` binds a text block to a scene, its container and obstacle ids. `update()` reads the obstacles' current outlines (fills as filled, strokes as a band of their width, text and images as boxes), lays the text out and swaps its group through `Scene.replaceGroup`; `dependsOn(id)` says whether a change needs that. The playground uses it.
- **Caret and selection helpers:** `positionAtPoint` maps a point to a source position at a grapheme boundary, `caretRect` maps a position to a caret, and `selectionRects` turns a range into one rect per line (several where bidi splits it), from the fragments' `sourceStart`/`sourceEnd` and prefix measurement. Needed only for editing on the canvas.
- **Gate:** decorations land within 1px of where Chromium's DOM draws `text-decoration`, for every text fixture font at sizes from 11 to 48 px. Links, caret mapping, `replaceGroup` and `LiveText` have unit tests.

## Batch 7.5: components (done)

- **Components:** `Components` binds a group id to a `draw(ctx, state, ui)` function and its state. `setState` records the component again and swaps its group in through `replaceGroup`. The library tracks `hovered`, `pressed`, `focused` and `hoveredParts` (the inner groups under the pointer, such as a link's run) and redraws when they change. Components choose a cursor and handle router events in capture, stopping them to keep a gesture from the board. `move` keeps them where the host dragged them.
- **Router:** presses, drags, key events and clicks keep reaching the groups of an op redrawn mid-gesture under a new id; `refreshHover` re-picks under a still pointer.
- **Hit areas and snapping:** groups with `hitArea: true` make transparent shapes targets; groups with `snap: false` are never snapped to, and `snap` takes a `filter`.
- **Playground:** the note highlights its link on hover and opens it on click; a knob, slider and button set the wrapped text's margin and size. Snapping has controls (on/off, radius, kinds, text), and text laid out against what is being dragged is never a snap target.
- **Gate:** unit tests for redraws during presses, drags and keys, moves, hit areas and snapping filters.

## Batch 8: images (done)

- **Image outlines:** `traceImageOutline(imageData, { threshold, tolerance, minArea })` follows the pixel edges where alpha reaches the threshold (so the rings' nonzero fill is exactly the opaque pixels) and simplifies them with Douglas–Peucker. An `ImageRef` may carry the outline. Hit tests, closest point, snapping to outlines, intersections and text obstacles (`scene.region`) then use the silhouette, cut by the source crop; anchors stay on the box. Tracing happens when an image is described (`describeImage`, or `traceImageSource` in a browser), not at query time.
- **Curve helpers:** `simplifyPolyline` (Douglas–Peucker, open or closed), `smoothPolyline` (centripetal Catmull–Rom through the points), `fitCurve` (Schneider's least-squares cubic fitting within a tolerance, keeping corners sharper than `cornerAngle`; `cornerWindow` measures turns over a few points so pixel staircases read as curves) and `traceCurve`, which draws the pieces into a context or path, straight ones as lines. For freehand drawing and traced outlines.
- **Text around many-vertex obstacles:** a band's x-extent of a region is computed in one pass over its edges, clipped to the band, plus the spans inside it at the band's top, so a traced outline with a margin relays out in a few milliseconds; a benchmark guards it.
- **Screenshot and flat-art vectorizing (an experiment, in `@canvas-ir/vectorize`):**
  - The palette is the most common colors, skipping near duplicates and blends of two colors already chosen, which are anti-aliased edges; every pixel takes its nearest palette color.
  - Each color's pixels are traced and simplified into polygons, or with `curves: true` fitted with cubic Béziers that keep corners sharper than `cornerAngle` and draw straight runs as lines.
  - Fills are emitted largest first. A larger region drops its holes where colors drawn later fill them, so no seams show. The result exports as SVG like any document.
  - Text in a screenshot becomes shapes, not text.
- **Gate:** for test images with soft edges, holes, glyphs, thin lines and specks, drawn as is, scaled and rotated, and cropped, skewed and smoothed, hit tests agree with the painted alpha at every device pixel clear of the outline and crop edge. The vectorizer reports its mean difference and the share of pixels off by more than 32 against UI screenshots and corpus SVGs; tracked, not gated.

## Batch 9: rendering performance (done)

- **A renderer:** `Renderer` binds a scene to a canvas and listens to `scene.onChange`, which reports each op added, changed or removed with the index box it had and has.
- **Redrawing only what changed:**
  1. Each change marks where the op was and where it is as damaged, in device pixels, grown by its shadow (offset and blur) and by `blur()` and `drop-shadow()` filters.
  2. Damaged boxes are merged when that adds little area, split so none overlap, and rounded out to whole pixels. Past half the canvas, everything is redrawn.
  3. The ops whose box meets the damage, found through the index, are replayed in drawing order onto a scratch canvas the size of the target, and the damaged rects are copied over. Chromium rasterizes a path differently under a clip (by up to a whole pixel at edges), so ops are not replayed under a clip to the damage.
  - Composite operations that change pixels outside the op (`copy`, `source-in`, `source-out`, `destination-in`, `destination-atop`) are replayed in every redraw, and changing one, or an op with a filter that can't be bounded, redraws everything.
- **Viewport culling:** a full render replays only ops whose box meets the view.
- **Layers while dragging:** `lift(ids)` renders everything below the lifted ops and everything above them into two cached layers. Each frame then composites, in the damaged rects only, the lower layer, the lifted ops and any ops between them, and the upper layer. Changes to other ops redraw their layer in place, so text that re-wraps around the dragged shape keeps working. Layers are refused when the upper one holds a clear or an op not composited `source-over`, which a cached layer can't reproduce, and dropped when a lifted op is removed.
- **Pans:** a view change by whole pixels moves the canvas's pixels and redraws the uncovered strips.
- **Spatial index for unbounded boards:** the uniform grid is replaced by a hierarchical one. Level k has cells `2^k` times the finest size (1/64 unit by default), and each op sits at the level where its box covers at most 2 x 2 cells. Cell keys are hashed, so the board has no edge. A query visits each nonempty level's cells, or its items when there are fewer of those. A move within the same cells only updates the box, and a translation moves the index box without recomputing it.
  - Groups keep their own ops and child groups indexed, so finding, moving or removing a group's contents no longer scans the board.
  - The group-bounds tree on top of the grid was not needed: with groups indexed, moving 1,000 objects takes about 3 ms, and a query visits only nearby cells at every level.
- **Level of detail (`lod`, on by default, `false` to turn off):** text whose font is under 3 device pixels is drawn as a bar across the middle of its ink box at half alpha; ops under half a device pixel are skipped; images shown at under half their size are drawn from copies halved as often as fits, made once per image.
- **Gate:**
  - After 200 random edits and pans of a board holding every pixel fixture (clips, clears, shadows, filters, gradients, patterns, images, text, `destination-in`), partial redraws match a full replay at every pixel away from an anti-aliased edge. Edge pixels differ in a few hundred places in all, where Chromium anti-aliases depending on what else it rasterized in the same pass. After a pan, more edge pixels differ, by up to a whole pixel on hairlines: Chromium anti-aliases differently at another offset, even a whole pixel away.
  - Dragging tiles with cached layers, with other edits mid-drag, matches a full replay within 2 levels away from edges: compositing a translucent layer rounds once more.
  - A drag on a 10,000-op board, all in view, stays under a 16 ms frame at the 99th percentile. In headless Chromium, a full replay takes about 140 ms a frame; dragging a shape takes about 1 ms with partial redraws and 0.2 ms with layers, and dragging a translucent panel over a third of the view takes about 6 ms with layers (60 ms without).
  - The geometry benchmark adds a board from specks to shapes thousands of units across, queried as at 400% and at 1% zoom, and a step that moves 1,000 objects at once, held to 16 ms at the 90th percentile since its tail is garbage collection.

## Batch 10: tools and demos (done)

- **Devtools:** `captureSource: true` makes the recorder keep, for each op, the stack line of the call that drew it (`getSources()`). Methods go through a wrapper one frame deep, so the caller is found the same way in a minified bundle, and the stack is formatted only when read. The playground's Devtools panel lists every op in drawing order with that line, filters by kind, id, group, sample or source, highlights the op clicked or Alt-clicked on the board and shows its full state (transform, compositing, clip, paint, path), and steps through the drawing op by op.
- **Drawing tools:** pen, rectangle, ellipse and text tools in the playground (keys P, R, O, T, and V to select), recording each new shape as its own group and swapping it into the scene. Corners snap like a drag does, Shift makes squares and circles, and the pen thins the freehand points and fits as few cubic curves as stay within a screen pixel.
- **Charts from unchanged libraries:** D3's scales and shape generators (`line`, `area`, `pie`, `arc`) draw onto the recorder as their context. Chart.js draws into a recorder handed to it as a canvas through its `BasicPlatform`, with `Path2D` pointed at `RecordingPath2D` while it draws, and the drawing is replayed onto the board at its place. Hovering a point or slice shows the datum on its group's meta; hovering a Chart.js bar or point asks the live chart which element is under the pointer.
- **Morph:** `morph(from, to, { key })` pairs ops by id, or with `keyByMeta(field)` by a name on their groups, and `at(t)` builds each frame.
  - Transforms are decomposed into move, turn, scale and skew, and turn the short way, so a rotated shape turns instead of squashing.
  - Colors, gradient stops and shadow colors blend in OKLab, premultiplied, and a transparent end takes the other's hue (`mixColors`). A color against a gradient blends as a flat gradient.
  - Paths are rewritten as cubics in each op's own drawing space, the longest pieces split until both sides have as many, and a closed pair starts and runs where the two line up best. A missing subpath grows from or shrinks to the other's center.
  - Unpaired ops fade out or in where they were in drawing order; pairs that can't blend (a fill and a stroke, different text) cross-fade. The playground morphs a day scene into a night scene drawn apart, with its Play button and slider drawn on the board as components.
- **Embeds:** `ctx.embed(x, y, w, h, content)` records an `embed` op: a place in drawing order for an HTML element. Replayed onto a canvas it clears its rect, in its transform and clip, like `clearRect`; replayed into a recorder it records itself. Hit tests treat it as opaque, covering what was drawn before it. SVG export cuts the same hole and puts the element in a `foreignObject` (an `iframe` for `html` or `src` content).
  - `EmbedLayer` puts each element beneath the canvas with the CSS transform of the view times the op's transform (and its clip as a CSS `clip-path`), one pixel larger than the hole so its anti-aliased edge shows no seam. What is drawn after an embed covers its element and what was drawn before is covered by it, with one canvas.
  - The canvas takes the pointer; `passThrough(id)` lets events through to an element while the pointer is over it, until it leaves or moves onto something drawn over it. An iframe keeps its events, so only leaving it counts there.
  - The playground embeds a real HTML form and a WebGL cube, with a sticker drawn over both.
- **Accessibility:** `accessibilityTree(scene)` reads groups' `role`, `label`, `value`, `min` and `max` meta and the text drawn, in drawing order; a group of text alone continues the paragraph around it, and a control's text names it when it has no label. `AccessibilityLayer` mirrors the tree as transparent DOM elements placed over the board, so screen readers read it, Tab reaches the controls with a visible focus ring, arrows reach them through `router.focusOn` and Enter presses them. Components can make their meta a function of state, so a slider reports its value.
- **Gate:** morph, embeds, source capture and the accessibility tree have unit tests. The renderer's pixel checks run with embeds on the board: partial redraws cut the same holes a full replay does, away from anti-aliased edges.

## Batch 11: motion (done)

- **Live transforms:** `Scene.setTransform(id, matrix)` keeps each op's rest (the op as drawn) while a group it is in has a live transform, and draws it as the product of the live transforms around it, outermost first. Setting one replaces the last, so nothing drifts; the index box is the rest's box moved (exact for moves and scales, conservative under rotation), so placing a group costs no path bounds. Ops inserted into a moving group are taken as drawn in its space, `replace` takes ops as drawn on the board, a `transform` under a live transform goes into the rest, and `replaceGroup` keeps the group's own live transform. Group contents are cached between membership changes. Moving 500 two-op bodies with turns takes about 3 ms a step in Bun.
- **Timeline:** `Clip` (keyframes drawn on first use, morphs prepared per pair, easing per keyframe, looping or held), `motionAt` and `pose` for motion tweens, `Timeline` (tracks with their own start, speed and nested timelines; a held frame is not drawn again), and `Player` (`play`, `stop`, `gotoAndPlay`, `gotoAndStop`, scripts at times or labels, run in order across a loop's end, ending a frame's scripts when one jumps).
- **Physics (`@canvas-ir/physics`):** planck.js bodies over groups. Colliders come from the drawing: `box` (shrunk by Box2D's polygon skin, so drawings touch), `circle`, `hull` (the convex hull of the painted rings, cut to 8 corners by dropping the least area), and `outline` (each painted ring as a chain loop; strokes are left out, so grass along a hilltop is not a wall). Fixed steps, at most five a call; only awake bodies are placed; contacts are reported after the step; `rebind` carries bodies over to a board replayed into a new scene.
- **Playground:** a physics sandbox (crates, balls and stars falling over a ramp, pegs and a curved bowl, dragged on a mouse joint, with a Drop button drawn on the board) and a d3-force graph of 108 nodes drawn once and moved, with only the edges redrawn per tick (about 4 ms a tick placed and drawn).
- **Pelican Ride (`dist/game.html`):** the pelican's drawing split into parts (rider, wheels, wing). The bicycle is a planck frame on two sprung wheel joints, the rear one driven; the rider is a clip of eight poses per crank turn, its time read off the rear wheel's turn, so the feet stay on the pedals at any speed; the wing is a clip of grip, up and down, unfolding, flapping and folding back. Flapping lifts and levels the bike while stamina lasts; fish over the lakes refill it. The camera moves in whole device pixels, so the renderer scrolls what it drew and redraws strips.

## Batch 12: regions and palettes (done)

- **Regions:** `labelRegions` (4- or 8-connected, deterministic ids, bounds, neighbours with shared border lengths) and `traceRegion`, tracing within the region's bounds; `traceMask` takes `bounds` to visit only a box.
- **Shared borders:** `traceBorders` splits the boundaries at junctions, simplifies or fits each border once and hands it to both sides, so regions tile. Junctions and frame points stay put; borders that would cross or flip the turning order at a junction fall back to exact. Below 0.5 pixels of tolerance every pixel's center stays in its region.
- **Vectorize:** a fixed `palette` with stable ids, nearest by OKLab; `colors` and `indices`, the index map the fills trace; `layout: "regions"`, one fill per area from shared borders, with `minArea` merging specks into their longest-bordered neighbour. For photos, `quantize: "kmeans"` (deterministic seeds, weighted by pixel count) and `smooth`, a majority filter over the index map.
- **Playground:** paint by numbers, from the built-in painting with a fixed palette or a picture of yours clustered into 6 to 24 colors; numbers sit at each region's point farthest from its edges, and clicks pick regions from the index map.

Not planned: WebGL or PDF backends, pixel access (`getImageData` and friends), and paints made by another context.
