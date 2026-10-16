# CanvasIR

CanvasIR is a stand-in for `CanvasRenderingContext2D` that records drawing instead of painting it. Code that draws to a canvas (an SVG-to-canvas renderer, a chart library, your own shapes, a text layout) can draw into it unchanged. The result is a typed, JSON-safe document that geometry queries, transforms, rendering and interaction can all work from, without a browser.

Design: [docs/design.md](docs/design.md).

## Status

Phase 1 of 5: recording, the IR, serialization and replay.

| Works now | Not yet |
| --- | --- |
| Paths with the spec's construction rules: `moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `closePath` | `roundRect`, `Path2D` |
| `fill`, `stroke`, `fillRect`, `strokeRect`, `clearRect` | `clip`, `isPointInPath`, `isPointInStroke` |
| All transform calls, `save`/`restore`/`reset`, line styles and dashes, alpha, compositing, shadows, filter | Gradients and patterns |
| Replay onto any real 2D context | Text, images, pixel access |
| Validated JSON round trip | Geometry queries (phase 2) |

Unsupported calls throw `UnsupportedCanvasCallError` rather than silently drawing nothing.

## Use

```ts
import { RecordingContext, replayDocument, serializeDocument } from "canvas-ir";

const ctx = new RecordingContext();
ctx.translate(50, 50);
ctx.beginPath();
ctx.arc(0, 0, 20, 0, Math.PI * 2);
ctx.fillStyle = "#0ea5e9";
ctx.fill();

const doc = ctx.getDocument();
const json = serializeDocument(doc);

// Later, in a browser:
replayDocument(canvas.getContext("2d")!, doc);
```

## How the IR stores drawing

- Each op (`fill`, `stroke`, `clear`) keeps the transform and drawing state in effect when it was painted.
- Path coordinates are stored as the caller passed them. Each subpath start and segment points at the matrix that was current when it was added, so a path built across transform changes stays exact, and `arc`/`ellipse` stay true curves under any transform.
- Calls follow the Canvas 2D spec: `lineTo` with no subpath acts as `moveTo`, `arc` adds a line to its start point, `closePath` starts a new subpath at the old start, and calls with `NaN` or `Infinity` are ignored.

## Develop

```sh
bun install
bun test
bun run typecheck
```

`packages/core` is the library. Tooling such as the playground will live in its own packages and depend on the core, never the reverse.
