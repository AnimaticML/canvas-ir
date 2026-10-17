# CanvasIR: roadmap after phase 5

Phases 1 to 5 in [design.md](design.md) are done. These are the next batches, in order. Each batch, like each phase, is done when its gate passes in CI.

## Where the document lives

CanvasIR stays a recording, geometry, rendering and interaction layer. It doesn't own the application's document, its components or its undo history.

An app keeps its own document model (for example HTML web components synced through an operational-transformation codec, with ProseMirror for rich text). That model has higher-level components, such as stickers, connectors and text blocks, and its own undo and redo semantics. Each component renders itself into a CanvasIR group with the component's id. When a component changes, only its group is drawn again and swapped into the scene. Undo and redo happen in the document model, and the canvas follows.

What the library needs for that is incremental updates by group, not an undo stack:

- `Scene.replaceGroup(id, document)` swaps a group's ops and nested groups for newly recorded ones in place, keeping its position in drawing order. The playground's live text does this by hand today.
- Recording a component's drawing on its own, into a document whose group ids are prefixed or scoped to that component, so that two components' ids can't collide.
- A change report from the scene listing which ids changed and the area they covered before and after. Redrawing only what changed (batch 9) and the app's own bookkeeping both use it.

## Batch 6: geometry and selection

- **Intersections:** `scene.intersections(a, b)` gives the points where two ops' outlines cross, for fills, strokes, text boxes and image boxes. Lines are exact. Curves are found by subdividing Bézier pieces, then refined with Newton steps.
- **Anchors:** `scene.anchors(id)` returns vertices, curve extremes, segment midpoints, centers, bounding-box corners and edge midpoints, and text baselines and box corners. Each anchor has a kind.
- **Snapping:** `scene.snap(point, { radius, kinds, exclude })` returns the best candidate within the radius from anchors, intersections and closest points on outlines, ranked by kind and then distance. In the playground, drag snapping shows guide marks.
- **Lasso and marquee:** `scene.queryPolygon(points, mode)`, with the same modes as `queryRect` (intersects, contains, enclosed). The playground gets shift-click and marquee multi-select, and moves several objects at once.
- **Offsetting:** `offsetRegion(region, distance)` grows or shrinks closed outlines, with round joins. Text layout gets a `margin` on obstacles in place of the playground's radial approximation.
- **Transparent paints:** hit tests skip fills and strokes whose paint is fully transparent (`rgba(…, 0)`, `transparent`, or gradients whose stops all have alpha 0), just as they already skip `globalAlpha` 0. `includeInvisible` keeps them for deliberate invisible hit areas.
- **Gate:** intersections agree with a dense sampling oracle to within the flattening tolerance on the fixture corpus. Snapping, lasso and offset have property tests; for example, every point of an offset outline lies `distance` from the original, within tolerance.

## Batch 7: text

- **Run data and hyperlinks:** `TextRun` gains `href` and an open `data` object. `drawTextLayout` puts each run that has them in a group, inside its line group, with `{ type: "text-run", href, data }` as meta. A link that wraps becomes one group per line, all sharing the run's index. The playground shows a hover cursor and opens the link on click.
- **Decorations:** underline, strikethrough and overline on runs, drawn as filled rects after the text. Position and thickness follow the browsers' fallbacks when the font's own values aren't available to Canvas. Underlines skip descenders only if that turns out to be cheap.
- **Live layout in the library:** a text block bound to its container and obstacle groups, laid out again when they move or change, replacing its group through `replaceGroup`. This is the playground's live text, moved into `@canvas-ir/text`.
- **Caret and selection helpers:** map a point to a source offset and an offset to a caret rect, and turn a source range into selection rects, from the fragments' `sourceStart`/`sourceEnd` and prefix measurement. Needed only for editing on the canvas.
- **Gate:** decorations land within 1px of where Chromium's DOM draws `text-decoration` for the text fixtures. Links and caret mapping have unit tests.

## Batch 8: images

- **Image outlines:** `traceImageOutline(imageData, { threshold, tolerance })` traces where the image is opaque (marching squares on the alpha channel, simplified with Douglas–Peucker) into rings in image pixel space. An `ImageRef` may carry the outline. Hit tests, closest point, snapping and text obstacles then use the real silhouette instead of the box. Tracing happens when an image is described (`describeImage`), not at query time.
- **Screenshot and flat-art vectorizing (an experiment, in its own package):** PNGs of UI and flat illustrations have few colors, unlike photos.
  - Quantize the colors, folding anti-aliasing fringes into their neighbors.
  - Trace one region per color, simplify the regions, and fit lines and arcs.
  - Emit fills in z-order: background first, then shapes. The result can be exported as SVG through the existing export.
  - Text in a screenshot becomes shapes, not text.
- **Gate:** outline hit tests agree with the alpha channel at every pixel away from the outline. The vectorizer reports a pixel difference against the source PNG on a small corpus; it's tracked, not gated, while it's an experiment.

## Batch 9: rendering performance

- **Viewport culling:** `replayDocument` takes a visible rect and replays only ops whose paint box meets it, found through the scene's spatial index.
- **Redrawing only what changed:**
  1. Collect the paint boxes a change touched: where the moved object was and where it is now, shadows and blur included.
  2. Clip the canvas to their union and clear it there.
  3. Replay, in drawing order, only the ops that meet that area.
  - Everything outside the area stays as it was.
  - Composite operations that affect pixels outside the op (`copy`, `destination-in` and similar) force a full redraw.
- **Layers while dragging:** cache what's below the dragged object and what's above it as two bitmaps. Each frame then draws three things: the lower bitmap, the moving object, and the upper bitmap.
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
- **Accessibility mirror (optional, measured before adopting):**
  - A visually hidden DOM tree with groups as regions and text ops as text, so screen readers and find-in-page work. It's laid out but never painted visibly.
  - It mirrors only what's near the viewport, through the spatial index, and is rebuilt after pans and zooms settle, so its cost tracks what's on screen, not the board's size.
  - If it costs too much, it stays an opt-in for documents that need it.

Not planned: WebGL or PDF backends, pixel access (`getImageData` and friends), and paints made by another context.
