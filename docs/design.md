# CanvasIR: design intent

## Purpose

CanvasIR is a drop-in replacement for `CanvasRenderingContext2D` that records drawing instead of painting it. Any code that draws to a canvas (an SVG-to-canvas renderer, a chart library, our own shapes, a rich-text layout) can draw into it unchanged, and the result is a structured, JSON-safe intermediate representation.

From that IR we derive, without a browser:

- **Geometry queries:** bounds, point hit tests, rect queries, intersections, closest point, normals, anchors.
- **Transformations:** move, scale, rotate or re-parent recorded objects and keep every query exact.
- **Rendering:** replay to a real canvas, export to SVG, or feed another backend.
- **Interaction:** pointer events routed to the recorded object under the cursor.

The payoff is that anything that can render to Canvas gets hit testing and geometry for free. An SVG asset drawn through an SVG-to-canvas library becomes selectable, snappable objects. Rich text from an HTML editor, laid out and drawn as `fillText` calls, becomes text objects with real bounds.

## Principles

Each principle below is a constraint we commit to. The reason is the failure it prevents.

| Principle | Why |
| --- | --- |
| **Exact Canvas geometry, not pixel fidelity.** Exact: path construction as the spec defines it (current point after `closePath`, implicit `moveTo` in `bezierCurveTo`, `arc` connecting lines), transforms, the `save`/`restore` state model, method signatures, ignoring non-finite arguments. Stored for replay but not modelled in geometry: shadows, filters, compositing. Out of scope: rasterization and pixel reads. | A partial or "Canvas-like" API breaks the first third-party renderer that draws into it. The value of the project is that unmodified code works. |
| **Record what was called, not what it means.** Ops store the call's arguments plus the transform and state in effect. Derived data (world-space outlines, bounds) is computed and cached, never the stored truth. | Baking transforms into points loses information: arcs under rotation or scale come out wrong, and text and images can't be represented at all. |
| **Every op is typed.** Ops are a discriminated union (`fill`, `stroke`, `clear`, `text`, `image`), versioned from the first release. | An IR that can only hold one kind of op has to be broken to add a second. |
| **Pure core, injected environment.** The core never touches the DOM. Anything environment-dependent (text measurement, image sizes, fonts) is an injected service, called only while recording. | Tests, codecs and servers must run identically in Bun, Node and every browser. |
| **Measured once, stored.** Whatever was measured while recording (text advance widths, image sizes) is written into the op. | After recording, no query, transform or export ever needs a measurer, so the IR is portable. |
| **Exact where cheap, flattened where not.** Lines and arcs are queried analytically; Béziers flatten with an explicit tolerance. Results are cached per op and invalidated by version. | Repeated flattening of every op on every query does not scale to a board of thousands of objects. |
| **Library and tooling are separate packages.** The playground and debugging tools depend on the library, never the reverse. | Tooling types and helpers leaking into the public API make the library harder to version. |

## Architecture

Every source of drawing goes through the same Canvas context, and every consumer reads the same IR.

```mermaid
flowchart TD
  svg["SVG renderer<br/>third-party code"] --> rec
  shapes["App shapes<br/>Canvas calls"] --> rec
  text["Text layout<br/>block layout + Pretext"] --> rec
  svc["Injected services<br/>measureText, image sizes<br/>used only while recording"] --> rec
  rec["Recording context<br/>drop-in CanvasRenderingContext2D<br/>records calls and state, paints nothing"] --> ir
  ir["IR document<br/>typed ops in local space with their matrix<br/>JSON-safe, versioned, never measured again"]
  ir --> geo["Geometry engine<br/>bounds, hits, intersections<br/>cached shapes, spatial index"]
  ir --> render["Render and export<br/>Canvas replay, SVG, other backends"]
  ir --> events["Event router<br/>point to op and group chain"]
```

The text layout layer also reads container outlines from the geometry engine, and the event router hit-tests through it. Only the recording context calls the injected services.

## IR data model

A document is an ordered list of typed ops. Each op keeps the Canvas state it was drawn with, including its own transform, so geometry and replay are both exact. The phase 1 types live in [`packages/core/src/types.ts`](../packages/core/src/types.ts); the target shape is:

