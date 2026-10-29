// The playground's features as icons scattered over the board: each is a tile
// with a small drawing of what it adds, and pressing it adds that next to it.
// They are components on the cards' layer, so they zoom with the board but
// are never part of the drawing.
import type { ComponentSpec, RecordingContext } from "canvas-ir";
import { FONT, type Palette } from "./kit";

/** A tile's side in world units; what it adds goes this far right of its left edge, and a gap more. */
export const ICON = 150;
export const ICON_REACH = ICON + 50;

export type Glyph =
  | "pelican"
  | "physics"
  | "graph"
  | "paint"
  | "picture"
  | "morph"
  | "badge"
  | "chart"
  | "star"
  | "text"
  | "wrap"
  | "circle"
  | "controls"
  | "shapes"
  | "d3"
  | "chartjs"
  | "embed"
  | "many"
  | "table"
  | "points"
  | "galaxy"
  | "map"
  | "book";

export interface Feature {
  readonly id: string;
  readonly name: string;
  readonly glyph: Glyph;
  /** The tile's top left corner on the board. */
  readonly x: number;
  readonly y: number;
  /** A slight turn, in degrees, so the tiles look scattered rather than laid out. */
  readonly tilt: number;
  readonly onClick: () => void;
}

const TINTS: Record<Glyph, string> = {
  pelican: "#fde68a",
  physics: "#fecaca",
  graph: "#c7d2fe",
  paint: "#bbf7d0",
  picture: "#a7f3d0",
  morph: "#ddd6fe",
  badge: "#bbf7d0",
  chart: "#bfdbfe",
  star: "#fef08a",
  text: "#fed7aa",
  wrap: "#e9d5ff",
  circle: "#bae6fd",
  controls: "#e5e7eb",
  shapes: "#fbcfe8",
  d3: "#fde68a",
  chartjs: "#fecdd3",
  embed: "#c7d2fe",
  many: "#d9f99d",
  table: "#cffafe",
  points: "#dbeafe",
  galaxy: "#c7d2fe",
  map: "#bae6fd",
  book: "#fed7aa",
};

const INK = "#1f2937";

export const featureIcon = (f: Feature, colors: () => Palette): ComponentSpec<null> => {
  const r = (f.tilt * Math.PI) / 180;
  const c0 = Math.cos(r);
  const s0 = Math.sin(r);
  // Turned about the tile's center.
  const cx = f.x + ICON / 2;
  const cy = f.y + ICON / 2;
  return {
    id: `feature-${f.id}`,
    state: null,
    transform: { a: c0, b: s0, c: -s0, d: c0, e: cx - c0 * cx + s0 * cy, f: cy - s0 * cx - c0 * cy },
    meta: { role: "button", label: `Add ${f.name}` },
    cursor: "pointer",
    draw: (c, _, ui) => {
      const k = colors();
      const lift = ui.pressed ? 0 : ui.hovered ? 4 : 0;
      c.translate(f.x, f.y - lift);
      c.shadowColor = "rgba(15, 23, 42, 0.18)";
      c.shadowBlur = ui.hovered ? 26 : 14;
      c.shadowOffsetY = ui.hovered ? 8 : 4;
      c.beginPath();
      c.roundRect(0, 0, ICON, ICON, 28);
      c.fillStyle = TINTS[f.glyph];
      c.fill();
      c.shadowColor = "transparent";
      if (ui.hovered || ui.focused) {
        c.lineWidth = 3;
        c.strokeStyle = k.accent;
        c.stroke();
      }
      c.save();
      c.translate(25, 22);
      glyph(c, f.glyph);
      c.restore();
      c.font = `600 22px ${FONT}`;
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillStyle = INK;
      // The board stays light in dark mode, so the label keeps dark ink.
      c.fillText(f.name, ICON / 2, ICON + 12);
      c.textAlign = "start";
    },
    on: {
      click: (e) => {
        e.stopPropagation();
        f.onClick();
      },
      keydown: (e) => {
        const key = (e.input as { key: string }).key;
        if (key === "Enter" || key === " ") f.onClick();
      },
    },
  };
};

