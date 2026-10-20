// Paint by numbers: a small painting (or a picture of yours) is rasterized,
// matched to a palette by @canvas-ir/vectorize (a fixed one for the painting,
// k-means clusters for a photo) and split into 4-connected regions whose
// borders are traced once and shared by both sides. The template is drawn
// from those borders; clicking a region paints it, read off the index map.
import { type ComponentSpec, RecordingContext, type RegionMap, type RegionOutlines, traceBorders, traceRegionPath } from "canvas-ir";
import { type PaletteColor, type VectorizeResult, vectorize } from "@canvas-ir/vectorize";

export const PAINT_ID = "paint-by-numbers";
export const PAINT_AT = { x: 40, y: 2300 };
const W = 240;
const H = 160;
/** The previews' width and the template's largest size on the board. */
const PREVIEW = 240;
const TEMPLATE_W = 480;
const TEMPLATE_H = 360;
const TEMPLATE = { x: PAINT_AT.x + PREVIEW + 30, y: PAINT_AT.y + 40 };
/** A photo is scaled down to this many pixels on its longer side before vectorizing. */
const PHOTO_SIDE = 320;
const COUNTS = [6, 10, 16, 24];

const PALETTE: PaletteColor[] = [
  { id: "1", color: "#bfdbfe" },
  { id: "2", color: "#7dd3fc" },
  { id: "3", color: "#fde047" },
  { id: "4", color: "#f97316" },
  { id: "5", color: "#86efac" },
  { id: "6", color: "#16a34a" },
  { id: "7", color: "#14532d" },
  { id: "8", color: "#2563eb" },
  { id: "9", color: "#92400e" },
  { id: "10", color: "#dc2626" },
  { id: "11", color: "#f5f5f4" },
];

/** The painting: gradients and soft edges, so pixels fall between palette colors. */
const drawSource = (c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | RecordingContext): void => {
  const sky = c.createLinearGradient(0, 0, 0, 100);
  sky.addColorStop(0, "#60a5fa");
  sky.addColorStop(1, "#dbeafe");
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);
  const sun = c.createRadialGradient(186, 38, 4, 186, 38, 26);
  sun.addColorStop(0, "#fef08a");
  sun.addColorStop(0.6, "#facc15");
  sun.addColorStop(1, "rgba(251, 146, 60, 0)");
  c.fillStyle = sun;
  c.beginPath();
  c.arc(186, 38, 26, 0, Math.PI * 2);
  c.fill();
  const hill = (y: number, top: string, bottom: string, wave: number): void => {
    const g = c.createLinearGradient(0, y - 20, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, y);
    for (let x = 0; x <= W; x += 8) c.lineTo(x, y - Math.sin(x / 40 + wave) * 14);
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    c.fill();
  };
  hill(98, "#4ade80", "#22c55e", 0.5);
  hill(124, "#15803d", "#166534", 2.4);
  // A lake, a house and a tree.
  c.fillStyle = "#2563eb";
  c.beginPath();
  c.ellipse(70, 140, 46, 11, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f5f5f4";
  c.fillRect(136, 92, 38, 28);
  c.fillStyle = "#dc2626";
  c.beginPath();
  c.moveTo(131, 93);
  c.lineTo(155, 74);
  c.lineTo(179, 93);
  c.closePath();
  c.fill();
  c.fillStyle = "#92400e";
  c.fillRect(150, 104, 9, 16);
  c.fillStyle = "#7dd3fc";
  c.fillRect(140, 98, 7, 7);
  c.fillRect(163, 98, 7, 7);
  c.fillStyle = "#92400e";
  c.fillRect(205, 96, 6, 26);
  c.fillStyle = "#14532d";
  c.beginPath();
  c.arc(208, 88, 15, 0, Math.PI * 2);
  c.fill();
};

export interface PaintState {
  /** Region ids painted so far. */
  readonly painted: readonly number[];
  /** For a photo: how many colors to cluster it into. */
  readonly colors: number;
}

