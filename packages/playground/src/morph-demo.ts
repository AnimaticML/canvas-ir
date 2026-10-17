// Two drawings recorded separately, day and night, and the morph between them.
// Parts pair up by the names on their groups; what has no partner fades.
import { type IRDocument, type Morph, RecordingContext, keyByMeta, morph } from "canvas-ir";

export const MORPH_ID = "morph-demo";
const at = { x: 40, y: 1020 };

const scene = (draw: (ctx: RecordingContext, part: (name: string, body: () => void) => void) => void): IRDocument => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: MORPH_ID, meta: { source: "morph demo" } });
  ctx.translate(at.x, at.y);
  const part = (name: string, body: () => void): void => {
    ctx.beginGroup({ id: `${MORPH_ID}/${name}`, meta: { name } });
    ctx.save();
    body();
    ctx.restore();
    ctx.endGroup();
  };
  draw(ctx, part);
  ctx.endGroup();
  return ctx.getDocument();
};

const day = scene((ctx, part) => {
  part("sky", () => {
    const g = ctx.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, "#7dd3fc");
    g.addColorStop(1, "#e0f2fe");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, 0, 520, 260, 12);
    ctx.fill();
  });
  part("light", () => {
    ctx.fillStyle = "#facc15";
    ctx.shadowColor = "rgba(250, 204, 21, 0.8)";
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(90, 80, 42, 0, Math.PI * 2);
    ctx.fill();
  });
  part("house", () => {
    ctx.fillStyle = "#f97316";
    ctx.fillRect(300, 140, 120, 100);
    ctx.fillStyle = "#7c2d12";
    ctx.beginPath();
    ctx.moveTo(290, 140);
    ctx.lineTo(360, 85);
    ctx.lineTo(430, 140);
    ctx.closePath();
    ctx.fill();
  });
  part("window", () => {
    ctx.fillStyle = "#e0f2fe";
    ctx.fillRect(325, 165, 34, 34);
  });
  part("cloud", () => {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(220, 70, 50, 20, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  part("arm", () => {
    ctx.translate(470, 60);
    ctx.rotate(0.3);
    ctx.fillStyle = "#64748b";
    ctx.fillRect(-4, -30, 8, 60);
  });
  part("label", () => {
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillStyle = "#0c4a6e";
    ctx.fillText("Day", 20, 240);
  });
});

const night = scene((ctx, part) => {
  part("sky", () => {
    const g = ctx.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, "#0f172a");
    g.addColorStop(0.6, "#1e1b4b");
    g.addColorStop(1, "#312e81");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, 0, 520, 260, 12);
    ctx.fill();
  });
  part("light", () => {
    // A crescent: one path, two arcs.
    ctx.fillStyle = "#e2e8f0";
    ctx.shadowColor = "rgba(226, 232, 240, 0.5)";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(420, 70, 34, Math.PI * 0.35, Math.PI * 1.65);
    ctx.arc(436, 64, 28, Math.PI * 1.45, Math.PI * 0.55, true);
    ctx.closePath();
    ctx.fill();
  });
  part("house", () => {
    ctx.fillStyle = "#334155";
    ctx.fillRect(300, 150, 120, 90);
    ctx.fillStyle = "#1e293b";
    ctx.beginPath();
    ctx.moveTo(290, 150);
    ctx.lineTo(360, 110);
    ctx.lineTo(430, 150);
    ctx.closePath();
    ctx.fill();
  });
  part("window", () => {
    ctx.fillStyle = "#fde047";
    ctx.fillRect(330, 175, 40, 30);
  });
  part("star", () => {
    ctx.fillStyle = "#fef9c3";
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 12 : 5;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(150 + r * Math.cos(a), 60 + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
  });
  part("arm", () => {
    ctx.translate(470, 60);
    ctx.rotate(2.2);
    ctx.fillStyle = "#94a3b8";
    ctx.fillRect(-4, -30, 8, 60);
  });
  part("label", () => {
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillStyle = "#e0e7ff";
    ctx.fillText("Night", 20, 240);
  });
});

let prepared: Morph | null = null;

/** The morph from day to night, prepared once. */
export const dayToNight = (): Morph => (prepared ??= morph(day, night, { key: keyByMeta("name") }));
