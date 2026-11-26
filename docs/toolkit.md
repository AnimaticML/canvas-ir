# Toolkit

`@canvas-ir/toolkit` (`packages/toolkit`) holds the editor and interaction mechanisms that apps built on CanvasIR were each writing for themselves, taken out of the playground so the next app starts from them. It follows [the toolkit proposal](proposal-world-runtime-toolkit.md). This page records:

- the comparison of the playground with two apps that do the same things, Harmonica and ML Painter;
- what the toolkit holds, and its host contract;
- how those two apps would use it, as examples of usage;
- what stays in the playground, and what to take out next.

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

## What the toolkit holds

It came out in four steps:
1. The view and input mechanisms, in all three apps (five copies), came first.
2. The playground's reusable board UI came out whole: cards, window parts, connectors, drawing tools and controls, which only it had built in full.
3. The board itself, which wires them together, came out of the playground's `main.ts`.
4. Its toolbar and inspector came out of `ui/chrome.ts`, as panels any board can have.

### View, gestures, canvas host and actions

- **`Viewport`** is a uniform zoom and a translation, with `matrix` for a router or the accessibility layer and `device(ratio)` for a renderer. It has `toWorld`/`toScreen`, `panBy`, `zoomAt(factor, anchor)`, `zoomTo`, `fit`, `setMatrix` for hosts that keep a matrix, and `onChange`. Zoom limits and a `clamp(view)` are applied on every change, which covers Painter's bounds, Harmonica's limits and centering at the least zoom. It is pure, with no DOM.
- **`wheelPixels(event, pageHeight)`** normalizes wheel deltas. **`WheelGesture`** chooses pan or zoom on the first event and keeps that choice until 100 ms of idle time or a Ctrl modifier change. Unknown input pans. Learned vertical notch multiples and Ctrl+wheel zoom through **`wheelZoom(dy)`**.
- **`Gestures`** takes pointer down, move, up and cancel by id and reports `press`, `hover`, `dragStart`/`drag`/`dragEnd` (with `delta` and `total`), `tap`, `pinchStart`/`pinch`/`pinchEnd` (with `scale`, `center`, `pan`) and `cancel`. It enforces the rules each app wrote by hand:
  - a slop before a drag (6 px by default);
  - a second finger cancels the press and starts a pinch;
  - the finger left after a pinch does nothing until all are up;
  - a cancelled pointer never taps.

  It is pure, so tests feed it points.
- **`bindGestures(element, gestures, { wheel, leave, raw })`** feeds an element's pointer and wheel events to it in the element's CSS pixels, with pointer capture.
- **`mountCanvas(canvas, { draw, maxPixelRatio, measure })`** keeps a canvas at its laid-out size in device pixels and draws at most once a frame (`schedule`, `flush`, `dispose`). It also redraws on resize.
- **`Actions`** keeps what a board's controls do by id. A tap's hit path, Enter on the mirror and an agent's call all run the same function, and `list()` says what can be done.

### Cards, windows, connectors, tools and controls

These moved from the playground unchanged in behavior, and the playground imports them from the toolkit.

- **`CardLayer` and `Card`** (`cards.ts`): titled cards of widgets in a scene of their own over the board, drawn with the board's view, so they pan and zoom with it but stay out of its drawing and exports. Each card has:
  - a frame that drags it;
  - content that scrolls with the wheel, clipped;
  - its own router and accessibility mirror.

  New with the move:
  - `CardOptions.onMove(x, y)` is called once when a drag of the frame ends, so a host that keeps card positions in its document commits them there.
  - `card.moveTo(x, y)` and `card.position` let the host put a card back on undo.
  - `CardLayer` is a `PointerLayer`, so `bindGestures(canvas, gestures, { above: layer })` sends presses and hovers over a card to the cards and the rest to the board's gestures. The playground's `main.ts` still routes them by hand.
- **Window parts** (`window.ts`):
  - the close button (`closeBox`, `drawClose`, `inBox`, `TITLE_LEFT`), which every demo window shares;
  - `windowFrame()`, a title bar and border around content drawn straight on the board.
- **Connectors** (`connectors.ts`): arrows whose ends hold on to what they join, by a key the host resolves to a box, or stay loose.
  - `route()` places each end on its box's edge, facing along the bow.
  - `drawArrow()` and `drawRing()` draw them with a repeatable hand-drawn wobble, or, with `style: { look: "clean" }`, as an even thin line for diagrams.
  - A connector's `style` also picks its path (a bowed curve, straight, or right angles with rounded corners that leave the sides facing each other), its width and dashes, what it ends in at each end (open, filled, a dot or nothing), and its word as a label: beside the bow by hand, on the line over a pill when clean. `arrowPath()` gives the path, where the label goes and the angle at each end, for a host drawing its own.
  - A board's `connectorStyle` option sets how the arrows its arrow tool draws look.
  - `toMeta()` and `fromMeta()` keep a connector in its group's meta, so it is saved like any drawing.

  What the keys mean, and when to draw again, is the host's.