/** What to paint: the built-in painting, with its fixed palette, or a picture scaled down to vectorize. */
export interface PaintSource {
  readonly name: string;
  readonly canvas: OffscreenCanvas;
  /** A fixed palette; without one the colors are clustered from the picture. */
  readonly palette?: readonly PaletteColor[];
}

export interface PaintDemo {
  readonly result: VectorizeResult;
  readonly outlines: RegionOutlines;
  readonly minArea: number;
  /** Vectorizing (pixels to palette, regions and fills) and tracing the template's borders, in ms. */
  readonly ms: { vectorize: number; borders: number };
}

/** The built-in painting, rasterized. */
export const paintingSource = (): PaintSource => {
  const canvas = new OffscreenCanvas(W, H);
  drawSource(canvas.getContext("2d")!);
  return { name: "The painting", canvas, palette: PALETTE };
};

/** A picture, scaled down to at most PHOTO_SIDE pixels on its longer side. */
export const pictureSource = (name: string, image: CanvasImageSource & { width: number; height: number }): PaintSource => {
  const scale = Math.min(1, PHOTO_SIDE / Math.max(image.width, image.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const c = canvas.getContext("2d")!;
  c.imageSmoothingQuality = "high";
  // A slight blur first takes out grain that would otherwise speckle every region.
  c.filter = "blur(0.7px)";
  c.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { name, canvas };
};

/** Vectorizes a source as regions: the fixed palette as is, or `colors` k-means clusters, smoothed, with specks merged. */
export const preparePaint = (source: PaintSource, colors: number): PaintDemo => {
  const { width, height } = source.canvas;
  const pixels = source.canvas.getContext("2d")!.getImageData(0, 0, width, height);
  const minArea = source.palette ? 24 : Math.max(24, Math.round(width * height * 0.0008));
  const common = { layout: "regions", minArea, tolerance: 0.75, curves: true } as const;
  const t0 = performance.now();
  const result = vectorize(pixels, source.palette ? { ...common, palette: source.palette } : { ...common, quantize: "kmeans", maxColors: colors, smooth: 3 });
  const t1 = performance.now();
  const outlines = traceBorders(result.regions!, { tolerance: 0.75, curves: true });
  return { result, outlines, minArea, ms: { vectorize: t1 - t0, borders: performance.now() - t1 } };
};

/** Where to put each region's number: its pixel farthest from any other region (a chamfer distance), and how far that is. */
const labelSpots = (map: RegionMap): { x: number; y: number; d: number }[] => {
  const { width: w, height: h, labels } = map;
  const d = new Float32Array(w * h);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? -2 : labels[y * w + x]!);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = at(x, y);
      d[y * w + x] = at(x - 1, y) !== l || at(x + 1, y) !== l || at(x, y - 1) !== l || at(x, y + 1) !== l ? 1 : 1e9;
    }
  }
  const relax = (x: number, y: number, dx: number, dy: number, cost: number): void => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
    const i = y * w + x;
    const v = d[ny * w + nx]! + cost;
    if (v < d[i]!) d[i] = v;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const [dx, dy, k] of [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.4], [1, -1, 1.4]] as const) relax(x, y, dx, dy, k);
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) for (const [dx, dy, k] of [[1, 0, 1], [0, 1, 1], [1, 1, 1.4], [-1, 1, 1.4]] as const) relax(x, y, dx, dy, k);
  const spots = map.regions.map(() => ({ x: 0, y: 0, d: 0 }));
  for (let i = 0; i < w * h; i++) {
    const spot = spots[labels[i]!];
    if (spot && d[i]! > spot.d) Object.assign(spot, { x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5, d: d[i]! });
  }
  return spots;
};

