# SVG corpus

SVG files drawn by [canvg](https://github.com/canvg/canvg) for the pixel test. Each one is rendered onto a canvas directly, and also onto a `RecordingContext` whose document is serialized, parsed and replayed; the two canvases must match pixel for pixel, and hit tests on the recorded document must agree with Chromium.

The files are written for this project and cover what canvg turns into Canvas calls: shapes, path data, transforms, `viewBox` and nested `svg`, strokes and dashes, fill rules, colors and opacity, gradients, patterns, clip paths, `use` and `symbol`, markers, images, text and `textPath`, CSS, and units.

Left out, because canvg implements them with something a recorder cannot capture:

- `gradientTransform`: canvg paints the gradient onto its own canvas and fills with a pattern made by that canvas's context.
- `mask` and `filter`: canvg reads pixels back with `getImageData`.

A file whose drawing hits a known Chromium deviation says so in a comment of the form `<!-- engine-deviation: ... -->`, and is then held to the same looser standard as a fixture with `engineDeviation`.