- **Drawing tools** (`tools.ts`): pen, rectangle, ellipse, text and arrow, behind a `ToolHost`. The host says:
  - how to snap;
  - what a key at a point is, and its box;
  - how to commit a recorded group, and how to connect two ends.

  The tools draw previews and record the new drawing.
- **Controls** (`controls.ts`): button, toggle, slider, swatches, text box and field, section headings, the palette, and the text sink (one hidden textarea that takes typing for every text field). They mount on a `Surface`, which a card is.

### The board

`Board` (`board.ts`) is a scene on a canvas with everything that makes it a board. The host gives it a stage with three canvases (the board, its cards and an overlay), and optionally a `CardLayer`, recorder and renderer options, and snap settings. The board then:
- picks what is clicked (the outermost group, or the op itself with Alt) and outlines the hovered and selected things;
- drags the selection, snapping its anchors to what is near (Ctrl turns it off), and lassoes with Shift;
- pans on empty board, pans or zooms with a wheel burst where nothing scrolls (through `WheelGesture`), and pinches with two fingers;
- draws with the tools (V, P, R, O, T, A), and keeps connectors on what they hold, drawn again when it moves;
- deletes the selection with Delete;
- routes pointers and keys between its cards and the board, and keeps the accessibility mirror in step;
- draws once a frame, or only a part of the page for a host showing it in 3D (`part`);
- flies the view (`flyTo`, `reveal`, `home`);
- gives its drawings as documents (`documents`, `documentOf`) and loads them again (`load`), for a host's undo or save.

What is on it, and what a change means, stays the host's, through `BoardHooks`:
- `changed` says a drag ended, a drawing or arrow was added, or things were deleted, for the host to commit;
- `grab` lets the host drag something itself (a simulated body);
- `expand` and `moved` say what moves with a thing;
- `keyAt` and `boxOf` say what an arrow's end holds;
- `bound`, `beforeDraw`, `paint`, `overlay` and `viewChanged` let content with its own handlers and drawing take part;
- `tooltip` gives text to show beside the pointer.

The playground's `main.ts` is now a host of a `Board`. It went from 1,799 lines to 1,184, keeping only its content: the demos, the collage, the saved layout, its keys for connector ends, and the 3D hosts.

### Toolbars and inspectors

- **`Panel`** (`panel.ts`) is a card of controls described as a list of items, laid out down the card. The items are headings, rows of buttons that wrap, full-width buttons, swatches, sliders, toggles, text boxes and fields, and custom components. Each control reads its value through a function. `refresh()` sets what changed, and `rebuild()` builds the panel again when its list of items changes.
- **Board controls** (`inspector.ts`) are panel items for a board:
  - `toolItems` gives the tool buttons, with the current tool shown as on;
  - `actionItems` gives the host's buttons;
  - `styleItems` sets the fill, stroke and width the tools draw with;
  - `snapItems` sets a `SnapControls` object, which `snapSettings()` turns into what the board reads;
  - `selectionItems`, `renderItems`, `mirrorItems` and `logItems` show the selection, the last redraw, the accessibility tree and a log.
