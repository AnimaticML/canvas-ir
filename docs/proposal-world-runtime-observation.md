# Proposal: observing world and media execution

Date: 2026-11-24
Status: research and implementation handoff. This proposes a provider surface over existing capabilities; it does not describe an implemented universal query API.

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

Give application code, users, and agents practical access to what a runtime has produced. An agent editing a scene needs to inspect the result, identify the corresponding document objects, and iterate using the same semantic operations as the application.

Observation includes images or media excerpts, structural and geometric answers, and results of explicitly requested trial execution. The useful query set differs between 2D, 3D, motion, physics, and audiovisual playback. The goal is a discoverable provider-specific surface, not one mandatory inventory of queries for every runtime.

Canvas IR owns its query semantics and implementations. Shell owns external access, grants, transport, and hosted runtime lifecycle. A programmer-facing function should be the implementation behind an agent capability; do not create a parallel agent-only execution path.

## Current implemented baseline

Checked at `c2acb32a27d906db3ea6943a098516f9b8d20120`:

- [Scene geometry and interaction](../packages/core/src/geometry/scene.ts) already support queries about recorded drawing objects. [The roadmap](roadmap.md) describes intersections, anchors, snapping, selection, and incremental updates.
- [Babylon World](../packages/babylon/src/index.ts) and [Three World](../packages/three/src/index.ts) connect camera rays, meshes, surfaces, and interaction targets.
- [AR diagnostics](../packages/playground/src/ar/diagnostic.ts) package camera images, overlays, metadata, and traces. Their manifest already distinguishes capture timing from processing completion.
- [Motion takes](../packages/motion/src/take.ts) provide `frameAt`, `imageAt`, and `labelsAt`, alongside recorded frames and annotations. [Motion documentation](motion.md) explicitly supports inspection by people and multimodal models.
- [The Havok machine example](../packages/playground/src/machine.ts) exposes snapshots and callbacks after selected steps. This is a local example, not a general historical-state query service.

Reuse these implementations. First identify which functions can be exposed directly, which need context wrappers, and which currently exist only in Playground.

## Observation context and identity

A useful result must say what it observed. Investigate a compact context carrying the applicable subset of:

| Context | Why it matters |
|---|---|
| Source document and revision | Identifies the authored input; optional for purely programmatic consumers |
| Source entity or element reference | Connects a query result or visible object to an editable item |
| Runtime instance and run/checkpoint | Distinguishes separate executions of the same document |
| Local time and clock identity | Distinguishes world time, embedded media time, and parent composition time |
| Camera/view and relevant render settings | Makes the observation reproducible and interpretable |
| Input/resource readiness and limitations | Prevents an incomplete result from appearing final |

Document integrations must provide stable references for objects they expect agents to inspect and edit. Low-level group IDs are not automatically globally unique across instances or exports. Generated primitives can refer to their owning source element and an optional subpart. Do not force a Codec dependency into a geometry query merely to carry this reference.

Establish the mapping when creating runtime objects. Avoid reconstructing source identity later from pixel appearance or display labels. A render result may include an object-ID mapping, selected-object overlays, or a structured list when the provider supports it; these are capabilities, not compulsory outputs of every renderer.

## Questions for the provider interface

Research how a provider describes available operations, parameter/result shapes, required execution context, and effects. Distinguish:

- reading stored or derived document information;
- observing a current or reproducible runtime state;
- evaluating or rendering an explicitly requested time/view;
- running a trial that advances an isolated execution;
- applying an authored semantic change.

The distinction must be visible to callers. Inspecting a state must not secretly step physics or fire gameplay events. A probe that changes state should use an explicit fork/reset/advance contract or report that isolation is unavailable.

Selecting a temporary inspection camera must not change the scene's authored camera or one ml-animatic occurrence's camera parameters. Persisting that view is a separate semantic action. Multiple observations of one source should not fight over a single global camera.

An image and its structured data must refer to the same captured state. Define whether a query freezes an observation snapshot, uses a revision/time token, or reports that the execution changed before completion. Asynchronous rendering and resource loading must not silently substitute a later state.

Historical queries need an honest capability boundary. A document and time may be insufficient to reproduce a physics run with external inputs. Providers can require recorded input/checkpoints, reconstruct from supported data, or return an unsupported/unavailable result. Do not promise arbitrary rewind from the existence of a `seek` control elsewhere.

## Composition with other runtimes

An embedded application exposes the queries meaningful for its own format. The host routes to the appropriate instance and preserves source and occurrence context. Canvas need not understand AVML syntax to observe a world used by ml-animatic, and a world need not import AVML to host a registered media provider.

Coordinate with the Video handoff on image/audio observations and selected-time rendering. A rendered canvas alone may omit video layers or other composed surfaces; an observation must describe what is included. Coordinate with Shell on discovery and artifact delivery without introducing an unrestricted host-method bridge.

Some queries can run in ordinary code without a browser. Others require a live scene, audio context, graphics device, or a prepared backend. Capabilities should expose those requirements and readiness. This proposal does not require one process to support every rendering backend.

## Expected outputs

1. An inventory of existing query/capture APIs and their missing context, grouped by provider.
2. A small provider contract with one direct application API and an adapter suitable for external discovery.
3. Source mapping and observation-context examples for a document-backed scene and a programmatic scene.
4. An explicit account of unsupported queries, resource readiness, and reproducibility limits.

Keep the implementation in the runtime/adapters initially. A separate inspection package is justified only if a real reuse boundary emerges.

## First slice and bounded validation

The provider surface can begin with an existing programmatic Scene/World or a
recorded motion take. Adding the source-document binding in the interview example
must not block observation of those already available runtimes.

Use the interview example from [the world/execution handoff](proposal-world-runtime-document-and-execution.md). At one scene instant, request two temporary views and a structural answer about the same objects. Show how an agent maps a visible object back to its source and invokes the existing semantic operation to adjust it.

Then inspect the cinema example with different world and film times. The result must make clear which instance and clock each observation describes.

Validate only the relevant boundaries: image/data context agrees; source references distinguish repeated instances; capture does not advance physics or mutate authored camera parameters; an explicitly isolated probe leaves the live instance unchanged; stale or unsupported context is reported. Reuse existing geometry, motion, and rendering tests rather than duplicating their numerical suites here.
