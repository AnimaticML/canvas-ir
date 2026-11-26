# Proposal: extracting reusable Canvas editor tools

Date: 2026-11-24
Status: research and implementation handoff. Toolkit is a candidate library boundary, not an existing extracted package or a commitment to a universal editor.

**Series:** `proposal-world-runtime-` · **Recorded:** 2026-11-24

This owner-requested research and integration handoff records an agreed product
direction. Proposed schemas, package names, interfaces and execution guarantees
still require the worked examples below. It does not claim that those capabilities
are implemented or replace the repository's current public contracts.

## Related handoffs

Each repository owns its part of the proposal. The common filename prefix makes
the seven handoffs discoverable without a separate umbrella repository.

| Repository | Handoff |
| --- | --- |
| `AnimaticML/canvas-ir` | [World document, time and shared execution](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-document-and-execution.md) |
| `AnimaticML/canvas-ir` | [World and motion observation](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-observation.md) |
| `AnimaticML/canvas-ir` | [Editor Toolkit extraction](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-toolkit.md) |
| `alexandr-panchenko/video` | [World representations in ml-animatic](https://github.com/alexandr-panchenko/video/blob/main/docs/architecture/proposal-world-runtime-integration.md) |
| `alexandr-panchenko/video` | [ml-animatic observation](https://github.com/alexandr-panchenko/video/blob/main/ml-animatic/docs/proposal-world-runtime-observation.md) |
| `AnimaticML/ml-collab-codec` | [Document composition and component evolution](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/proposals/proposal-world-runtime-composition-and-evolution.md) |
| `AnimaticML/ml-collab-shell` | [Format/runtime discovery and access](https://github.com/AnimaticML/ml-collab-shell/blob/main/docs/architecture/proposal-world-runtime-capabilities.md) |

Find the local documents with `rg --files | rg '(^|/)proposal-world-runtime-'`.

## Purpose and agreed direction

Extract the reusable editor and interaction functionality already implemented in
Playground into a coherent Canvas Toolkit library. Compare it with the existing
implementations in **Harmonica and ML Painter**. These are concrete applications
to inspect, with source locations and findings recorded below.

Begin with controls, panels, tools, selection and manipulation, input integration,
and host dependencies. Repeated responsibilities across these implementations
provide requirements for the extraction; they need not be identical copied code.

A standalone example or test application can validate the public API. It
complements the real-consumer inventory rather than replacing it. Neither a search
for an unnamed second product nor a requirement to migrate every application
before an incremental extraction can proceed is part of this task.

Implement in manageable slices while preserving the intended Toolkit scope.
A small first slice is an implementation step; it does not redefine the outcome
as the smallest widget shared by two current products.

This work supports ordinary 2D editing, world-document editors and embedded scene
controls. It can proceed alongside the separate world/time and observation
handoffs without waiting for a complete world engine.

## Verified sources and first inspection

Canvas IR rechecked at `d7ae6bb0309225862b80deeb5beb3be599013c8f`; inspect the current
revision before changing code. These are source locations, not a claim that every
file should move unchanged.

| Starting point | What to investigate |
| --- | --- |
| [`ui/kit.ts`](../packages/toolkit/src/controls.ts) | Controls, labels, text input, palette/style assumptions and the `Surface` contract |
| [`ui/`](../packages/playground/src/ui/) | Cards, chrome, windows and surrounding UI: separate reusable mechanisms from Playground content and policy |
| [`tools.ts`](../packages/toolkit/src/tools.ts) | Drawing tools, `ToolHost`, previews, coordinate conversion, snapping and commit hooks |
| [`main.ts`](../packages/playground/src/main.ts) | How the board wires selection, manipulation, tools, UI, scene updates and persistence together |
| [`motion-main.ts`](../packages/playground/src/motion-main.ts), [`motion-bench.ts`](../packages/playground/src/motion-bench.ts), [`motion/views.ts`](../packages/playground/src/motion/views.ts) | Additional controls, scrubbing and views; inspect whether useful UI mechanisms can share an interface without absorbing motion algorithms |
| [Core components](../packages/core/src/components.ts) and [roadmap](roadmap.md) | Existing component redraw, event routing, geometry, snapping, text and accessibility primitives to reuse |

There is no extracted Toolkit package in this inspected revision. Similarities
inside Playground can inform the design, but a small overlap between its motion
pages does not determine the whole library scope.

## Existing application evidence

The named applications for this comparison are Harmonica and ML Painter, alongside
Playground. They were omitted from the earlier version of this handoff. The claim
that no concrete consumers had been established was incorrect.

Rechecked source revisions:

| Application | Revision | Starting points |
| --- | --- | --- |
| [Harmonica](https://github.com/alexandr-panchenko/harmonica) | `5bad4032ef2577edfd63c1dcb3b93b0a2286ee1b` | [`InfiniteCanvasBoard.tsx`](https://github.com/alexandr-panchenko/harmonica/blob/5bad4032ef2577edfd63c1dcb3b93b0a2286ee1b/src/canvas-workbench/InfiniteCanvasBoard.tsx), mounted by [`ScoreImportWorkbench.tsx`](https://github.com/alexandr-panchenko/harmonica/blob/5bad4032ef2577edfd63c1dcb3b93b0a2286ee1b/src/score-import/ScoreImportWorkbench.tsx) at `stage === "canvas"` |
| [ML Painter](https://github.com/AnimaticML/ml-painter) | `f02d20de14bb30599d5051f8537ce966e3fe6e33` | [`src/main.ts`](https://github.com/AnimaticML/ml-painter/blob/f02d20de14bb30599d5051f8537ce966e3fe6e33/src/main.ts), [`src/gallery.ts`](https://github.com/AnimaticML/ml-painter/blob/f02d20de14bb30599d5051f8537ce966e3fe6e33/src/gallery.ts), [`src/paint-editor.ts`](https://github.com/AnimaticML/ml-painter/blob/f02d20de14bb30599d5051f8537ce966e3fe6e33/src/paint-editor.ts) |

Inspect the current revision before implementing. These findings describe existing
code, not just roadmap intentions, and concern parallel implementations of shared
responsibilities rather than proof of literal source copying.

| Responsibility | Existing consumer implementation | Playground comparison and extraction question |
| --- | --- | --- |
| Viewport and coordinate mapping | Harmonica: `camera`, `viewMatrix`, `cssViewMatrix`, `toWorld()`, background pan and `onWheel()`. Painter: `scaleCanvas()`/`clampPan()` in main, `zoom()` in gallery, `zoomPlane()` in paint-editor. | `main.ts` view state, `setView()`, pointer conversion and wheel zoom. Investigate a shared viewport/controller with configurable zoom limits, anchor behavior and bounds. |
| Pointer and gesture lifecycle | Harmonica: `dragState` distinguishes card, note and pan in `onPointerDown/Move/Up()`. Painter's three surfaces each maintain pointer maps, drag/tap state and pinch handling, including cancellation and suppressing activation after a drag or multi-touch gesture. | `main.ts` routes captured input between cards, tools and the board; `tools.ts` manages tool preview and completion. Share recognition/lifecycle where appropriate while letting each host interpret the gesture. |
| Draggable card frames | Harmonica's board draws card frames and title bars, then moves cards through `collabDoc.moveBoardCard()`. | `ui/cards.ts`: `CardLayer`, `Card.frameSpec()`, content mounting and dragging; `ui/window.ts`: `windowFrame()`. Investigate reusable frame/content/drag facilities with host update callbacks. The inspected Harmonica path establishes dragging, not a resize tool. |
| Connectors between objects | Harmonica's `drawConnectorArrow()` calculates edge endpoints from card rectangles, draws the curve, arrowhead and label, and uses current card positions. | [`connectors.ts`](../packages/toolkit/src/connectors.ts): `edgePoint()`, `route()`, `drawArrow()`, with `reconnect()` in main. Compare shared geometry/rendering and decide whether it belongs in Toolkit or a lower-level package. Keep relation semantics and styling configurable. |
| Canvas host and action/accessibility wiring | Harmonica creates and connects Scene, Renderer, EventRouter, AccessibilityLayer and CSS/device views. Painter repeats host construction, DPR resize and frame scheduling across main/gallery/paint-editor; main and paint-editor also maintain action maps and accessibility activation. | `main.ts`, `CardLayer` and `ui/kit.ts` assemble the same low-level facilities. Investigate reusable mounting/disposal, view synchronization, redraw scheduling and action/focus wiring. |

The strongest common starting point is viewport/input and host wiring. Card
frames and connectors are also concrete candidates supported by Harmonica and
Playground. Not every capability must be used by all three applications.

Respect these boundaries when interpreting the evidence:

- Both applications already reuse Canvas IR primitives. Scene, Renderer, geometry,
  hit testing, EventRouter and text/vectorization APIs are not being independently
  reimplemented merely because the applications wire them together.
- Harmonica's HUD, instrument picker, artifact inspector and agent dock use React
  DOM. This is not evidence that they copy `ui/kit.ts` or should be converted to
  Canvas-drawn panels.
- Painter's visual materials and controls, palette behavior, paint recipes,
  artwork/region semantics and camera calibration remain application concerns.
  Reusing control behavior must allow its own drawing and interaction policy.
- Harmonica's notation, pitch changes, musical transport and document operations
  remain with Harmonica. For example,
  [`CollabProjectDocument.moveBoardCard()`](https://github.com/alexandr-panchenko/harmonica/blob/5bad4032ef2577edfd63c1dcb3b93b0a2286ee1b/src/collab/portableInstrumentsSchema.ts)
  turns position changes into Codec operations; Toolkit should call the host rather
  than take over that persistence.
- ml-animatic is relevant to the separate execution investigation. It is not the
  missing editor-UI consumer and need not change its DOM preview for this task.

## Inventory and library boundary

Inventory the named Playground, Harmonica and ML Painter implementations and their
dependencies before choosing the first extraction. Use the evidence above to
start directly; an open-ended search for another application is unnecessary.
For each coherent area, record:

- the current source and user-visible behavior;
- which Canvas IR primitive it already relies on;
- assumptions about the board, DOM, page styles, global state and lifecycle;
- the host inputs, callbacks or adapters needed outside Playground;
- whether it belongs in Toolkit, an existing low-level package, a format-specific
  adapter, or the Playground application.

Use responsibility, actual consumer requirements and external usability to make
these decisions. Record differences between implementations; similar mechanisms
do not imply identical policy or a requirement to copy either application's API.
Do not move the entire `ui` directory automatically or exclude windows, cards,
motion views or other areas solely because their first implementation is a demo.

The inventory should lead to a coherent controls/tools library and a practical
implementation order. Begin the comparison with viewport/input and host wiring,
then evaluate the card/frame and connector mechanisms. Choose a first usable
interaction that exercises the proposed boundary. The exact group follows from
source inspection; no arbitrary one-widget limit is imposed.

## Host contract and document ownership

A tool may produce transient preview state while dragging and request a semantic
change on completion. Establish the necessary host contract for coordinates, hit
targets, selection, snapping, preview, commit, cancellation, lifecycle and errors.
Use the current `ToolHost` as evidence, not as a frozen public API.

The host owns the meaning and persistence of a change. A Codec integration may
calculate several ordinary operations, submit required consequences atomically,
and record a meaningful history group. A programmatic host may update its scene
directly. Toolkit does not introduce a second document model, collaboration engine
or undo stack.

A gesture, a history group and an atomic request are different boundaries.
Some tools may commit intermediate changes; others commit at gesture completion.
Keep that choice with the tool/application contract rather than imposing one
persistence rule on every interaction.

| Responsibility | Proposed owner |
| --- | --- |
| Reusable controls and editing interaction | Toolkit |
| Geometry, hit testing and low-level event routing | Existing Canvas IR libraries |
| Selection, view and execution context | Host, with reusable helpers where appropriate |
| Meaning and validation of a document action | Application or format integration |
| Collaboration, persistence, admission and history | Existing document/host integration |
| Engine-specific manipulation and camera operations | Relevant tool/provider adapter |

2D and 3D tools may differ. Shared input primitives need not imply identical gizmos
or gestures. Motion can invoke the same application actions where useful without
making every control depend on a tracker.

An embedded editor's controls invoke the same functions an agent can discover.
A temporary inspection camera remains separate from a saved shot parameter.
Toolkit consumes those functions; their domain meaning stays with the format.

## Package and consumer example

`@canvas-ir/toolkit` is the working package name. Establish deliberate public
exports and environment boundaries inside this workspace. Pure tool calculations
should not acquire a DOM dependency through unrelated UI helpers; browser text
input and accessibility support can be explicit browser facilities.

Playground must consume the extracted implementation through that public boundary.
Keep code in existing low-level packages when it already belongs there, and remove
local copies that the extraction actually replaces.

Build a small standalone consumer/example in the same workspace, with a separate
entry point and application state. It may be created specifically for this task.
It must import public Toolkit/Canvas exports, supply the documented host contract,
and work without importing private Playground files or relying on its page globals.
Exercise actual interactions rather than merely rendering a mock screenshot.

This example tests isolation, completeness and usability of the public API.
Validate the proposed host contract against the named real consumer paths as well.
Record how Harmonica and Painter would integrate it, which policies remain local,
and which migrations the implemented slice includes. Where a real consumer is
migrated, remove the replaced local mechanism and exercise the affected interaction.

Keep the foundation usable without Codec, Shell or AVML. Add a Codec adapter only
where the chosen editor scenario needs it; a basic programmatic host is sufficient
for the initial consumer example. Format-specific rules remain with their owner
even when the controls that expose them are reusable.

## Expected outputs

1. An inventory comparing Playground, Harmonica and ML Painter, with concrete
   source locations, repeated mechanisms, differing policies, proposed ownership
   and a coherent extraction scope and implementation order.
2. A reusable Toolkit module/package with documented public exports and host
   integration, based on the existing implementation.
3. Playground using the extracted functionality, with replaced local copies removed.
4. A standalone example/test application demonstrating the public API independently
   of Playground internals.
5. Focused verification of the moved interactions and a short account of remaining
   local behavior, limitations and subsequent extraction slices.

The named consumers provide concrete requirements; the independent example
provides an additional check of the public boundary. Implementation should follow
the inventory through a usable library and consumer example, rather than stop
after identifying a candidate boundary or extracting a token helper.

## First implementation step and validation

Start with the named source locations in all three implementations. Produce the
comparison, select a coherent first group, extract it, adapt Playground, and
demonstrate it in the independent consumer. Validate its fit to Harmonica and
Painter and implement the consumer migrations selected for that slice. Continue
through the agreed Toolkit scope in practical slices; record what each slice
exposes and exercises.

Verify the relevant affected behavior: preview/commit/cancel, coordinate mapping,
selection, mounting/disposal, and focus/text input or accessibility for the controls
actually moved. If a Codec-backed host is included, verify its ordinary action and
history path. Reuse existing geometry and event-router checks.

A useful success criterion is that the extracted editor behavior works through
public imports in both Playground and the independent consumer, while the host
retains document semantics and persistence. A new exhaustive editor suite or a
generalized plugin system is not a prerequisite.

Related work: [world documents and execution](proposal-world-runtime-document-and-execution.md)
define the world/time foundation; [runtime observation](proposal-world-runtime-observation.md)
defines inspection. Selecting Toolkit for an assigned step does not replace those
separate research and integration responsibilities.