```ts
type Op = FillOp | StrokeOp | ClearOp | TextOp | ImageOp;

interface OpBase {
  id: string;              // stable, assigned at record time
  kind: Op["kind"];
  transform: Matrix2D;     // CTM when the op was drawn
  compositing: Compositing; // globalAlpha, composite operation, shadows, filter
  clip?: ClipRef;          // active clip region, if any
  meta?: Record<string, JsonValue>; // caller tags: object id, layer, source element
}

interface TextOp extends OpBase {
  kind: "text";
  paint: "fill" | "stroke";
  text: string;
  x: number; y: number; maxWidth?: number;
  font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline;
  direction: CanvasDirection; letterSpacing: string;
  metrics: { advance: number; ascent: number; descent: number }; // measured at record time
}
```

- **Local space plus a matrix.** Path geometry stays in the coordinates the caller used; each subpath start and segment names the matrix it was added under. World-space outlines are derived and cached. Arcs and ellipses stay exact under any affine transform.
- **Paths keep their source primitives.** `arc`, `ellipse` and curves are stored as themselves, so SVG export and editing tools see what was drawn. They are lowered to Béziers only inside geometry.
- **Groups are optional structure.** A caller opens a group with the `beginGroup`/`endGroup` extension calls; it carries an id and `meta`, and nests in whatever group was open. Each op stores its innermost group, and the document lists groups with their parents. Hit tests report the op and its group chain, so "the SVG asset" or "the text block" is selectable as one object. Groups are explicit rather than inferred from `save`/`restore`, because renderers use `save`/`restore` for state, not for objects.
- **Paints are full Canvas paints.** Colors, linear, radial and conic gradients, and patterns referencing an image op by id.
- **Versioned schema.** `version` on the document from v1, Zod schemas per version, and explicit migrations.

## Recording context

The context must pass as a `CanvasRenderingContext2D` for the renderers we care about, so coverage is measured by running them, not by a hand-picked subset.

