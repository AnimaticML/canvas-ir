// Charts drawn by unchanged chart libraries onto the recorder: D3's shape
// generators take the recorder as their context, and Chart.js draws into a
// recorder handed to it as a canvas. Hovering a bar or point shows its datum.
import {
  BarController,
  BarElement,
  BasicPlatform,
  CategoryScale,
  Chart,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
} from "chart.js";
import { scaleBand, scaleLinear } from "d3-scale";
import { arc, area, curveMonotoneX, line, pie } from "d3-shape";
import { type JsonValue, type Point, RecordingContext, RecordingPath2D, type Scene, applyToPoint, invert, replayDocument } from "canvas-ir";
import type { Sample } from "./samples";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Legend, Title);

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const visits = [42, 51, 48, 63, 72, 69, 81, 77, 90, 86, 98, 104];
const signups = [8, 11, 9, 14, 18, 15, 21, 19, 24, 22, 27, 31];

/** D3 scales and shape generators, drawing straight onto the recorder. Each point and slice is a group carrying its datum. */
export const d3Chart: Sample = {
  name: "D3 chart",
  draw: (ctx) => {
    const at = { x: 40, y: 720 };
    const width = 380;
    const height = 200;
    ctx.beginGroup({ meta: { source: "D3 chart", role: "figure", label: "Visits by month, and signups by quarter" } });
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.roundRect(0, 0, width + 200, height + 60, 8);
    ctx.fill();
    ctx.stroke();
    ctx.translate(40, 20);
    const x = scaleBand<string>().domain(months).range([0, width]).padding(0.2);
    const y = scaleLinear().domain([0, 110]).nice().range([height, 0]);
    // Axes: tick labels and grid lines from the scales.
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of y.ticks(5)) {
      ctx.beginPath();
      ctx.moveTo(0, y(t));
      ctx.lineTo(width, y(t));
      ctx.stroke();
      ctx.fillText(String(t), -6, y(t));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const m of months) ctx.fillText(m, x(m)! + x.bandwidth() / 2, height + 6);
    const cx = (i: number): number => x(months[i]!)! + x.bandwidth() / 2;
    // The area and line through the points, from d3-shape with the recorder as their context.
    ctx.beginPath();
    area<number>()
      .x((_, i) => cx(i))
      .y0(height)
      .y1((d) => y(d))
      .curve(curveMonotoneX)
      .context(ctx as unknown as CanvasRenderingContext2D)(visits);
    ctx.fillStyle = "rgba(99, 102, 241, 0.15)";
    ctx.fill();
    ctx.beginPath();
    line<number>()
      .x((_, i) => cx(i))
      .y((d) => y(d))
      .curve(curveMonotoneX)
      .context(ctx as unknown as CanvasRenderingContext2D)(visits);
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    visits.forEach((v, i) => {
      ctx.beginGroup({ meta: { datum: { month: months[i]!, visits: v }, role: "img", label: `${months[i]}: ${v} visits` } });
      ctx.beginPath();
      ctx.arc(cx(i), y(v), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
      ctx.endGroup();
    });
    // A donut of signups by quarter, from d3.pie and d3.arc.
    ctx.translate(width + 90, height / 2);
    const quarters = [0, 1, 2, 3].map((q) => ({ quarter: `Q${q + 1}`, signups: signups.slice(q * 3, q * 3 + 3).reduce((a, b) => a + b, 0) }));
    const slices = pie<{ quarter: string; signups: number }>().value((d) => d.signups).padAngle(0.03)(quarters);
    const ring = arc<(typeof slices)[number]>().innerRadius(36).outerRadius(64).cornerRadius(3).context(ctx as unknown as CanvasRenderingContext2D);
    const colors = ["#a5b4fc", "#818cf8", "#6366f1", "#4338ca"];
    slices.forEach((s, i) => {
      ctx.beginGroup({ meta: { datum: s.data, role: "img", label: `${s.data.quarter}: ${s.data.signups} signups` } });
      ctx.beginPath();
      ring(s);
      ctx.fillStyle = colors[i]!;
      ctx.fill();
      ctx.endGroup();
    });
    ctx.fillStyle = "#374151";
    ctx.textBaseline = "middle";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText("Signups", 0, 0);
    ctx.restore();
    ctx.endGroup();
  },
};

