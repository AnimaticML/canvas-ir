# CanvasIR: roadmap after phase 5

Phases 1 to 5 in [design.md](design.md) are done. These are the next batches, in order. Each batch, like each phase, is done when its gate passes in CI.

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
- **Level of detail (`lod`):** text whose font is under 3 device pixels is drawn as a bar across the middle of its ink box at half alpha; ops under half a device pixel are skipped; images shown at under half their size are drawn from copies halved as often as fits, made once per image.
- **Gate:**
  - After 200 random edits and pans of a board holding every pixel fixture (clips, clears, shadows, filters, gradients, patterns, images, text, `destination-in`), partial redraws match a full replay at every pixel away from an anti-aliased edge. Edge pixels differ in a few hundred places in all, where Chromium anti-aliases depending on what else it rasterized in the same pass. After a pan, more edge pixels differ, by up to a whole pixel on hairlines: Chromium anti-aliases differently at another offset, even a whole pixel away.
  - Dragging tiles with cached layers, with other edits mid-drag, matches a full replay within 2 levels away from edges: compositing a translucent layer rounds once more.
  - A drag on a 10,000-op board, all in view, stays under a 16 ms frame at the 99th percentile. In headless Chromium, a full replay takes about 140 ms a frame; dragging a shape takes about 1 ms with partial redraws and 0.2 ms with layers, and dragging a translucent panel over a third of the view takes about 6 ms with layers (60 ms without).
  - The geometry benchmark adds a board from specks to shapes thousands of units across, queried as at 400% and at 1% zoom, and a step that moves 1,000 objects at once, held to 16 ms at the 90th percentile since its tail is garbage collection.

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