/** Draws a feature's picture in a 100 by 100 box. */
const glyph = (c: RecordingContext, g: Glyph): void => {
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = INK;
  c.lineWidth = 5;
  const dot = (x: number, y: number, r: number, fill: string): void => {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  };
  const line = (...p: number[]): void => {
    c.beginPath();
    c.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i]!, p[i + 1]!);
    c.stroke();
  };
  const starPath = (x: number, y: number, outer: number, inner: number): void => {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? outer : inner;
      c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
  };
  switch (g) {
    case "pelican": {
      // A bicycle.
      for (const x of [22, 78]) {
        c.beginPath();
        c.arc(x, 68, 20, 0, Math.PI * 2);
        c.stroke();
      }
      line(22, 68, 44, 40, 70, 40, 78, 68);
      line(44, 40, 52, 68, 70, 40);
      line(38, 32, 50, 32);
      line(70, 40, 66, 26, 76, 24);
      dot(52, 68, 5, INK);
      break;
    }
    case "physics": {
      c.lineWidth = 4;
      line(4, 92, 96, 92);
      c.fillStyle = "#b45309";
      c.fillRect(12, 56, 34, 34);
      c.strokeRect(12, 56, 34, 34);
      dot(70, 72, 18, "#2563eb");
      starPath(58, 24, 18, 8);
      c.fillStyle = "#f59e0b";
      c.fill();
      c.stroke();
      break;
    }
    case "graph": {
      const nodes = [
        [20, 24],
        [74, 18],
        [50, 52],
        [16, 80],
        [84, 74],
        [50, 90],
      ] as const;
      c.lineWidth = 3;
      for (const [a, b] of [
        [0, 2],
        [1, 2],
        [2, 3],
        [2, 4],
        [4, 5],
        [3, 5],
        [0, 1],
      ] as const)
        line(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]);
      nodes.forEach(([x, y], i) => dot(x, y, i === 2 ? 12 : 8, ["#4f46e5", "#db2777", "#0891b2"][i % 3]!));
      break;
    }
    case "paint":
    case "picture": {
      // A palette, or a framed picture.
      if (g === "picture") {
        c.lineWidth = 4;
        c.strokeRect(6, 14, 88, 72);
        c.fillStyle = "#fde68a";
        dot(32, 36, 9, "#f59e0b");
        c.beginPath();
        c.moveTo(8, 84);
        c.lineTo(38, 52);
        c.lineTo(58, 70);
        c.lineTo(72, 58);
        c.lineTo(92, 84);
        c.closePath();
        c.fillStyle = "#16a34a";
        c.fill();
        break;
      }
      c.beginPath();
      c.ellipse(50, 52, 46, 38, 0, 0, Math.PI * 2);
      c.fillStyle = "#fffbeb";
      c.fill();
      c.stroke();
      dot(66, 70, 9, INK);
      for (const [x, y, color] of [
        [28, 40, "#dc2626"],
        [48, 26, "#f59e0b"],
        [72, 32, "#16a34a"],
        [28, 66, "#2563eb"],
      ] as const)
        dot(x, y, 9, color);
      break;
    }
    case "morph": {
      dot(32, 50, 22, "#f59e0b");
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        c.lineWidth = 4;
        c.strokeStyle = "#f59e0b";
        line(32 + Math.cos(a) * 28, 50 + Math.sin(a) * 28, 32 + Math.cos(a) * 36, 50 + Math.sin(a) * 36);
      }
      c.beginPath();
      c.arc(74, 50, 22, 0, Math.PI * 2);
      c.arc(84, 42, 20, 0, Math.PI * 2, true);
      c.fillStyle = "#4338ca";
      c.fill("evenodd");
      break;
    }
    case "badge": {
      dot(50, 50, 44, "#16a34a");
      c.strokeStyle = "#ffffff";
      c.lineWidth = 9;
      line(30, 52, 44, 66, 72, 36);
      break;
    }
    case "chart": {
      c.fillStyle = "#4f46e5";
      [40, 70, 52, 88, 30].forEach((h, i) => c.fillRect(8 + i * 18, 92 - h, 13, h));
      c.lineWidth = 3;
      line(4, 94, 96, 94);
      break;
    }
    case "star": {
      starPath(50, 52, 46, 20);
      c.fillStyle = "#facc15";
      c.fill();
      c.strokeStyle = "#b45309";
      c.stroke();
      break;
    }
    case "text": {
      c.lineWidth = 6;
      line(8, 14, 70, 14);
      c.lineWidth = 4;
      [34, 50, 66, 82].forEach((y, i) => line(8, y, i === 3 ? 60 : 92, y));
      break;
    }
    case "wrap": {
      c.beginPath();
      c.ellipse(52, 52, 20, 26, 0.4, 0, Math.PI * 2);
      c.fillStyle = "#a855f7";
      c.fill();
      c.lineWidth = 4;
      for (let i = 0; i < 6; i++) {
        const y = 10 + i * 16;
        const gap = y > 22 && y < 82;
        if (gap) {
          line(4, y, 26, y);
          line(78, y, 96, y);
        } else line(4, y, 96, y);
      }
      break;
    }
    case "circle": {
      dot(50, 50, 46, "#ffffff");
      c.lineWidth = 3;
      c.beginPath();
      c.arc(50, 50, 46, 0, Math.PI * 2);
      c.stroke();
      c.lineWidth = 4;
      for (const [y, w] of [
        [24, 40],
        [40, 66],
        [56, 70],
        [72, 50],
      ] as const)
        line(50 - w / 2, y, 50 + w / 2, y);
      break;
    }
    case "controls": {
      c.lineWidth = 6;
      c.strokeStyle = "#9ca3af";
      line(10, 30, 90, 30);
      c.strokeStyle = "#2563eb";
      line(10, 30, 56, 30);
      dot(56, 30, 10, "#ffffff");
      c.lineWidth = 3;
      c.beginPath();
      c.arc(56, 30, 10, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.roundRect(14, 58, 72, 30, 8);
      c.fillStyle = "#2563eb";
      c.fill();
      break;
    }
    case "shapes": {
      c.fillStyle = "#ec4899";
      c.fillRect(6, 50, 40, 40);
      dot(72, 30, 22, "#06b6d4");
      c.beginPath();
      c.moveTo(72, 56);
      c.lineTo(96, 94);
      c.lineTo(48, 94);
      c.closePath();
      c.fillStyle = "#f59e0b";
      c.fill();
      break;
    }
    case "d3": {
      c.lineWidth = 3;
      line(6, 4, 6, 94, 96, 94);
      c.strokeStyle = "#ea580c";
      c.lineWidth = 5;
      line(10, 80, 30, 56, 48, 66, 68, 30, 92, 18);
      for (const [x, y] of [
        [30, 56],
        [48, 66],
        [68, 30],
      ] as const)
        dot(x, y, 5, "#ea580c");
      break;
    }
    case "chartjs": {
      const slices = [0.4, 0.25, 0.2, 0.15];
      const fills = ["#f43f5e", "#3b82f6", "#facc15", "#14b8a6"];
      let a = -Math.PI / 2;
      slices.forEach((s, i) => {
        c.beginPath();
        c.moveTo(50, 50);
        c.arc(50, 50, 46, a, a + s * Math.PI * 2);
        c.closePath();
        c.fillStyle = fills[i]!;
        c.fill();
        a += s * Math.PI * 2;
      });
      dot(50, 50, 20, TINTS.chartjs);
      break;
    }
    case "embed": {
      // A cube.
      c.lineWidth = 4;
      c.fillStyle = "#818cf8";
      c.beginPath();
      c.moveTo(50, 8);
      c.lineTo(90, 28);
      c.lineTo(50, 48);
      c.lineTo(10, 28);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = "#4f46e5";
      c.beginPath();
      c.moveTo(10, 28);
      c.lineTo(50, 48);
      c.lineTo(50, 94);
      c.lineTo(10, 74);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = "#3730a3";
      c.beginPath();
      c.moveTo(90, 28);
      c.lineTo(50, 48);
      c.lineTo(50, 94);
      c.lineTo(90, 74);
      c.closePath();
      c.fill();
      c.stroke();
      break;
    }
    case "points": {
      // A dense band of readings.
      c.beginPath();
      for (let x = 0; x <= 100; x += 2) c.lineTo(x, 50 - 26 * Math.sin(x / 16) - 8 * Math.sin(x / 3.1) - 10);
      for (let x = 100; x >= 0; x -= 2) c.lineTo(x, 50 - 26 * Math.sin(x / 16) - 8 * Math.sin(x / 3.1) + 14);
      c.closePath();
      c.fillStyle = "#2563eb";
      c.fill();
      for (let x = 6; x < 100; x += 11) {
        c.beginPath();
        c.arc(x, 84 - 6 * Math.sin(x / 9), 3.5, 0, Math.PI * 2);
        c.fillStyle = "#1d4ed8";
        c.fill();
      }
      break;
    }
    case "galaxy": {
      // A spiral of stars on the night sky, with a ringed planet in front.
      c.fillStyle = "#0b1020";
      c.beginPath();
      c.arc(50, 50, 46, 0, Math.PI * 2);
      c.fill();
      for (let arm = 0; arm < 2; arm++) {
        for (let i = 0; i < 26; i++) {
          const t = i / 25;
          const a = arm * Math.PI + t * 4.2;
          const rr = 4 + t * 36;
          dot(50 + Math.cos(a) * rr, 50 + Math.sin(a) * rr * 0.62, 2.6 - t * 1.6, i % 5 === 0 ? "#fde68a" : "#c7d2fe");
        }
      }
      dot(50, 50, 6, "#fff7d6");
      dot(76, 74, 9, "#f59e0b");
      c.strokeStyle = "#fde68a";
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(76, 74, 15, 4, -0.3, 0, Math.PI * 2);
      c.stroke();
      break;
    }
    case "map": {
      // A folded map: sea, two shores, a road and a pin.
      c.fillStyle = "#a9d3ea";
      c.fillRect(6, 12, 88, 76);
      c.fillStyle = "#f3e3c3";
      c.beginPath();
      c.moveTo(6, 12);
      c.lineTo(52, 12);
      c.bezierCurveTo(40, 34, 58, 50, 36, 88);
      c.lineTo(6, 88);
      c.closePath();
      c.fill();
      c.fillStyle = "#dcebc9";
      c.beginPath();
      c.moveTo(94, 40);
      c.bezierCurveTo(78, 46, 70, 66, 80, 88);
      c.lineTo(94, 88);
      c.closePath();
      c.fill();
      c.strokeStyle = "#d97706";
      c.lineWidth = 3;
      line(10, 30, 26, 46, 22, 70, 34, 84);
      c.strokeStyle = INK;
      c.lineWidth = 3;
      c.strokeRect(6, 12, 88, 76);
      dot(24, 46, 7, "#dc2626");
      dot(24, 46, 2.5, "#ffffff");
      break;
    }
    case "book": {
      // An open book: two pages of lines, and a ribbon.
      c.fillStyle = "#7c2d12";
      c.beginPath();
      c.moveTo(4, 22);
      c.lineTo(50, 28);
      c.lineTo(96, 22);
      c.lineTo(96, 86);
      c.lineTo(50, 92);
      c.lineTo(4, 86);
      c.closePath();
      c.fill();
      c.fillStyle = "#fffaf0";
      for (const side of [-1, 1]) {
        c.beginPath();
        c.moveTo(50, 24);
        c.bezierCurveTo(50 + side * 14, 14, 50 + side * 30, 14, 50 + side * 42, 18);
        c.lineTo(50 + side * 42, 80);
        c.bezierCurveTo(50 + side * 30, 76, 50 + side * 14, 76, 50, 86);
        c.closePath();
        c.fill();
      }
      c.strokeStyle = "#94a3b8";
      c.lineWidth = 2;
      for (let y = 32; y < 74; y += 8) {
        line(16, y, 42, y + 2);
        line(58, y + 2, 84, y);
      }
      c.strokeStyle = INK;
      c.lineWidth = 3;
      line(50, 24, 50, 86);
      c.fillStyle = "#dc2626";
      c.fillRect(70, 14, 6, 26);
      break;
    }
    case "table": {
      c.fillStyle = "#ffffff";
      c.fillRect(4, 8, 92, 84);
      c.fillStyle = "#0e7490";
      c.fillRect(4, 8, 92, 18);
      c.lineWidth = 2;
      c.strokeStyle = "#94a3b8";
      for (let y = 40; y < 92; y += 14) line(4, y, 96, y);
      line(36, 8, 36, 92);
      line(66, 8, 66, 92);
      c.lineWidth = 3;
      c.strokeStyle = INK;
      c.strokeRect(4, 8, 92, 84);
      break;
    }
    case "many": {
      const fills = ["#16a34a", "#2563eb", "#f59e0b", "#dc2626"];
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) dot(8 + i * 12, 8 + j * 12, 3 + ((i * 7 + j * 3) % 3), fills[(i + j) % 4]!);
      break;
    }
  }
};