/** Chart.js instances on the board, by the id of the group holding their drawing, with where they were drawn. */
export const chartInstances = new Map<string, { chart: Chart; at: Point }>();

/**
 * Chart.js, unchanged, drawing into a recorder it takes for a canvas: its
 * platform asks the "canvas" for a context and gets the recorder. The drawing
 * is replayed onto the board at its place, without the clear Chart.js starts
 * every frame with, and the live chart stays around to answer hovers.
 */
export const chartJs: Sample = {
  name: "Chart.js chart",
  draw: (ctx) => {
    const at = { x: 660, y: 720 };
    const width = 420;
    const height = 260;
    const recorder = new RecordingContext({ width, height });
    const canvas = { getContext: () => recorder, width, height };
    // Chart.js caches line paths in Path2D objects; while it draws, those are the recorder's own.
    const nativePath2D = globalThis.Path2D;
    globalThis.Path2D = RecordingPath2D as unknown as typeof Path2D;
    let chart: Chart;
    try {
      chart = new Chart(canvas as unknown as HTMLCanvasElement, {
      platform: BasicPlatform,
      type: "bar",
      data: {
        labels: months,
        datasets: [
          { type: "bar", label: "Visits", data: visits, backgroundColor: "#c7d2fe", borderColor: "#6366f1", borderWidth: 1, borderRadius: 3 },
          { type: "line", label: "Signups ×3", data: signups.map((s) => s * 3), borderColor: "#f97316", backgroundColor: "#f97316", tension: 0.35, pointRadius: 3 },
        ],
      },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: 1,
          plugins: { title: { display: true, text: "Chart.js, recorded" }, legend: { position: "bottom" } },
        },
      });
    } finally {
      globalThis.Path2D = nativePath2D;
    }
    const document = recorder.getDocument();
    const id = ctx.beginGroup({
      meta: { source: "Chart.js chart", chart: true, role: "img", label: `Bar chart of visits by month, ${visits.join(", ")}, with signups as a line` },
    });
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.roundRect(at.x, at.y, width, height, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    replayDocument(ctx, { ...document, ops: document.ops.filter((op) => op.kind !== "clear") }, { view: { a: 1, b: 0, c: 0, d: 1, e: at.x, f: at.y } });
    ctx.endGroup();
    chartInstances.set(id, { chart, at });
  },
};

const show = (datum: JsonValue): string =>
  typeof datum === "object" && datum !== null && !Array.isArray(datum)
    ? Object.entries(datum)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n")
    : String(datum);

/** What the pointer is over in a chart, from the groups around the op it hits (innermost first), or null. */
export const datumAt = (scene: Scene, path: readonly string[], world: Point): string | null => {
  for (const id of path) {
    const meta = scene.getGroup(id)?.meta;
    if (meta?.["datum"] !== undefined) return show(meta["datum"]);
    const live = chartInstances.get(id);
    if (live) {
      // Chart.js finds the element under a point in its own pixels; the group's first op, its frame, says where those are now.
      const frame = scene.get(scene.groupOps(id)[0] ?? "");
      const back = frame ? invert(frame.transform) : null;
      const p = back ? applyToPoint(back, world.x, world.y) : world;
      const position = { native: null, x: p.x - live.at.x, y: p.y - live.at.y };
      const [hit] = live.chart.getElementsAtEventForMode(position as unknown as Event, "nearest", { intersect: true }, false);
      if (!hit) return null;
      const dataset = live.chart.data.datasets[hit.datasetIndex]!;
      return `${String(live.chart.data.labels?.[hit.index])}\n${dataset.label}: ${String(dataset.data[hit.index])}`;
    }
  }
  return null;
};