- **`BoardFeed`** keeps that text from what the board does, through `board.on(...)` (the board's events: selected, drawn, mirror, log, tool and changed). It refreshes every panel attached to it.
- **`boardPanels(board, layer, options)`** puts a toolbar and an inspector made of these on a board as they come. A host that wants its own sections, as the playground does, builds its panels from the same items.

### The host contract

| The toolkit | The host |
| --- | --- |
| Says a press, drag, tap or pinch happened, in screen pixels. | Hit tests (with `viewport.toWorld` and its `Scene`) to decide what was pressed, and what a drag of it means. |
| Moves the view, within the limits and clamp it was given. | Owns the drawing. It redraws on `viewport.onChange` by setting views only, without re-recording. |
| Calls `cancel` when a press is abandoned. | Puts back any preview, and commits nothing. |
| Calls `dragEnd` once. | Decides whether a drag commits once at the end (the example) or as it goes (Harmonica's Codec moves), and records that in its own history. |
| Runs an action by id. | Registers the actions, and what they change in its document. |
| A card's widget calls back; a card's frame ends a drag (`onMove`). | Commits what the widget means, or the card's new place, and calls `moveTo` to put a card back. |
| A connector asks for the box of a key. | Says what the key is and where it is, and records connectors in its drawing. |
| A tool records a drawing and asks the host to commit it. | Puts it in its scene and its history. |
| The board reports a change (`changed`): moved, drawn, connected, removed. | Commits it: reads `board.documents()` into its document and history, or saves the layout. On undo, `board.load(...)` puts a document back. |

### What the host passes in, and taking it off the page

Two things the toolkit used to find on the page, a host can now give it:
- **Text input** (`TextInput`): where typing goes while a field or the text tool is being edited. The default is one shared hidden textarea (`textSink()`); a host passes its own `new TextSink(parent)` to the `CardLayer` and the `Board` (the board takes the cards' when it has none), or anything with `take`, `release` and `active`, such as an input of its own framework.
- **Theme** (`Theme`): the cards' colors and the board's outlines. The default `systemTheme()` reads the page's CSS custom properties and follows its light or dark preference; `fixedTheme({...})` gives colors outright. Cards rebuild when a theme says its colors changed.

Each part takes off the page what it put there:
- `board.dispose()` removes its listeners on the canvas and the keys, its resize observer, its pending frame and flight, its mirror and its renderer.
- `cards.dispose()` does the same for the cards' layer, and `cards.removeCard(card)` or `panel.dispose()` takes one card off.
- `feed.detach(panel)` stops a `BoardFeed` refreshing a panel.

What the host gave (the cards to the board, the text input to both) it disposes itself.

### In the playground

The playground imports the cards, window parts, connectors, tools and controls from the toolkit. Its board in `main.ts` keeps its view in a `Viewport`:
- wheel bursts pan or zoom through `WheelGesture`, with zoom anchored at the pointer;
- a drag on empty board pans with `panBy`;
- the matrix arithmetic it replaces is gone.

The board also gained two-finger pinch, through `Gestures` fed beside its router. A second finger cancels whatever the first began (a tool's stroke, a router drag), and the remaining finger does nothing until both are up. Clicks, drags, tools and the cards are routed as before.

### The examples

`packages/toolkit/example` is a separate page with its own state that imports only the public `canvas-ir` and `@canvas-ir/toolkit` exports. It has:
- cards with title bars to drag;
- a button on each, pressed by pointer or by Enter on the mirror;
- connectors between the cards that follow them as they move;
- a controls card over the board, whose button adds a card and whose slider bends every connector, dragged by its frame;
- pan, wheel zoom and pinch;
- Escape and a second finger to cancel a drag;
- undo of its own, which also puts the controls card back.

Its document is a plain object with a history. A drag previews as it goes and commits once, and a slider's run of changes is one step.

`packages/toolkit/example/board.html` is a `Board` with a document of its own: shapes joined by arrows (one hand-drawn, one clean, dashed and in right angles with a label), the toolkit's toolbar and inspector (`boardPanels`, with Undo among its actions), and an undo history of the board's documents. Every change the board reports is one step, and undo loads the last document back, arrows and all. It passes in its own text input and theme, and its `dispose` takes the board, the cards and the text input off the page.

- Run them with `bun run --cwd packages/toolkit example`.
- `bun run --cwd packages/toolkit check` builds both, opens them in Chromium and drives each of those interactions, including touch through pointer events. It runs in CI.

## Usage in Harmonica and ML Painter

These two apps are here as concrete examples of what the toolkit has to serve, not as work to do in their repositories. In each, using it would be local to the app's input code:

- **Harmonica**:
  - Replace `camera`, `toWorld` and the wheel handler with a `Viewport({ minZoom: 0.45, maxZoom: 2.4 })`, and keep the scene, renderer, router and accessibility layer across view changes. A pan or zoom then calls `renderer.setView` and redraws, instead of re-recording the whole board. Zoom also follows the pointer.
  - Card frames and connectors: `Card`'s frame with `onMove` (or a drag preview committed per move), and `route()` with `drawArrow()` in the clean look (dashed, with its label on the line) in place of `drawConnectorArrow()`.
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

## What stays in the playground, for now

- **Its content:** the demos, the collage, the samples added to the board, the saved layout, and the keys it gives connector ends (icons, content, windows).
- **Its own panel sections:** `ui/chrome.ts` builds the playground's toolbar and inspector from the toolkit's panels and board controls. It adds only the devtools section, pasting SVG, the level-of-detail toggle, its hints and its actions.
- **Its demo icons:** `ui/features.ts`.
- **Its 3D hosts:** the floor host for the room in 3D, and the capture of a part of the page for a 3D screen, which it sets on the board.

## Next

1. **Twist in gestures.** Two-finger rotation, and the 3D pages on the shared gestures.
2. **Widget behaviours without the stock look.** A button's or slider's pressing, dragging and keys, with the app drawing it.
3. **An image registry.** Images loaded once and drawn by key, for cards and drawings.
4. **Desktop icons and windows.** `ui/features.ts`'s icons, the demo windows' frames and their opening, closing and placing, as one launcher-and-window mechanism on the board.
5. **The motion lab and bench.** Scrubbing, playback and the view controls they each build.
