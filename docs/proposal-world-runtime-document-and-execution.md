# Proposal: world documents, simulation, time, and shared execution

Date: 2026-11-24
Status: research and implementation handoff. The direction below is agreed for investigation; package names, schemas, and execution contracts are proposals, not implemented public APIs.

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

## Purpose and ownership

Investigate a reusable foundation for editable 2D and 3D worlds in this workspace: a document format, its execution, shared time mechanisms, and integration with applications such as ml-animatic. A world can support interactive play, staged animation, motion input, or combinations of these.

Canvas IR is the proposed owner because its existing packages already handle drawing, geometry, interaction, physics integration, 3D surfaces, and motion. No new repository is required. This does not make the existing rendering IR the authoring format or require every Canvas IR consumer to adopt a document model.

The working direction is:

- Keep low-level Canvas IR and engine-independent execution usable without ML Collab Codec, Shell, or AVML.
- Provide a world document as an optional higher-level library built on ML Collab Codec.
- Keep meaningful persisted state, semantic edits, and collaborative history in that document integration. Derive rendering data and high-frequency simulation state in the runtime.
- Let applications and components define domain rules. Shared timing and execution supply mechanisms for running those rules.
- Share execution mechanisms with ml-animatic where actual implementations demonstrate the same need. ml-animatic keeps its audiovisual composition semantics.

## Implemented baseline to examine first

This handoff was checked against commit `c2acb32a27d906db3ea6943a098516f9b8d20120`.

