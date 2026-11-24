# Toolkit

`@canvas-ir/toolkit` (`packages/toolkit`) holds the editor and interaction mechanisms that apps built on CanvasIR were each writing for themselves. It follows [the toolkit proposal](proposal-world-runtime-toolkit.md). This page records:

- the comparison of the three apps that do this today;
- what the first slice extracts;
- the host contract;
- how Harmonica and ML Painter would take it up;
- what stays local, and the slices to come.

The toolkit decides what the pointers did, how the view moves and when to draw. The app decides what that means, keeps its document and history, and draws its own content. The toolkit has no document model, undo stack or collaboration.

## What the three apps repeat

These were checked against Playground at `a174b16`, Harmonica at [`5bad403`](https://github.com/alexandr-panchenko/harmonica/tree/5bad4032ef2577edfd63c1dcb3b93b0a2286ee1b) and ML Painter at [`f02d20d`](https://github.com/AnimaticML/ml-painter/tree/f02d20de14bb30599d5051f8537ce966e3fe6e33). The three apps share responsibilities, not copied code.

| Mechanism | Playground | Harmonica (`canvas-workbench/InfiniteCanvasBoard.tsx`) | ML Painter | Differences in policy |
| --- | --- | --- | --- | --- |
| **View: pan, zoom about a point, limits** | `main.ts`: a `view` matrix; wheel zoom by `exp(-dy·0.0015)` about the pointer; pan in `dragstart`/`drag`; `setView` callers fly and fit. | A `camera` `{x, y, zoom}` in React state; `toWorld()`; wheel steps ×1.1/×0.9, limited to 0.45–2.4, **about the origin, not the pointer**; pan from a drag. Every camera change rebuilds the whole scene, renderer, router and accessibility layer, because `camera` is in the effect's dependencies. | Three copies. `main.ts`: `scaleCanvas()` and `clampPan()`, limited 8× and centered at the least zoom. `gallery.ts`: `zoom()` and `galleryPan()`. `paint-editor.ts`: `zoomPlane()`, panned about the plane's middle and kept within it. | Limits, bounds and centering differ per app. Zooming about a point is the same arithmetic in all five. |
| **Pointers to gestures: tap vs drag, pinch, cancel** | The router's drag threshold (3 px). No pinch. | `dragState` kinds: note, card, pan. No pinch, no cancel handling. | Three copies of a pointer map, a moved flag past 6 px, a `multi`/`pinched` flag. All three apply the rule that the finger left after a pinch must not resume a tap or drag. Cancel suppresses activation. | What a drag moves (card, note, palette wheel, dock, corner) is each app's own. |
| **Wheel units** | Lines ×33, pages ×height. | Sign only. | `exp(-dy·0.001)` and `exp(-dy·0.002)`, in pixels as delivered. | |
| **Canvas host: device pixels, frame scheduling, resize** | `draw()` sizes three canvases to the device ratio, coalesces frames, and draws a part for the 3D host's capture. | Sized once per effect, at the device ratio, from the container. | Three copies of DPR sizing capped at 2, `requestAnimationFrame` coalescing, and a resize listener on `innerWidth`/`innerHeight`. | The ratio cap and what is measured differ. |
| **Actions by id, shared with the accessibility mirror** | `AccessibilityLayer.onActivate` presses the control as a click would. | `AccessibilityLayer` with no activation. | `main.ts` and `paint-editor.ts` each keep an `actions` map and run it from both a click and `onActivate`. | |
| **Card frames and dragging** | `ui/cards.ts` (`CardLayer`), `ui/window.ts` (`windowFrame`). | Frame and title bar drawn per card. A title-bar drag calls `collabDoc.moveBoardCard()` on every move. | None. | Harmonica commits each move to its Codec document; the playground commits on drag end. |
| **Connectors** | `connectors.ts`: `edgePoint`, `route`, `drawArrow`, with ends that hold on to what they join. | `drawConnectorArrow()`: from the dominant axis's edge, a quadratic curve, a dashed line and a label. | None. | Style, routing and labels differ. |
| **Drawing tools** | `tools.ts` with `ToolHost`: preview, snapping, commit. | None. | None. | Only the playground has these so far. |

All three already use CanvasIR's `Scene`, `Renderer`, `EventRouter` and `AccessibilityLayer`. What they repeat is the wiring around those, not the primitives themselves.

## The first slice: view, gestures, host, actions

The order follows the evidence. The view and input mechanisms are in all three apps (five copies), so they come first.

- **`Viewport`** is a uniform zoom and a translation, with `matrix` for a router or the accessibility layer and `device(ratio)` for a renderer. It has `toWorld`/`toScreen`, `panBy`, `zoomAt(factor, anchor)`, `zoomTo`, `fit`, `setMatrix` for hosts that keep a matrix, and `onChange`. Zoom limits and a `clamp(view)` are applied on every change, which covers Painter's bounds, Harmonica's limits and centering at the least zoom. It is pure, with no DOM.
- **`wheelZoom(dy)`** and **`wheelPixels(event, pageHeight)`** turn a wheel into a factor, from any device's units.
- **`Gestures`** takes pointer down, move, up and cancel by id and reports `press`, `hover`, `dragStart`/`drag`/`dragEnd` (with `delta` and `total`), `tap`, `pinchStart`/`pinch`/`pinchEnd` (with `scale`, `center`, `pan`) and `cancel`. It enforces the rules each app wrote by hand:
  - a slop before a drag (6 px by default);
  - a second finger cancels the press and starts a pinch;
  - the finger left after a pinch does nothing until all are up;
  - a cancelled pointer never taps.

  It is pure, so tests feed it points.
- **`bindGestures(element, gestures, { wheel, leave, raw })`** feeds an element's pointer and wheel events to it in the element's CSS pixels, with pointer capture.
- **`mountCanvas(canvas, { draw, maxPixelRatio, measure })`** keeps a canvas at its laid-out size in device pixels and draws at most once a frame (`schedule`, `flush`, `dispose`). It also redraws on resize.
- **`Actions`** keeps what a board's controls do by id. A tap's hit path, Enter on the mirror and an agent's call all run the same function, and `list()` says what can be done.

### The host contract

| The toolkit | The host |
| --- | --- |
| Says a press, drag, tap or pinch happened, in screen pixels. | Hit tests (with `viewport.toWorld` and its `Scene`) to decide what was pressed, and what a drag of it means. |
| Moves the view, within the limits and clamp it was given. | Owns the drawing. It redraws on `viewport.onChange` by setting views only, without re-recording. |
| Calls `cancel` when a press is abandoned. | Puts back any preview, and commits nothing. |
| Calls `dragEnd` once. | Decides whether a drag commits once at the end (the example) or as it goes (Harmonica's Codec moves), and records that in its own history. |
| Runs an action by id. | Registers the actions, and what they change in its document. |

### In the playground

The board in `main.ts` now keeps its view in a `Viewport`:
- the wheel zooms through `wheelZoom`/`wheelPixels`;
- a drag on empty board pans with `panBy`;
- the matrix arithmetic it replaces is gone.

The board also gained two-finger pinch, through `Gestures` fed beside its router. A second finger cancels whatever the first began (a tool's stroke, a router drag), and the remaining finger does nothing until both are up. Clicks, drags, tools and the cards are routed as before.

### The example

`packages/toolkit/example` is a separate page with its own state that imports only the public `canvas-ir` and `@canvas-ir/toolkit` exports. It has:
- cards with title bars to drag;
- a button on each, pressed by pointer or by Enter on the mirror;
- arrows between the cards;
- pan, wheel zoom and pinch;
- Escape and a second finger to cancel a drag;
- undo of its own.

Its document is a plain object with a history. A drag previews as it goes and commits once.

- Run it with `bun run --cwd packages/toolkit example`.
- `bun run --cwd packages/toolkit check` builds it, opens it in Chromium and drives each of those interactions, including touch through pointer events. It runs in CI.

## Taking it up in Harmonica and ML Painter

Neither app is migrated in this slice. Both vendor CanvasIR (`vendor/canvas-ir/packages/core`, or a workspace link), so each would vendor `packages/toolkit` beside it. The changes are local to each app's input code:

- **Harmonica**:
  - Replace `camera`, `toWorld` and the wheel handler with a `Viewport({ minZoom: 0.45, maxZoom: 2.4 })`, and keep the scene, renderer, router and accessibility layer across view changes. A pan or zoom then calls `renderer.setView` and redraws, instead of re-recording the whole board. Zoom also follows the pointer.
  - `Gestures` replaces `dragState`:
    - `press` hit tests for a note, a title bar or empty board;
    - `drag` calls `collabDoc.moveBoardCard` or `viewport.panBy`;
    - `dragEnd` on a note applies the pitch step.

    Pinch zoom comes with it. Whether a card move becomes one Codec operation per move or one at drag end stays Harmonica's choice.
- **ML Painter**:
  - In `gallery.ts`, `Viewport({ minZoom, maxZoom, clamp: galleryPan })` and `Gestures` (`tap` activates, `drag` pans, `pinch` zooms) replace the pointer map, the `pinched` flag and `zoom()`.
  - In `paint-editor.ts`, a second `Viewport` with a clamp inside the plane replaces `zoomPlane()`.
  - In `main.ts`, `scaleCanvas()`/`clampPan()` become a viewport whose clamp centers at the least zoom. `Gestures` handles the pinch and the post-pinch finger, while the drag targets (palette wheel, dock, corners, artwork) stay Painter's.
  - `mountCanvas({ maxPixelRatio: 2 })` replaces the three resize and frame loops. `Actions` replaces both action maps.

## What stays local, for now

- **The playground's own frame loop.** It draws a part of the page for the 3D host's capture and three canvases, which `mountCanvas` doesn't do. Its pointer routing between the cards and the board also stays, and its board drags still go through `EventRouter`.
- **Each app's drawing, styles, palettes and drag targets,** and Harmonica's notation and Codec operations.
- **Harmonica's React HUD and panels,** which are DOM and not candidates.

## Next slices

1. **Card frames and dragging.** `ui/cards.ts` and `ui/window.ts` against Harmonica's frames and title-bar drags. This is a frame, a title bar and a drag that calls the host to move.
2. **Connectors.** Playground's `connectors.ts` against Harmonica's `drawConnectorArrow`. The edge geometry may belong in core, and the drawing and styles in the toolkit.
3. **Drawing tools and `ToolHost`,** with preview, snap, commit and cancel, on top of `Gestures`.
4. **Controls from `ui/kit.ts`.** These are the knob, slider, button and text input, and the `Surface` contract.
5. **The motion lab and bench.** Scrubbing, playback and the view controls they each build.
