import { drawTextLayout, layoutText } from "@canvas-ir/text";
import type { RecordingContext } from "canvas-ir";

/** Something to put on the board: SVG markup drawn through canvg, or a function drawing on the recorder. */
export type Sample =
  | { readonly name: string; readonly svg: string; readonly at: { x: number; y: number } }
  | { readonly name: string; readonly draw: (ctx: RecordingContext) => void };

const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#059669"/></linearGradient></defs>
  <circle cx="60" cy="60" r="52" fill="url(#g)"/>
  <path d="M36 62 L52 78 L86 42" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150" viewBox="0 0 220 150">
  <rect x="0.5" y="0.5" width="219" height="149" rx="8" fill="#fff" stroke="#d4d4d8"/>
  <g fill="#6366f1"><rect x="24" y="80" width="26" height="50"/><rect x="62" y="50" width="26" height="80"/><rect x="100" y="66" width="26" height="64"/><rect x="138" y="30" width="26" height="100"/><rect x="176" y="96" width="26" height="34"/></g>
  <path d="M20 130 H204" stroke="#71717a" stroke-width="2"/>
  <text x="20" y="22" font-family="sans-serif" font-size="13" fill="#27272a">Weekly orders</text>
</svg>`;

const star = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="110" viewBox="0 0 110 110">
  <polygon points="55,6 68,40 104,42 76,64 86,100 55,80 24,100 34,64 6,42 42,40" fill="#fbbf24" stroke="#b45309" stroke-width="4" stroke-linejoin="round"/>
</svg>`;

const note: Sample = {
  name: "Text block",
  draw: (ctx) => {
    ctx.save();
    ctx.fillStyle = "#fef3c7";
    ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.beginGroup({ meta: { source: "sticky note" } });
    ctx.beginPath();
    ctx.roundRect(330, 40, 230, 250, 10);
    ctx.fill();
    ctx.restore();
    const layout = layoutText(
      {
        blocks: [
          { type: "heading", level: 3, content: ["Rich text, recorded"] },
          {
            type: "paragraph",
            content: ["Laid out by ", { text: "@canvas-ir/text", code: true }, " and drawn as ", { text: "fillText", bold: true }, " calls. Each line is a group you can hit."],
          },
          { type: "list", items: [[{ type: "paragraph", content: ["Wraps like the DOM"] }], [{ type: "paragraph", content: ["Works in any shape"] }]] },
        ],
      },
      { container: { x: 346, y: 52, width: 198, height: 230 }, theme: { fontSize: 14 } },
    );
    drawTextLayout(ctx, layout, { meta: { source: "sticky note text" } });
    ctx.endGroup();
  },
};

const shapes: Sample = {
  name: "Canvas shapes",
  draw: (ctx) => {
    ctx.beginGroup({ meta: { source: "canvas calls" } });
    ctx.save();
    ctx.translate(120, 330);
    ctx.rotate(-0.2);
    const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 60);
    g.addColorStop(0, "#fda4af");
    g.addColorStop(1, "#e11d48");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 70, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 6;
    ctx.setLineDash([14, 8]);
    ctx.beginPath();
    ctx.moveTo(240, 300);
    ctx.bezierCurveTo(300, 240, 360, 400, 440, 320);
    ctx.stroke();
    ctx.endGroup();
  },
};

export const samples: readonly Sample[] = [
  { name: "Badge", svg: badge, at: { x: 40, y: 40 } },
  { name: "Chart", svg: chart, at: { x: 600, y: 60 } },
  { name: "Star", svg: star, at: { x: 200, y: 110 } },
  note,
  shapes,
];