- [The roadmap](roadmap.md#where-the-document-lives) assigns application documents, components, and undo to applications. Preserve that boundary for the low-level library; an optional world-document package would extend the workspace's offering.
- [`IRDocument`](../packages/core/src/types.ts) and [serialization](../packages/core/src/serialization.ts) already represent JSON-safe drawing operations and groups. They are not a collaborative authoring model for a world.
- [`Clip`, `Timeline`, and `Player`](../packages/core/src/timeline.ts) support keyframes, tweens, nested track clocks, and timed scripts. `Player.seek()` does not execute skipped scripts; playback currently limits a single elapsed interval to 100 ms.
- [The Planck adapter](../packages/physics/src/index.ts) advances fixed steps, limits accumulated time to five steps, and reports contacts after the step batch.
- The [Babylon](../packages/babylon/src/index.ts) and [Three](../packages/three/src/index.ts) `World` classes integrate surfaces, picking, and interaction. Their names do not imply a general simulation runtime.
- [The Playground machine](../packages/playground/src/machine.ts) demonstrates Havok fixed stepping, snapshots, and callbacks after a selected step. Havok integration is not yet a general extracted execution package.
- [`@canvas-ir/motion`](motion.md) already separates engine-independent solving and retargeting from the lab. Its takes are structured temporal resources.

Start from these differing contracts and the current ml-animatic preview/backend contracts. Do not infer a common scheduler merely from similar names.

## World authoring

### Questions to resolve

Find the smallest organizing model that supports the first examples. Candidates include entities, containment, coordinate spaces, component parameters, referenced assets, activities, and event responses. Decide which concepts belong in the shared format and which remain application extensions.

The authoring representation should remain convenient for agents to read and edit as a tree. Shared resources and references are compatible with that goal; a mandatory graph editor or ECS is not implied. Forward references are acceptable when resolution is well defined. Diagnose unresolved references and cyclic dependencies that prevent evaluation. Ordinary event feedback between active components is a different concern from recursively requiring the same render result to compute itself.

Distinguish the following without prescribing a separate format for each:

| Information | Proposed home |
|---|---|
| Entities, resource choices, initial placement, authored constraints and activities | World document |
| A meaningful move, parameter edit, or saved arrangement | Ordinary document operations produced by a semantic action |
| Physics positions between meaningful saved states, solver caches, render objects | Execution instance |
| A recorded input stream or reusable animation | Referenced temporal resource, with document parameters where needed |
| Which action is allowed, or how a character reacts to a collision | Application/component logic |

Preparation and use can share the same operations. Moving a card while preparing a table and moving it during play do not require different document models. Conversely, recording every simulation step through operational transformation is not the proposed synchronization mechanism.

Real-time multiplayer has a separate synchronization contract. The reference direction is player input delivered to a server-authoritative simulation, with confirmed state or events communicated to participants. Codec can still represent world definitions, meaningful document changes, and saved states or checkpoints. The application's network adapter owns that synchronization policy; the shared temporal layer does not decide player authority or implement the multiplayer protocol. Implementing that protocol is not a prerequisite for the first examples.

Use existing asset formats for meshes, rigs, textures, audio, video, and recorded animation. A document element can expose only the parameters and actions its application needs. Importing an animated character need not copy its vertices or every sampled pose into the collaborative tree. A pose editor may deliberately expose joint parameters; an application that merely plays a clip need not.

Research common 2D/3D concepts without forcing identical geometry or interaction APIs. Define units, coordinate-space references, object identity, and conversion boundaries where interoperability needs them. More expressive camera or staging intentions can be component types; exact transforms must remain available when needed.

## Time, scheduling, and execution

The common temporal layer concerns clocks, evaluation, and event delivery. It does not decide who owns an object, how a character changes goals, or which game rule wins.

Investigate these distinctions explicitly:

1. **Sampling:** evaluate an animation or a recorded resource at a requested time. A rendered frame need not become a queued simulation event.
2. **Advancing:** move a stateful simulation through an interval using the provider's stepping contract.
3. **Events:** deliver timed or externally supplied occurrences, including contacts reported by a simulation.
4. **Observation:** inspect an established state without implicitly advancing it.

Rendering cadence and simulation cadence are separate. The scheduler may coordinate providers with different rates; this does not require one universal tick rate for physics, audio, video, and motion. Document revision/history order is also distinct from execution time.

Questions for a first temporal contract:

- How are local clocks identified, advanced, paused, and mapped to parent time?
- What ordering applies to events at the same time, including newly scheduled events?
- How are pending events cancelled, and how does disposal of an activity cancel its pending work?
- How does an event request a component-defined condition check? If that check fails, the component's declared policy must determine skip, cancellation, or rescheduling; the timing library must not invent domain behavior.
- What do `seek`, `reset`, replay, and playback mean for each provider? Which require a checkpoint and recorded inputs, and which are unsupported?
- What mappings are needed between local seconds, media frame/sample positions, and musical positions under a tempo model? Include [Harmonica](https://github.com/alexandr-panchenko/harmonica/blob/main/docs/canvas-collab-architecture.md)'s transport and audio paths in the consumer comparison before treating the extracted time contract as generally reusable. Musical semantics remain with their provider; this comparison does not require migrating Harmonica in the first slice.
- How are external input timestamps translated and how is late input reported?
- What happens when real-time playback falls behind, compared with offline rendering that must process all required steps?

Preserve separate execution instances. A world document and a timestamp alone may not identify a unique state when inputs, random choices, or resource versions differ. A reproducible run needs sufficient initial conditions, inputs, resource/code versions, and provider-specific guarantees. Fixed timesteps alone do not establish identical results across all engines or platforms.

A parent can compose several independently timed outputs. Each use has its own placement, source range, view parameters, and time mapping. Repeating a view of a recorded world event must not execute its gameplay side effects again. Reverse or random access to a stateful simulation is a capability to establish, not an automatic consequence of timeline syntax.

### Reference models to compare

Use existing industry models alongside the local implementations:

- [OpenTimelineIO time ranges](https://opentimelineio.readthedocs.io/en/latest/tutorials/time-ranges.html) distinguish source and parent time coordinates. Compare those boundaries with occurrence placement and nested composition.
- [Godot physics interpolation](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/physics_interpolation_introduction.html) distinguishes fixed physics ticks from rendered frames. Compare its responsibilities with the current Planck and Havok adapters.
- [W3C Web Animations timing model](https://www.w3.org/TR/web-animations-1/#timing-model) provides a reference for local time, playback and effect evaluation. Evaluate which concepts help; it does not establish the required world event or physics contracts.

Record what is reused, adapted or rejected and why. These references inform separate parts of the design; none is assumed to supply the complete shared runtime.

## Shared backend extraction

Here, backend means execution code and platform adapters, not specifically a Shell server. Candidate common responsibilities are local clocks, scheduling, instance lifecycle, sampling/advancement coordination, resource readiness, and observations tied to their source and execution context.

Compare the existing Canvas execution paths and ml-animatic APIs while shaping the shared contract. Use focused prototypes or standalone example applications to establish missing boundaries; completed downstream products are not a prerequisite for implementing and validating the library. Audiovisual track selection and montage compilation stay with ml-animatic. World entity behavior stays with world/application components. Codec remains the editing and collaboration foundation. Engine adapters keep engine-specific stepping, rendering, and resource handling.

Possible package names are `@canvas-ir/runtime` and `@canvas-ir/world-document`; these are placeholders. The first implementation may use internal modules or separate entrypoints instead. A separate `world` package is justified only if there is a meaningful programmatic execution API independent of the document package.

The dependency direction must allow:

- world-document integration to depend on Codec and Canvas execution;
- ml-animatic to consume a generic execution contract and an optional world provider;
- an application to register a ml-animatic media provider with a world runtime.

The generic runtime must not import AVML. Showing a film from ml-animatic inside a world is achieved by application wiring of a media provider. This permits mutual composition of results without a static package dependency cycle.

Browser preview, headless rendering, and server execution may use different adapters. Establish their supported capabilities explicitly. Do not assume a heavy graphics, audio, or video backend runs inside a Cloudflare Worker merely because Shell can run there.

## Embedding and later component evolution

Start with statically supported component types and a registered provider. An embedded scene can expose actions and parameters, such as selecting a camera or changing a reusable shot preset. Per-use parameters can live in the host document while their schema and meaning belong to the embedded format.

Separate editing the shared scene from editing one occurrence's camera. A temporary camera for inspection is a third case and need not modify either document. Establish source identity and ownership before deciding whether content is referenced externally or stored inline.

Dynamic component loading is a later extension of the same model, not a prerequisite for the first world document. Investigate versioned code/resource references, preserved meaningful state, activation lifecycle, and migration only with a concrete consumer. Importing JavaScript that exposes ordinary document actions does not require a new programming language or VM. Sandbox, admission, and trusted-host boundaries must be coordinated with Shell; runtime modules must not assume authority to install trusted validators or handlers.

## Two examples that constrain the design

### Interview with shot and reverse shot

One scene contains two people at a table. Two ml-animatic occurrences use that scene with different cameras. Their scene time can overlap while their montage positions differ. The user or agent can edit the common staging, edit one shot's parameters, and inspect a selected instant. The scene can supply a direct preview or reference media for generation.

This should establish document/instance/occurrence identity, shared versus local parameters, temporal mapping, and the world provider boundary.

### Cinema inside a game world

A world contains a screen playing an AVML document while people move around the room. Pausing or seeking the film leaves world time running. An application-defined action can control the media provider. No gameplay rule is embedded in the shared clock implementation.

This should establish independent local clocks, active composition, lifecycle, and application registration without a Canvas-to-AVML dependency.

## Expected outputs and first implementation slice

Produce a short decision record covering ownership, the minimum world schema, temporal semantics, provider boundaries, and which extraction is supported by evidence. Include unresolved alternatives and concrete reasons to defer them.

The first slice is the smallest interview scene with two parameterized views, an independently controllable playback clock, and a coherent observation. Then exercise the cinema example to challenge the same abstractions. Reuse existing renderers and assets.

Bound validation to the risks these examples expose: document round-trip and semantic edit integration; independent camera parameters; frame cadence not silently defining simulation progression; consistent event ordering/cancellation in the chosen contract; observation without extra simulation steps; and world playback continuing while embedded media is paused or sought.

Update canonical documentation only after these contracts are selected and implemented. Cross-reference [runtime observation](proposal-world-runtime-observation.md) and [Toolkit extraction](proposal-world-runtime-toolkit.md); neither requires completion of a universal world engine.
