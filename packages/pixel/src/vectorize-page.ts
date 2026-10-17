// The vectorizer experiment, measured in the browser: each source image is
// traced into fills, the fills are replayed, and the replay is compared with the
// source. Tracked, not gated.
import { vectorize } from "@canvas-ir/vectorize";
import { replayDocument, toSVG } from "canvas-ir";

export interface VectorizeReport {
  readonly name: string;
  readonly colors: number;
  readonly rings: number;
  readonly points: number;
  /** Mean over pixels of the largest channel difference, 0 to 255. */
  readonly meanDelta: number;
  /** Share of pixels whose largest channel difference is over 32. */
  readonly off: number;
  readonly svgBytes: number;
  readonly error?: string;
}

const run = async (sources: readonly { name: string; png: string }[]): Promise<VectorizeReport[]> => {
  const out: VectorizeReport[] = [];
  for (const { name: source, png } of sources) for (const curves of [false, true]) {
    const name = curves ? `${source}, curves` : source;
    try {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const { width, height } = img;
      const source = new OffscreenCanvas(width, height).getContext("2d")!;
      source.drawImage(img, 0, 0);
      const pixels = source.getImageData(0, 0, width, height);
      const result = vectorize(pixels, { curves });
      const replay = new OffscreenCanvas(width, height).getContext("2d")!;
      replayDocument(replay as unknown as CanvasRenderingContext2D, result.document);
      const a = pixels.data;
      const b = replay.getImageData(0, 0, width, height).data;
      let sum = 0;
      let off = 0;
      for (let i = 0; i < a.length; i += 4) {
        // Composite both over white, as the sources were shot.
        const over = (d: Uint8ClampedArray, k: number) => 255 - ((255 - d[i + k]!) * d[i + 3]!) / 255;
        const delta = Math.max(Math.abs(over(a, 0) - over(b, 0)), Math.abs(over(a, 1) - over(b, 1)), Math.abs(over(a, 2) - over(b, 2)));
        sum += delta;
        if (delta > 32) off++;
      }
      const pixelCount = a.length / 4;
      out.push({
        name,
        colors: result.palette.length,
        rings: result.rings,
        points: result.points,
        meanDelta: sum / pixelCount,
        off: off / pixelCount,
        svgBytes: toSVG(result.document, { width, height }).length,
      });
    } catch (error) {
      out.push({ name, colors: 0, rings: 0, points: 0, meanDelta: NaN, off: NaN, svgBytes: 0, error: String(error) });
    }
  }
  return out;
};

(globalThis as { runVectorize?: typeof run }).runVectorize = run;
