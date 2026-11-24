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

Extract reusable interaction and editor UI from Playground when an actual second application needs it. Canvas IR consumers should be able to reuse controls and editing tools while keeping their own document format, rendering choices, semantic actions, and history.

This work supports world-document editing and embedded scene controls, but does not depend on completing a simulation engine. It also serves ordinary 2D applications. Keep its scope separate from the time/execution investigation.

## Current implemented baseline

Checked at `c2acb32a27d906db3ea6943a098516f9b8d20120`:

- The workspace has core, text, graphics/physics adapters, motion, and Playground packages; there is no separate Toolkit package in this revision.
- [`playground/src/ui/kit.ts`](../packages/playground/src/ui/kit.ts) implements reusable-looking controls, text input support, drawing helpers, a panel `Surface` contract, and styles.
- [`playground/src/tools.ts`](../packages/playground/src/tools.ts) implements drawing tools against `ToolHost`. That interface supplies host facilities and a `commit` callback, providing an existing separation from persistence.
- [`core/src/components.ts`](../packages/core/src/components.ts) and the existing interaction system already provide component redraw and input behavior. Toolkit should build on these rather than duplicate them.
- [The roadmap's document boundary](roadmap.md#where-the-document-lives) leaves document ownership and undo semantics with applications. Its descriptions of snapping, live text, accessibility, and tools identify existing lower-level functions to reuse.

These are starting points, not proof that every Playground abstraction is ready to become public. The extraction should be driven by the needs of two consumers and the removal of duplicated implementation between them.

## Questions to investigate

### What is the first useful reusable unit?

Inventory actual duplication in Playground and one selected consuming application. Possible first units are controls/panels, selection and manipulation, or a small set of drawing tools. Pick the smallest unit that both applications need now.

Do not move all Playground UI simply because it is in a folder named `ui`. Motion-lab diagnostics, AR calibration flows, demo-specific window management, and game-specific card behavior may remain local. Reusing a basic slider does not imply sharing the complete screen around it.

### Where does an editing gesture become a document action?

A tool may produce transient preview state while dragging and request a semantic change on completion. Establish the host contract for coordinates, hit targets, selection, snapping, preview, commit, cancellation, and error reporting where the selected tools require them.

The host decides how the semantic change is implemented and admitted. A Codec integration may compute several ordinary operations and submit them atomically while recording a meaningful history group. A programmatic Playground host may update a scene directly. Toolkit must not introduce a second document model, collaboration engine, or undo stack.

Distinguish a gesture from a history group and from an atomic request. Continuous input does not by itself determine persistence policy. Domain-specific tools may also need intermediate committed actions; avoid hardcoding one gesture-to-transaction rule for every application.

### Which responsibilities are actually common?

| Responsibility | Proposed boundary |
|---|---|
| Rendering a reusable control and handling its local input | Toolkit |
| Hit testing, geometry, low-level event routing | Existing Canvas IR APIs |
| Current selection/view state and available tool context | Host contract, with helpers when shared |
| Meaning of an action and validation of its consequences | Application or format integration |
| Collaboration, persistence, history, admission | Existing document/host integration |
| Choosing a world camera or manipulating a 3D object | Relevant provider/tool adapter |

Investigate 2D and 3D similarities without requiring identical gestures or gizmos. A generic input layer can recognize interaction primitives while concrete tools interpret them in their own coordinate spaces. Motion input can later invoke those same actions where appropriate; it does not require every editor tool to depend on MediaPipe or the motion package.

### How does an embedded editor expose its controls?

An embedded scene may expose a camera selector, shot parameters, or staging tools. The UI invokes the same application functions that agents can discover. Toolkit is a presentation and interaction consumer of those functions, not the owner of a universal agent protocol.

Keep temporary viewing controls distinct from persisted edits. Orbiting a scene to inspect it should not silently rewrite an authored shot. A separate operation can adopt the current view as a shot parameter when the application offers that action.

## Candidate packaging

`@canvas-ir/toolkit` is a working name. Begin with a narrow module boundary and exports that reflect the first shared unit. A separate optional Codec adapter can be added only when the selected consumers demonstrate its need; core controls and tools should remain usable with a programmatic host.

Avoid making the package depend on Shell or AVML. An application assembles Toolkit, its format, and its runtime provider. World-specific editor behavior can remain in the world-document integration until another consumer establishes a reusable part.

Review dependency and environment assumptions during extraction. Browser-only text input or accessibility helpers should be identified as such, while pure geometry or tool calculations should not acquire a DOM dependency unnecessarily. Preserve existing low-level functionality rather than maintaining copied versions inside Toolkit.

## Expected outputs

1. A short inventory naming the two real consumers, the duplicated behavior, and the exact first extraction.
2. A documented host contract with persistence and semantic-action ownership explicit.
3. One reusable implementation consumed by both applications, with the replaced duplication removed.
4. An example showing the same tool with a direct programmatic host and, if required by the selected consumer, a document-backed host.
5. A brief account of what remains local and why; these are scope decisions, not a backlog to extract everything later.

The second consumer must be an actual application requirement, not a synthetic host created solely to justify a package. Inspect current consumers before selecting it. If there is no shared implementation need yet, document the candidate boundary and defer package creation.

## First slice and bounded validation

Choose one duplicated control/tool group. Port Playground to that shared implementation, then use it in the selected application. Keep any necessary host adaptation explicit and small enough to compare.

Verify the interaction paths affected by extraction: preview and commit reach the correct host; cancellation leaves the expected state; coordinate mapping and selection still work; focus/text input or accessibility remain intact for the moved controls. If the application uses Codec, verify one meaningful edit goes through its existing action/history path. Reuse existing geometry and event-router tests.

Do not require a new exhaustive editor test suite or a generalized plugin system before this slice can ship. The extraction succeeds when real duplicated code is replaced and both consumers retain their intended editing semantics.

Related work: [world documents and execution](proposal-world-runtime-document-and-execution.md) define the optional world integration; [runtime observation](proposal-world-runtime-observation.md) defines inspection. Toolkit can expose those capabilities in UI without owning their semantics.
