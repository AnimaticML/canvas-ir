# CanvasIR: roadmap after phase 5

Phases 1 to 5 in [design.md](design.md) are done. These are the next batches, in order. Each batch, like each phase, is done when its gate passes in CI.

## Where the document lives

CanvasIR stays a recording, geometry, rendering and interaction layer. It doesn't own the application's document, its components or its undo history.

An app keeps its own document model (for example HTML web components synced through an operational-transformation codec, with ProseMirror for rich text). That model has higher-level components, such as stickers, connectors and text blocks, and its own undo and redo semantics. Each component renders itself into a CanvasIR group with the component's id. When a component changes, only its group is drawn again and swapped into the scene. Undo and redo happen in the document model, and the canvas follows.

What the library needs for that is incremental updates by group, not an undo stack:

- `Scene.replaceGroup(id, document)` swaps a group's ops and nested groups for newly recorded ones in place, keeping its position in drawing order. `LiveText` in `@canvas-ir/text` uses it (done in batch 7).
- Recording a component's drawing on its own, into a document whose group ids are prefixed or scoped to that component, so that two components' ids can't collide.
- A change report from the scene listing which ids changed and the area they covered before and after. Redrawing only what changed (batch 9) and the app's own bookkeeping both use it.

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
- **Screenshot and flat-art vectorizing (an experiment, in `@canvas-ir/vectorize`):**
  - The palette is the most common colors, skipping near duplicates and blends of two colors already chosen, which are anti-aliased edges; every pixel takes its nearest palette color.
  - Each color's pixels are traced and simplified. Fitting arcs and curves is not done yet: outlines are polygons.
  - Fills are emitted largest first. A larger region drops its holes where colors drawn later fill them, so no seams show. The result exports as SVG like any document.
  - Text in a screenshot becomes shapes, not text.
- **Gate:** for test images with soft edges, holes, glyphs, thin lines and specks, drawn as is, scaled and rotated, and cropped, skewed and smoothed, hit tests agree with the painted alpha at every device pixel clear of the outline and crop edge. The vectorizer reports its mean difference and the share of pixels off by more than 32 against UI screenshots and corpus SVGs; tracked, not gated.

## Batch 9: rendering performance

- **Viewport culling:** `replayDocument` takes a visible rect and replays only ops whose paint box meets it, found through the scene's spatial index.
- **Redrawing only what changed:**
  1. Collect the paint boxes a change touched: where the moved object was and where it is now, shadows and blur included.
  2. Clip the canvas to their union and clear it there.
  3. Replay, in drawing order, only the ops that meet that area.
  - Everything outside the area stays as it was.
  - Composite operations that affect pixels outside the op (`copy`, `destination-in` and similar) force a full redraw.
- **Layers while dragging:** cache what's below the dragged object and what's above it as two bitmaps. Each frame then draws three things: the lower bitmap, the moving object, and the upper bitmap.
- **Spatial index for unbounded boards:** the current index is one uniform grid of 128-unit cells, with ops spanning more than 64 cells kept on a list every query checks. It is cheap to update, which matters most when many objects move at once. It degrades in two cases. When a board zoomed to 1% has thousands of large objects, they all land on that list. When a board zoomed to 400% packs thousands of tiny objects into one cell, a query scans them all. Its coordinates are also bounded.
  - Replace it with a hierarchical grid: several levels with cell sizes a power of 4 apart, and each op stored at the level where it covers at most four cells. Updates stay constant time, any size of object finds its level, and cell keys are hashed, so the world has no edge.
  - Use the group tree on top of it. A group's bounds are the union of its children's, so a query that misses a group skips everything inside it, and moving a group updates only its own box and its ancestors'. Top-level objects (groups or loose ops) go in the grid, and queries descend into groups.
  - Drawing order needs no structure: candidates are few and are sorted by their index in the document.
  - **Gate:** the benchmark adds boards spanning a 1% to 400% zoom range, with clusters of tiny objects and fields of huge ones, and a step that moves 1,000 objects at once.
- **Level of detail:** text whose font is under a few device pixels is drawn as gray bars per line ("greeking") or skipped. Ops smaller than half a device pixel are skipped. Large images are drawn from downscaled copies at low zoom.
- **Gate:** a benchmark of a drag on a 10,000-op board stays under a 16 ms frame at the 99th percentile. A pixel check confirms that partial redraws match a full redraw.

## Batch 10: tools and demos

- **Devtools panel:**
  - Lists ops and groups, steps through drawing op by op, highlights the hovered op, and shows its state.
  - With `captureSource: true`, the recorder keeps a stack line per op, so a clicked shape leads to the code that drew it.
- **Drawing tool:** pen, rectangle, ellipse and text tools in the playground that create ops interactively through a recording context. It's a test bed for snapping and selection.
- **Interactive charts from unchanged libraries:** D3 drawing to canvas, and Chart.js, recorded as is. Every bar, point and label becomes a hoverable, clickable object with no help from the library.
- **Morph between two drawings:**
  - **Matching:** ops are matched by id, or by group meta keys when ids differ.
  - **Transforms:** decomposed into translation, rotation, scale and skew, and interpolated.
  - **Colors:** interpolated in a perceptual space.
  - **Paths:** lowered to cubic Béziers, resampled to the same segment count, given aligned starting points, and interpolated point by point.
  - **Unmatched ops:** fade in or out.
- **Embedded HTML and 3D elements with correct overlap:** an `embed` op marks where a DOM element (a video player, an iframe, a WebGL canvas) sits in drawing order, with its shape, transform and clip.
  - The elements sit in the page beneath the one board canvas, positioned with the CSS transform of the op's matrix times the view.
  - Replaying an `embed` op cuts a hole in what was drawn below it (a `destination-out` fill of its shape), and everything drawn after it paints over the element normally. The element then appears in its place in drawing order, under shapes and shadows drawn above it, with no second canvas.
  - Pointer events go to the canvas. When the router finds an `embed` op topmost under the pointer, the canvas lets events through (`pointer-events: none`) until the pointer leaves it.
  - Limits: the hole's edge is anti-aliased like any fill, and where the element is itself transparent the page shows through instead of the canvas content below it.
- **Accessibility tree (optional):** a visually hidden, structured DOM tree for screen readers: groups become regions or list items named from their meta, and text blocks become their paragraphs, headings and lists in reading order. It isn't positioned or zoomed. It changes only when the document does.

Not planned: WebGL or PDF backends, pixel access (`getImageData` and friends), and paints made by another context.
