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
| `alexandr-panchenko/video` | [World representations in Animatic](https://github.com/alexandr-panchenko/video/blob/main/docs/architecture/proposal-world-runtime-integration.md) |
| `alexandr-panchenko/video` | [Animatic observation](https://github.com/alexandr-panchenko/video/blob/main/ml-animatic/docs/proposal-world-runtime-observation.md) |
| `AnimaticML/ml-collab-codec` | [Document composition and component evolution](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/proposals/proposal-world-runtime-composition-and-evolution.md) |
| `AnimaticML/ml-collab-shell` | [Format/runtime discovery and access](https://github.com/AnimaticML/ml-collab-shell/blob/main/docs/architecture/proposal-world-runtime-capabilities.md) |

Find the local documents with `rg --files | rg '(^|/)proposal-world-runtime-'`.

## Purpose and agreed direction

Extract the reusable editor and interaction functionality already implemented in
Playground into a coherent Canvas Toolkit library. Playground is the confirmed
source and first consumer. Begin with its controls, panels, tools, selection and
manipulation, input integration, and host dependencies.

**A second production application with duplicate code is not a prerequisite.**
No such pair was established for this handoff, including Playground and Animatic.
The earlier wording incorrectly made finding that pair a condition of starting.
Validate the extracted library with a standalone example or test application that
uses its public API. Existing applications can provide additional requirements
and consumers when their actual needs fit.

Implement in manageable slices while preserving the intended Toolkit scope.
A small first slice is an implementation step; it does not redefine the outcome
as the smallest widget shared by two current products.

This work supports ordinary 2D editing, world-document editors and embedded scene
controls. It can proceed alongside the separate world/time and observation
handoffs without waiting for a complete world engine.

## Verified sources and first inspection

Rechecked at `8f0dd388dc1057fac4abd13a3833bf08d3185f77`; inspect the current
revision before changing code. These are source locations, not a claim that every
file should move unchanged.

| Starting point | What to investigate |
| --- | --- |
| [`ui/kit.ts`](../packages/playground/src/ui/kit.ts) | Controls, labels, text input, palette/style assumptions and the `Surface` contract |
| [`ui/`](../packages/playground/src/ui/) | Cards, chrome, windows and surrounding UI: separate reusable mechanisms from Playground content and policy |
| [`tools.ts`](../packages/playground/src/tools.ts) | Drawing tools, `ToolHost`, previews, coordinate conversion, snapping and commit hooks |
| [`main.ts`](../packages/playground/src/main.ts) | How the board wires selection, manipulation, tools, UI, scene updates and persistence together |
| [`motion-main.ts`](../packages/playground/src/motion-main.ts), [`motion-bench.ts`](../packages/playground/src/motion-bench.ts), [`motion/views.ts`](../packages/playground/src/motion/views.ts) | Additional controls, scrubbing and views; inspect whether useful UI mechanisms can share an interface without absorbing motion algorithms |
| [Core components](../packages/core/src/components.ts) and [roadmap](roadmap.md) | Existing component redraw, event routing, geometry, snapping, text and accessibility primitives to reuse |

There is no extracted Toolkit package in this inspected revision. Similarities
inside Playground can inform the design, but their size does not determine the
whole library scope. A small overlap between motion pages does not make motion
playback deduplication the entire assignment.

Animatic's graphics and playback integration is relevant to the separate
execution work. It is not evidence that Animatic duplicates these editor tools
or should replace its DOM preview with the Playground UI.

## Inventory and library boundary

Inventory existing capabilities and their dependencies before choosing the first
extraction. For each coherent area, record:

- the current source and user-visible behavior;
- which Canvas IR primitive it already relies on;
- assumptions about the board, DOM, page styles, global state and lifecycle;
- the host inputs, callbacks or adapters needed outside Playground;
- whether it belongs in Toolkit, an existing low-level package, a format-specific
  adapter, or the Playground application.

Use responsibility and external usability to make these decisions. Finding copied
code elsewhere is useful evidence when available, not the acceptance criterion.
Do not move the entire `ui` directory automatically or exclude windows, cards,
motion views or other areas solely because their first implementation is a demo.

The inventory should lead to a coherent controls/tools library and a practical
implementation order. Choose a first usable editor interaction, such as controls
and a drawing/manipulation tool with preview and commit. The exact group follows
from the source inspection; no arbitrary one-widget or two-application limit is
imposed.

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

This example tests isolation, completeness and usability of the public API. It
does not claim adoption by a second production application. A suitable existing
application may supplement or replace it, but searching other repositories is not
required to begin or complete the first extraction.

Keep the foundation usable without Codec, Shell or AVML. Add a Codec adapter only
where the chosen editor scenario needs it; a basic programmatic host is sufficient
for the initial consumer example. Format-specific rules remain with their owner
even when the controls that expose them are reusable.

## Expected outputs

1. An inventory of Playground capabilities, dependencies and proposed ownership,
   with a coherent extraction scope and implementation order.
2. A reusable Toolkit module/package with documented public exports and host
   integration, based on the existing implementation.
3. Playground using the extracted functionality, with replaced local copies removed.
4. A standalone example/test application demonstrating the public API independently
   of Playground internals.
5. Focused verification of the moved interactions and a short account of remaining
   local behavior, limitations and subsequent extraction slices.

The task can proceed without a named second product. Lack of existing duplicate
code is not a reason to defer it. Implementation should follow the inventory
through a usable library and consumer example, rather than stop after identifying
a candidate boundary or extracting a token helper.

## First implementation step and validation

Start with the files above. Produce the inventory, select a coherent first
controls/tools group, extract it, adapt Playground, and demonstrate it in the
independent consumer. Continue through the agreed Toolkit scope in practical
slices; record what each slice exposes and exercises.

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
