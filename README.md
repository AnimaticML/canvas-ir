# CanvasIR

CanvasIR is a stand-in for `CanvasRenderingContext2D` that records drawing instead of painting it. Code that draws to a canvas (an SVG-to-canvas renderer, a chart library, your own shapes, a text layout) can draw into it unchanged. The result is a typed, JSON-safe document that geometry queries, transforms, rendering and interaction can all work from, without a browser.

Design: [docs/design.md](docs/design.md).

## Status

Phases 1 to 4 of 5: recording, the IR, serialization and replay; geometry queries; the full Canvas 2D drawing API; rich text layout.

| Works now | Not yet |
| --- | --- |
| Paths with the spec's construction rules, including `arc`, `arcTo`, `ellipse`, `roundRect`, and `Path2D` with SVG path data | Pixel access: `getImageData`, `putImageData`, `createImageData` |
| `fill`, `stroke`, `clip`, the rect helpers, `isPointInPath`, `isPointInStroke` | Patterns or gradients made by another context |
| Colors (normalized like browsers), gradients and patterns | Caret and selection helpers for editors |
| `drawImage`, `fillText`, `strokeText`, `measureText` | Intersections between ops, anchors |
| All transform calls, `save`/`restore`/`reset`, line styles and dashes, alpha, compositing, shadows, filter, image smoothing | Groups and events (phase 5) |
| Replay onto any real 2D context; validated JSON round trip | |
| Rich text layout: paragraphs, headings, lists, mixed fonts, any-shaped containers, obstacles, bidi | |
| Geometry: exact bounds, hit tests, rect queries, closest point, moving ops | |

Unsupported calls throw `UnsupportedCanvasCallError` rather than silently drawing nothing.

All of it is checked in headless Chromium. Every fixture in [`packages/pixel`](packages/pixel/src/fixtures.ts), and every SVG in its [corpus](packages/pixel/corpus) drawn by [canvg](https://github.com/canvg/canvg), is drawn directly and also recorded, serialized, parsed and replayed, and the two canvases must match pixel for pixel. Hit tests on the same drawings must agree with Chromium's own `isPointInPath` and `isPointInStroke` everywhere away from an edge, and with the pixels painted for images and text. Rich text laid out by `@canvas-ir/text` must wrap where Chromium's DOM layout wraps the same paragraphs, with lines at the same heights and the same horizontal extents, in Latin, CJK, Thai, Arabic, Hebrew and mixed-direction text. A benchmark keeps every query on a 10,000-op board under budget (`bun run bench`).

## Use

```ts
import { RecordingContext, Scene, replayDocument, serializeDocument } from "canvas-ir";

const ctx = new RecordingContext();
ctx.translate(50, 50);
ctx.beginPath();
ctx.arc(0, 0, 20, 0, Math.PI * 2);
ctx.fillStyle = "#0ea5e9";
ctx.fill();
ctx.drawImage(img, 0, 0);    // stored by reference: { src, width, height }
ctx.fillText("Hi", 10, 80);  // measured when drawn, so geometry needs no fonts

const doc = ctx.getDocument();
const json = serializeDocument(doc);

// Later, in a browser; images are looked up by the src they were recorded with:
replayDocument(canvas.getContext("2d")!, doc, { images: (src) => imageCache.get(src) });

// Anywhere, no browser needed:
const scene = new Scene(doc);
scene.hitTest({ x: 55, y: 50 });                           // [{ id: "o0", op }], topmost first
scene.bounds("o0");                                        // { x: 30, y: 30, width: 40, height: 40 }
scene.queryRect({ x: 0, y: 0, width: 100, height: 100 }); // ["o0"]
scene.transform("o0", { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
```

## Text layout

`@canvas-ir/text` lays out rich text with [Pretext](https://github.com/chenglou/pretext), so lines break where a browser would break them, and draws it as `fillText` calls into any context, a `RecordingContext` included.

```ts
import { drawTextLayout, layoutText } from "@canvas-ir/text";
import { pathRings } from "canvas-ir";

const layout = layoutText(
  {
    blocks: [
      { type: "heading", level: 2, content: ["Release notes"] },
      { type: "paragraph", content: ["Text can be ", { text: "bold", bold: true }, " or ", { text: "code", code: true }, "."] },
      { type: "list", items: [[{ type: "paragraph", content: ["Lists nest and number."] }]] },
    ],
  },
  {
    container: { x: 0, y: 0, width: 320 },     // or { rings: pathRings(path) } for any shape
    obstacles: [{ rings: pathRings(imagePath) }], // text flows around these
    theme: { fontFamily: '"Inter", sans-serif', fontSize: 16 },
  },
);
drawTextLayout(ctx, layout); // one fillText per run; layout.lines has every line's box and baseline
```

The layout records the Pretext version, the line-breaking engine and every font it measured in `layout.fingerprint`, so a host can tell when a stored layout came from another environment.

## How the IR stores drawing

- Each op (`fill`, `stroke`, `clear`, `image`, `text`) keeps the transform, drawing state and clip in effect when it was painted. A clip is stored on each op it applies to as a list of paths, so every op stands alone.
- Paints are plain data: a color string, or a gradient or pattern with its stops, geometry and transform as they were when the op was drawn.
- Images are references (`src`, width, height); `describeImage` decides what a reference is, and replay resolves it with `images`. Text keeps its string, font state and the measurement taken when it was drawn; measurement can be injected with `measureText`.
- Path coordinates are stored as the caller passed them. Each subpath start and segment points at the matrix that was current when it was added, so a path built across transform changes stays exact, and `arc`/`ellipse` stay true curves under any transform.
- `arc` and `ellipse` are kept as separate segment kinds, and a path an `arc` or `ellipse` began records that it had no `moveTo`, because browsers rasterize those cases differently.
- Calls follow the Canvas 2D spec: `lineTo` with no subpath acts as `moveTo`, `arc` adds a line to its start point, `closePath` starts a new subpath at the old start, and calls with `NaN` or `Infinity` are ignored.

## How geometry works

- `Scene` derives a shape per op on first use and caches it: the path flattened in world space for fills, and for strokes a union of convex pieces (a quad per segment, plus joins and caps) built in the stroke's own space, so width, dashes and joins stay right under non-uniform scale and skew.
- Bounds are exact: curve and arc extrema are solved analytically. Hit tests and rect queries are exact for lines and within the flattening tolerance (default 0.1 world units) for curves.
- A uniform grid narrows each query to nearby ops. Moving or replacing an op recomputes only that op.
- A `clearRect` hides whatever it covers from hit tests. Ops drawn with `globalAlpha` 0 are skipped unless asked for.
- A point must be inside every clip path of an op to hit it. Images hit-test as the part of their destination the source covers, text as its ink box from the recorded measurement.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run bench
bun run test:pixel   # needs Chromium; set CHROMIUM_PATH if Playwright can't find one
```

`packages/core` is the library, `packages/text` the text layout layer on top of it, and `packages/pixel` holds the browser checks. After changing a text fixture, run `bun run --cwd packages/pixel capture-text` to capture its measurements and layout from Chromium for the Bun tests. Tooling such as the playground will live in its own packages and depend on the core, never the reverse.