| Area | Calls | Notes |
| --- | --- | --- |
| Paths | `beginPath`, `moveTo`, `lineTo`, `bezierCurveTo`, `quadraticCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, `closePath`, `Path2D` | Spec semantics for the current point and implicit `moveTo`. |
| Painting | `fill`, `stroke`, `fillRect`, `strokeRect`, `clearRect`, `fill(path2d)`, `stroke(path2d)` | `clearRect` is recorded as an op, not dropped. |
| Transform | `translate`, `scale`, `rotate`, `transform`, `setTransform` (both forms), `getTransform`, `resetTransform` | `getTransform` returns a real `DOMMatrix` where one exists. |
| State | `save`, `restore`, `reset`, all style properties, `setLineDash`, `getLineDash`, `globalAlpha`, `globalCompositeOperation`, `filter`, shadows | Shadows and filters are stored for replay; geometry ignores them at first. |
| Paints | `createLinearGradient`, `createRadialGradient`, `createConicGradient`, `createPattern` | Gradient objects record their stops. |
| Clipping | `clip`, `clip(path2d)` | Clip regions participate in hit testing. |
| Text | `fillText`, `strokeText`, `measureText`, `font`, `textAlign`, `textBaseline`, `direction`, `letterSpacing`, `wordSpacing` | `measureText` goes to the injected measurer. |
| Images | `drawImage` (3, 5 and 9 argument forms) | Stores a source reference and size, not pixels. |
| Hit APIs | `isPointInPath`, `isPointInStroke` | Answered by the geometry engine, so renderers that test points still work. |
| Pixels | `getImageData`, `putImageData`, `createImageData` | Out of scope. Calls throw a clear "unsupported" error. |

The acceptance test is a corpus: an SVG-to-canvas renderer drawing a set of SVG files, plus our own fixtures, replayed onto a real canvas in a browser job and compared pixel-for-pixel with direct rendering. The fast Bun tests are the everyday loop.

The corpus renderer is canvg. It draws with paths, arcs, transforms, gradients, patterns of its own offscreen canvases, `clip`, `drawImage`, `fillText`/`strokeText` and `measureText`, and never uses `Path2D`. Two of its features are out of reach by design: `gradientTransform` paints with a pattern made by another context, which a recorder cannot see into, and masks and filters read pixels back. The corpus leaves those out and says so in its README.

"Pixel-for-pixel" is checked against direct drawing in which every transform call is applied as one `setTransform` with the same matrix. Chromium composes `translate`/`rotate`/`scale` in single precision, so plain direct drawing can differ from any replay in anti-aliased edge pixels; against plain direct drawing only edge pixels may differ. Replay also avoids calls that change rasterization without changing geometry: it sets the paint transform only when it differs from the last path matrix, omits the `moveTo` for a path an `arc` or `ellipse` began, and assigns `filter` only when it changes.

## Geometry queries

The engine answers queries in world space from cached, per-op derived shapes, behind a spatial index.

- **Derived shapes per op:** world-space segments, flattened polylines keyed by tolerance, fill outline and stroke outline (width, caps, joins, dash). Text and image ops derive a box (or line boxes) through their matrix.
- **Paint-aware results.** A hit on a stroke uses the stroke outline, not a distance threshold. Clips cut both fill and stroke. Fully transparent paint can be excluded by option.
- **Queries:** `bounds` (geometry and paint), `hitTest(point, tolerance)` in z-order with the group chain, `queryRect` (intersects, contains, enclosed), `intersections(a, b)`, `closestPoint` with tangent and normal, `anchors` (vertices, extremes, midpoints, text baselines and box corners), `isPointInPath` / `isPointInStroke`.
- **Stroke outlines** are a union of convex pieces (a quad per flattened segment, plus join and cap pieces) built in the stroke's own space and mapped to world space. Joins and caps use the curve's exact end tangents, since a sharp miter magnifies any error in direction. This is checked against Chromium's `isPointInStroke`.
- **Performance:** a uniform grid over op bounds as the broad phase; ops spanning many cells are kept aside as always-candidates. Caches are invalidated by op version, so moving one object recomputes only that object. Target: a hit test on 10,000 ops well under a frame, measured by a benchmark in CI.
- **Precision:** line and arc queries are analytic. Bézier queries use flattening with an explicit tolerance in world units, plus Newton refinement for closest point.

Transforms are applied to ops by composing onto their stored matrices. Nothing is re-recorded, and caches for that op are dropped.

## Rendering and export

Replay is the inverse of recording: each op sets its saved state and makes the same Canvas calls, so the replay target can be any real `CanvasRenderingContext2D` or `OffscreenCanvasRenderingContext2D` with no adapter.

- **Canvas replay** of a whole document, a subset of op ids, or a viewport (through the spatial index), with an optional extra view matrix for pan and zoom.
- **SVG export:** paths with their source primitives, `<text>` with stored positions and transforms, `<image>`, gradients, patterns, clip paths, shadows and blend modes; groups as `<g data-group>`. Where SVG has no equal (conic gradients, `clearRect`) it uses the nearest construct. The browser job renders every drawing's export in Chromium and requires it to match the canvas replay away from anti-aliased edges.
- **Other backends** through a small interface that consumes ops, not Canvas calls, so a WebGL or PDF backend doesn't have to emulate Canvas.

## Interaction

The core turns pointer positions into targets. It does not own DOM listeners.

- **Event router:** the host feeds `pointerdown`/`move`/`up`, wheel and keyboard events with a view matrix. The router hit-tests in world space and emits `enter`, `leave`, `down`, `up`, `click`, `dragstart`, `drag`, `dragend`, `wheel`, `keydown`, `keyup` with the target op, its group chain and the local-space point.
- **Capture and bubbling** along the group chain, so a handler on a group (an SVG asset, a text block) sees events from its parts.
- **Hover and selection state** live outside the IR, keyed by op or group id, so the document stays a pure description of what was drawn.
- **Text targets** report the line hit. Mapping a point to a caret offset is a text-layer concern (below).

## Text

Text enters the IR the same way everything else does, as `fillText` and `strokeText` ops. Layout is a separate, optional layer above the IR that turns rich text into those calls.

**Pipeline:** editor document (ProseMirror, edited as HTML) → block layout (paragraphs, headings, lists, spacing; ours) → paragraph layout with [Pretext](https://github.com/chenglou/pretext) (`@chenglou/pretext`, including `rich-inline` for mixed fonts) → `fillText` per run into the recording context → IR.

- **Why Pretext.** The canvas rendering must wrap exactly where the HTML editor wrapped. Pretext reproduces each browser's line-break rules and width corrections (space kerning, emoji, ligatures, CJK and Southeast Asian scripts), and re-layout after `prepare()` is pure arithmetic, so container resizes are cheap.
- **What the layout layer owns.** `@canvas-ir/text` takes a small block model (paragraphs, headings, nested bulleted and numbered lists, runs with bold, italic, code, color, size and family) and a theme for fonts, spacing and indents. It flattens blocks into paragraphs and lays each out as one Pretext rich-inline paragraph. Mapping an editor's document (ProseMirror or HTML) onto the block model is the integration's job. Line boxes follow CSS 2.1 inline layout: each run's font contributes its rounded ascent and descent plus half the leading of a unitless line height, and the block's own font sets the minimum (the strut).
- **Text block as a group.** `drawTextLayout` opens a group whose `meta` holds the layout fingerprint and whatever the caller passes (such as the source document reference), and a group per line inside it, then draws its runs. Hit testing returns the run, its line and the block. Editing re-opens the HTML editor over the block and re-runs layout on commit.
- **Containers are paths, not just rectangles.** Layout walks line bands top to bottom with `layoutNextLineRange` / `layoutNextRichInlineLineRange`. For each band it intersects the band with the container's world outline (from the geometry engine), keeps the x-intervals that are inside for the whole band height, and fills them left to right. A rectangle gives one interval per band, a concave shape several. Text around obstacles is the same with their outlines subtracted. With mixed font sizes, a line that turns out taller than the paragraph's line height is laid out again with the taller band.
- **Bidi.** Pretext breaks right-to-left text correctly but gives no visual order. A line that is all left-to-right in a left-to-right paragraph is drawn as Pretext measured it. Any other line is split by UAX #9 ([bidi-js](https://github.com/lojjic/bidi-js)) into directional runs, ordered visually (rule L2), measured, and drawn one run at a time with `direction` set from its level.
- **Caret and selection** come from the stored runs: line from the hit, offset by measuring prefixes of that run's text at edit time. They are only needed in the editor.
- **Out of scope:** glyph outlines as geometry. Text geometry is run boxes, which is what selection, snapping and layout need.

## Determinism, tests and codecs

Only recording and layout touch the environment, and both go through injected services. Everything downstream reads stored data.

- **Codecs never measure.** Serialize, deserialize, migrate, transform, query and export run on stored ops and are identical in Bun, Node and every browser.
- **Stable output.** Same calls in, byte-identical JSON out: ids in record order and a fixed key order.
- **Layout fingerprint.** A laid-out text block stores the font list, engine profile and Pretext version it was measured with. A host can see that a stored layout came from another environment and decide whether to lay it out again; nothing re-lays out implicitly.
- **Measurement fixtures.** Every `measureText` call made while laying out the text fixtures is captured from Chromium into JSON (`bun run --cwd packages/pixel capture-text`), keyed by the text and the context state that changes widths (font as assigned, letter and word spacing, kerning), together with the resulting layouts. Tests install an `OffscreenCanvas` shim that answers from that table, so Pretext and our block layout run in Bun and must reproduce the browser's layouts.
- **Three test tiers.** Unit tests in Bun for math and queries (including property tests: transform then query equals query then transform). Golden IR and SVG snapshots for the renderer corpus and text fixtures. A browser job that replays the corpus onto real canvases and compares pixels, and checks Pretext layouts against DOM layout.

## Milestones

The order puts Canvas fidelity and correct geometry first, because everything else, text included, is built on them. Each gate is an automated test in CI; a phase is done when its gate passes, not when its feature list is written.

| Phase | Scope | Gate to next phase |
| --- | --- | --- |
| 1. Core recording | Paths, transforms, state, typed IR, replay; versioned schemas, stable JSON | Pixel-equal replay |
| 2. Geometry | Cached world shapes, stroke outlines, spatial index; bounds, hit test, rect query, closest point | Fast on 10k ops |
| 3. Full Canvas | Paints, clip, `drawImage`, `fillText`, `isPointInPath`; SVG renderer corpus recorded and replayed | Corpus passes |
| 4. Text layout | Block layout + Pretext, measurement fixtures; path containers, bidi runs, layout fingerprint | Matches DOM wraps |
| 5. Interaction | Event router, groups, SVG export; playground as a separate package | SVG export renders like replay |

## Open questions

- Should `drawImage` ops carry intrinsic size only, or an optional alpha mask so transparent image pixels don't register hits?
- Should interaction move ahead of text layout, right after geometry?