/** The picture, its regions, the template and the palette, as one component: clicks paint regions, picked by the index map. */
export const paintComponent = (source: PaintSource): ComponentSpec<PaintState> => {
  const { width: w, height: h } = source.canvas;
  const S = Math.min(TEMPLATE_W / w, TEMPLATE_H / h);
  const P = PREVIEW / w;
  const legendY = TEMPLATE.y + h * S + 18;
  const prepared = new Map<number, { demo: PaintDemo; spots: { x: number; y: number; d: number }[] }>();
  const get = (colors: number) => {
    const key = source.palette ? 0 : colors;
    let entry = prepared.get(key);
    if (!entry) {
      const demo = preparePaint(source, colors);
      entry = { demo, spots: labelSpots(demo.result.regions!) };
      prepared.set(key, entry);
    }
    return entry;
  };
  const swatch = (k: number): { x: number; y: number } => ({ x: TEMPLATE.x + (k % 6) * 80, y: legendY + Math.floor(k / 6) * 30 });
  const chip = (i: number): { x: number; y: number } => ({ x: PAINT_AT.x + i * 44, y: PAINT_AT.y + 40 + 2 * h * P + 102 });
  const inside = (x: number, y: number, b: { x: number; y: number }, bw: number, bh: number): boolean => x >= b.x && x < b.x + bw && y >= b.y && y < b.y + bh;
  return {
    id: PAINT_ID,
    state: { painted: [], colors: 16 },
    meta: { source: "paint by numbers", role: "img", label: "Paint by numbers: click a region or a palette color" },
    cursor: "pointer",
    draw: (c, { painted, colors }) => {
      const { demo, spots } = get(colors);
      const { result, outlines } = demo;
      const map = result.regions!;
      const done = new Set(painted);
      const fills = (only: ReadonlySet<number> | null, scale: number): void => {
        for (const region of map.regions) {
          const paint = !only || only.has(region.id);
          c.fillStyle = paint ? result.colors[region.value]!.color : "#ffffff";
          c.beginPath();
          traceRegionPath(c, outlines, region.id);
          c.fill();
          // Anti-aliasing leaves a faint seam where two fills meet; a hairline of the region's own color closes it.
          if (paint) {
            c.strokeStyle = c.fillStyle;
            c.lineWidth = 1 / scale;
            c.stroke();
          }
        }
      };
      const used = result.colors.filter((k) => k.pixels > 0).length;
      // A fixed palette's own ids; clustered colors are numbered in order.
      const label = (k: number): string => (source.palette ? result.colors[k]!.id : String(k + 1));
      const left = PAINT_AT.y + 40 + 2 * h * P + 140;
      const right = legendY + Math.ceil(result.colors.length / 6) * 30 + 10;
      c.fillStyle = "#f8fafc";
      c.beginPath();
      c.roundRect(PAINT_AT.x - 16, PAINT_AT.y - 16, PREVIEW + 30 + TEMPLATE_W + 32, Math.max(left, right) - PAINT_AT.y + 16, 12);
      c.fill();
      c.font = "600 13px system-ui, sans-serif";
      c.fillStyle = "#475569";
      c.textBaseline = "top";
      c.fillText("Paint by numbers: click a region, or a color to fill all of its regions", PAINT_AT.x, PAINT_AT.y);
      c.font = "11px system-ui, sans-serif";
      c.fillStyle = "#64748b";
      c.fillText(`${source.name}, ${w}×${h}`, PAINT_AT.x, PAINT_AT.y + 24);
      c.fillText(source.palette ? `Vectorized to ${used} of ${result.colors.length} fixed colors` : `Vectorized to ${used} clustered colors`, PAINT_AT.x, PAINT_AT.y + 24 + h * P + 22);
      // The picture itself, then its regions as fills.
      c.drawImage(source.canvas, PAINT_AT.x, PAINT_AT.y + 40, w * P, h * P);
      c.save();
      c.translate(PAINT_AT.x, PAINT_AT.y + 40 + h * P + 22);
      c.scale(P, P);
      fills(null, P);
      c.restore();
      c.fillStyle = "#64748b";
      const y = PAINT_AT.y + 40 + 2 * h * P + 30;
      c.fillText(`${map.regions.length} regions, ${outlines.borders.length} shared borders`, PAINT_AT.x, y);
      c.fillText(`Areas under ${demo.minArea} px merged; ${demo.ms.vectorize.toFixed(0)} ms`, PAINT_AT.x, y + 16);
      c.fillText(`${painted.length} of ${map.regions.length} painted`, PAINT_AT.x, y + 32);
      if (!source.palette) {
        c.fillText("Colors:", PAINT_AT.x, y + 54);
        COUNTS.forEach((n, i) => {
          const b = chip(i);
          c.fillStyle = n === colors ? "#475569" : "#e2e8f0";
          c.beginPath();
          c.roundRect(b.x, b.y, 38, 24, 12);
          c.fill();
          c.fillStyle = n === colors ? "#ffffff" : "#334155";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(String(n), b.x + 19, b.y + 12);
          c.textAlign = "start";
          c.textBaseline = "top";
        });
      }
      // The template: regions from the shared borders, outlined, numbered.
      c.save();
      c.translate(TEMPLATE.x, TEMPLATE.y);
      c.scale(S, S);
      fills(done, S);
      // Borders still to paint on at least one side; between two painted regions the line goes.
      c.strokeStyle = "#94a3b8";
      c.lineWidth = 1 / S;
      c.lineJoin = "round";
      c.beginPath();
      for (const border of outlines.borders) {
        const open = (r: number): boolean => r >= 0 && !done.has(r);
        if (!open(border.left) && !open(border.right)) continue;
        if (border.pieces && border.pieces.length > 0) {
          c.moveTo(border.pieces[0]!.from.x, border.pieces[0]!.from.y);
          for (const p of border.pieces) c.bezierCurveTo(p.c1.x, p.c1.y, p.c2.x, p.c2.y, p.to.x, p.to.y);
        } else {
          border.points.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
          if (border.closed) c.closePath();
        }
      }
      c.stroke();
      c.fillStyle = "#475569";
      c.textAlign = "center";
      c.textBaseline = "middle";
      for (const region of map.regions) {
        const spot = spots[region.id]!;
        // Numbers a few screen pixels high, as big as the region allows.
        const size = Math.min(14, spot.d * S * 0.9) / S;
        if (done.has(region.id) || size * S < 5) continue;
        c.font = `${size}px system-ui, sans-serif`;
        c.fillText(label(region.value), spot.x, spot.y);
      }
      c.restore();
      c.textAlign = "start";
      // The palette: ids in order, with how many pixels took each.
      result.colors.forEach((color, k) => {
        const s = swatch(k);
        c.fillStyle = color.color;
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 1;
        c.beginPath();
        c.roundRect(s.x, s.y, 24, 24, 4);
        c.fill();
        c.stroke();
        c.fillStyle = color.pixels > 0 ? "#334155" : "#94a3b8";
        c.font = "600 12px system-ui, sans-serif";
        c.textBaseline = "middle";
        c.fillText(label(k), s.x + 30, s.y + 8);
        c.font = "10px system-ui, sans-serif";
        c.fillText(color.pixels > 0 ? `${color.pixels} px` : "unused", s.x + 30, s.y + 19);
      });
    },
    on: {
      dragstart: (e) => e.stopPropagation(),
      click: (e, component) => {
        e.stopPropagation();
        const { painted, colors } = component.state;
        const { x, y } = e.point;
        if (!source.palette) {
          const i = COUNTS.findIndex((_, i) => inside(x, y, chip(i), 38, 24));
          if (i >= 0) {
            component.setState({ colors: COUNTS[i]!, painted: [] });
            return;
          }
        }
        const map = get(colors).demo.result.regions!;
        const px = Math.floor((x - TEMPLATE.x) / S);
        const py = Math.floor((y - TEMPLATE.y) / S);
        const region = px < 0 || py < 0 || px >= w || py >= h ? -1 : map.labels[py * w + px]!;
        if (region >= 0) {
          component.setState({ painted: painted.includes(region) ? painted.filter((r) => r !== region) : [...painted, region] });
          return;
        }
        const k = get(colors).demo.result.colors.findIndex((_, k) => inside(x, y, swatch(k), 72, 24));
        if (k < 0) return;
        const all = map.regions.filter((r) => r.value === k).map((r) => r.id);
        const filled = all.every((r) => painted.includes(r));
        component.setState({ painted: filled ? painted.filter((r) => !all.includes(r)) : [...new Set([...painted, ...all])] });
      },
    },
  };
};
