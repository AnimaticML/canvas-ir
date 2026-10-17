// Image outlines, checked in the browser: for test images with soft edges, holes,
// glyphs and specks, drawn under transforms and crops with and without
// smoothing, a hit test on the recorded op must report a hit exactly where
// Chromium paints the image with alpha of at least the threshold, at every
// device pixel whose center is clear of the outline and the crop's edge.
import { RecordingContext, Scene, applyToPoint, invert, maxScale, traceImageOutline, type Matrix2D } from "canvas-ir";

export interface OutlineResult {
  readonly name: string;
  readonly rings: number;
  readonly points: number;
  readonly checked: number;
  readonly disagree: number;
  readonly error?: string;
}

const SIZE = { width: 160, height: 120 };
const THRESHOLD = 128;
const TOLERANCE = 0.75;

const images: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  donut: (ctx) => {
    ctx.fillStyle = "#16a34a";
    ctx.beginPath();
    ctx.arc(80, 60, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(86, 56, 22, 0, Math.PI * 2);
    ctx.fill();
  },
  glyphs: (ctx) => {
    ctx.fillStyle = "#1d4ed8";
    ctx.font = "bold 72px 'Liberation Sans', sans-serif";
    ctx.fillText("Ag%", 6, 86);
  },
  "lines and specks": (ctx) => {
    ctx.strokeStyle = "#b45309";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(8, 110);
    ctx.lineTo(150, 12);
    ctx.moveTo(10, 20);
    ctx.quadraticCurveTo(80, 120, 150, 60);
    ctx.stroke();
    ctx.fillStyle = "#7c3aed";
    for (let i = 0; i < 25; i++) ctx.fillRect((i * 37) % 150 + 3, (i * 53) % 110 + 4, 1 + (i % 3), 1 + (i % 2));
  },
  "alpha gradient": (ctx) => {
    const g = ctx.createRadialGradient(80, 60, 5, 80, 60, 70);
    g.addColorStop(0, "rgba(220, 38, 38, 1)");
    g.addColorStop(1, "rgba(220, 38, 38, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 160, 120);
  },
};

interface Placement {
  readonly name: string;
  readonly transform: Matrix2D;
  readonly source: readonly [number, number, number, number];
  readonly dest: readonly [number, number, number, number];
  readonly smoothing: boolean;
}

const placements: readonly Placement[] = [
  { name: "as is", transform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 }, source: [0, 0, 160, 120], dest: [0, 0, 160, 120], smoothing: false },
  {
    name: "scaled and rotated",
    transform: { a: Math.cos(0.4), b: Math.sin(0.4), c: -Math.sin(0.4), d: Math.cos(0.4), e: 230, f: 30 },
    source: [0, 0, 160, 120],
    dest: [0, 0, 368, 276],
    smoothing: false,
  },
  {
    name: "cropped and smoothed",
    transform: { a: 1, b: 0, c: 0.2, d: 1, e: 10, f: 10 },
    source: [30, 15, 110, 90],
    dest: [0, 0, 275, 225],
    smoothing: true,
  },
];

const W = 640;
const H = 400;

const run = (): OutlineResult[] => {
  const out: OutlineResult[] = [];
  for (const [imageName, paint] of Object.entries(images)) {
    const image = new OffscreenCanvas(SIZE.width, SIZE.height);
    const ictx = image.getContext("2d")!;
    paint(ictx);
    const outline = traceImageOutline(ictx.getImageData(0, 0, SIZE.width, SIZE.height), { threshold: THRESHOLD, tolerance: TOLERANCE });
    for (const p of placements) {
      const name = `${imageName}, ${p.name}`;
      try {
        const recorder = new RecordingContext({ width: W, height: H, describeImage: () => ({ src: imageName, ...SIZE, outline }) });
        const t = p.transform;
        recorder.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        recorder.imageSmoothingEnabled = p.smoothing;
        recorder.drawImage(image as unknown as CanvasImageSource, ...p.source, ...p.dest);
        const scene = new Scene(recorder.getDocument());
        const canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        ctx.imageSmoothingEnabled = p.smoothing;
        ctx.drawImage(image, ...p.source, ...p.dest);
        const painted = ctx.getImageData(0, 0, W, H).data;
        // Where each device pixel falls in the image, to keep clear of the crop's edges, where smoothing bleeds.
        const [sx, sy, sw, sh] = p.source;
        const [dx, dy, dw, dh] = p.dest;
        const scale = maxScale({ a: (t.a * dw) / sw, b: (t.b * dw) / sw, c: (t.c * dh) / sh, d: (t.d * dh) / sh, e: 0, f: 0 });
        // Simplification moves the outline up to the tolerance, and painting blurs it by about a pixel either side.
        const margin = (TOLERANCE + 1) * scale;
        const fromDevice = invert(t)!;
        let checked = 0;
        let disagree = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const point = { x: x + 0.5, y: y + 0.5 };
            const local = applyToPoint(fromDevice, point.x, point.y);
            const px = sx + ((local.x - dx) * sw) / dw;
            const py = sy + ((local.y - dy) * sh) / dh;
            const cropGap = Math.min(Math.abs(px - sx), Math.abs(px - sx - sw), Math.abs(py - sy), Math.abs(py - sy - sh));
            if (cropGap <= 2) continue;
            if (scene.closestPoint(point, { maxDistance: margin })) continue;
            checked++;
            const opaque = painted[(y * W + x) * 4 + 3]! >= THRESHOLD;
            if (opaque !== scene.hitTest(point).length > 0) disagree++;
          }
        }
        out.push({ name, rings: outline.length, points: outline.reduce((n, r) => n + r.length, 0), checked, disagree });
      } catch (error) {
        out.push({ name, rings: 0, points: 0, checked: 0, disagree: 0, error: String(error) });
      }
    }
  }
  return out;
};

(globalThis as { runOutlines?: typeof run }).runOutlines = run;
