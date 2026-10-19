// Paint by numbers: a small painting is rasterized, matched to a fixed
// palette by @canvas-ir/vectorize, and split into 4-connected regions whose
// borders are traced once and shared by both sides. The template is drawn
// from those borders; clicking a region paints it, read off the index map.
import { type ComponentSpec, RecordingContext, type RegionMap, type RegionOutlines, traceBorders, traceRegionPath } from "canvas-ir";
import { type PaletteColor, type VectorizeResult, vectorize } from "@canvas-ir/vectorize";

export const PAINT_ID = "paint-by-numbers";
export const PAINT_AT = { x: 40, y: 2300 };
const W = 240;
const H = 160;
/** The template's scale on the board. */
const S = 2;
const TEMPLATE = { x: PAINT_AT.x + W + 30, y: PAINT_AT.y + 40 };
const LEGEND_Y = TEMPLATE.y + H * S + 18;

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
}

export interface PaintDemo {
  readonly result: VectorizeResult;
  readonly outlines: RegionOutlines;
  /** Drawing ms: vectorizing (rasterized painting to regions and fills), and tracing the template's borders. */
  readonly ms: { vectorize: number; borders: number };
}

/** Rasterizes the painting and vectorizes it to the fixed palette, as regions. */
export const preparePaint = (): PaintDemo => {
  const canvas = new OffscreenCanvas(W, H);
  const c = canvas.getContext("2d")!;
  drawSource(c);
  const t0 = performance.now();
  const result = vectorize(c.getImageData(0, 0, W, H), { palette: PALETTE, layout: "regions", minArea: 24, tolerance: 0.75, curves: true });
  const t1 = performance.now();
  const outlines = traceBorders(result.regions!, { tolerance: 0.75, curves: true });
  return { result, outlines, ms: { vectorize: t1 - t0, borders: performance.now() - t1 } };
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

/** The painting, the template and the palette, as one component: clicks paint regions, picked by the index map. */
export const paintComponent = (demo: PaintDemo): ComponentSpec<PaintState> => {
  const { result, outlines } = demo;
  const map = result.regions!;
  const spots = labelSpots(map);
  const swatch = (k: number): { x: number; y: number } => ({ x: TEMPLATE.x + (k % 6) * 80, y: LEGEND_Y + Math.floor(k / 6) * 30 });
  const regionAt = (x: number, y: number): number => {
    const px = Math.floor((x - TEMPLATE.x) / S);
    const py = Math.floor((y - TEMPLATE.y) / S);
    return px < 0 || py < 0 || px >= W || py >= H ? -1 : map.labels[py * W + px]!;
  };
  const colorAt = (x: number, y: number): number => {
    for (let k = 0; k < result.colors.length; k++) {
      const s = swatch(k);
      if (x >= s.x && x < s.x + 72 && y >= s.y && y < s.y + 24) return k;
    }
    return -1;
  };
  const fills = (c: RecordingContext, painted: ReadonlySet<number> | null): void => {
    for (const region of map.regions) {
      c.fillStyle = painted && !painted.has(region.id) ? "#ffffff" : result.colors[region.value]!.color;
      c.beginPath();
      traceRegionPath(c, outlines, region.id);
      c.fill();
    }
  };
  const used = result.colors.filter((c) => c.pixels > 0).length;
  return {
    id: PAINT_ID,
    state: { painted: [] },
    meta: { source: "paint by numbers", role: "img", label: "Paint by numbers: click a region or a palette color" },
    cursor: "pointer",
    draw: (c, { painted }) => {
      const done = new Set(painted);
      c.fillStyle = "#f8fafc";
      c.beginPath();
      c.roundRect(PAINT_AT.x - 16, PAINT_AT.y - 16, W + 30 + W * S + 32, LEGEND_Y + 70 - PAINT_AT.y, 12);
      c.fill();
      c.font = "600 13px system-ui, sans-serif";
      c.fillStyle = "#475569";
      c.textBaseline = "top";
      c.fillText("Paint by numbers: click a region, or a color to fill all of its regions", PAINT_AT.x, PAINT_AT.y);
      c.font = "11px system-ui, sans-serif";
      c.fillStyle = "#64748b";
      c.fillText("The painting", PAINT_AT.x, PAINT_AT.y + 24);
      c.fillText(`Vectorized to ${used} of ${result.colors.length} fixed colors`, PAINT_AT.x, PAINT_AT.y + 24 + H + 22);
      // The painting itself, then its regions as fills.
      c.save();
      c.translate(PAINT_AT.x, PAINT_AT.y + 40);
      drawSource(c);
      c.restore();
      c.save();
      c.translate(PAINT_AT.x, PAINT_AT.y + 40 + H + 22);
      fills(c, null);
      c.restore();
      c.fillStyle = "#64748b";
      const y = PAINT_AT.y + 40 + 2 * H + 30;
      c.fillText(`${map.regions.length} regions, ${outlines.borders.length} shared borders`, PAINT_AT.x, y);
      c.fillText(`Areas under 24 px merged; ${demo.ms.vectorize.toFixed(0)} ms`, PAINT_AT.x, y + 16);
      c.fillText(`${painted.length} of ${map.regions.length} painted`, PAINT_AT.x, y + 32);
      // The template: regions from the shared borders, outlined, numbered.
      c.save();
      c.translate(TEMPLATE.x, TEMPLATE.y);
      c.scale(S, S);
      fills(c, done);
      c.strokeStyle = "#94a3b8";
      c.lineWidth = 0.5;
      c.lineJoin = "round";
      for (const region of map.regions) {
        c.beginPath();
        traceRegionPath(c, outlines, region.id);
        c.stroke();
      }
      c.fillStyle = "#475569";
      c.textAlign = "center";
      c.textBaseline = "middle";
      for (const region of map.regions) {
        const spot = spots[region.id]!;
        if (done.has(region.id) || spot.d < 2) continue;
        c.font = `${Math.min(7, Math.max(3.5, spot.d * 0.9))}px system-ui, sans-serif`;
        c.fillText(result.colors[region.value]!.id, spot.x, spot.y);
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
        c.fillText(color.id, s.x + 30, s.y + 8);
        c.font = "10px system-ui, sans-serif";
        c.fillText(color.pixels > 0 ? `${color.pixels} px` : "unused", s.x + 30, s.y + 19);
      });
    },
    on: {
      dragstart: (e) => e.stopPropagation(),
      click: (e, component) => {
        e.stopPropagation();
        const { painted } = component.state;
        const region = regionAt(e.point.x, e.point.y);
        if (region >= 0) {
          component.setState({ painted: painted.includes(region) ? painted.filter((r) => r !== region) : [...painted, region] });
          return;
        }
        const k = colorAt(e.point.x, e.point.y);
        if (k < 0) return;
        const all = map.regions.filter((r) => r.value === k).map((r) => r.id);
        const filled = all.every((r) => painted.includes(r));
        component.setState({ painted: filled ? painted.filter((r) => !all.includes(r)) : [...new Set([...painted, ...all])] });
      },
    },
  };
};
