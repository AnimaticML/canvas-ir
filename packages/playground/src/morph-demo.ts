// Two drawings recorded separately, day and night, and the morph between them.
// Parts pair up by the names on their groups; what has no partner fades.
import { type ComponentHandle, type ComponentSpec, type IRDocument, type Morph, RecordingContext, applyToPoint, invert, keyByMeta, morph } from "canvas-ir";

export const MORPH_ID = "morph-demo";
export const MORPH_AT = { x: 1500, y: 980 };
const at = MORPH_AT;

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

/**
 * The morph's controls, drawn on the board under it as components: a Play
 * button and a slider from day to night. They take the pointer and the keys
 * through the scene's event router like anything else drawn there.
 */
// biome-ignore lint: components of any state
export const morphControls = (morphTo: (t: number) => void, get: <S>(id: string) => ComponentHandle<S> | undefined): ComponentSpec<any>[] => {
  const y = at.y + 290;
  const X0 = at.x + 120;
  const X1 = at.x + 500;
  const SLIDER = "morph-slider";
  const PLAY = "morph-play";
  let run = 0;
  const set = (t: number): void => {
    get<{ t: number }>(SLIDER)?.setState({ t });
    morphTo(t);
  };
  const stop = (): void => {
    run++;
    get<{ playing: boolean }>(PLAY)?.setState({ playing: false });
  };
  const play = (): void => {
    const from = get<{ t: number }>(SLIDER)?.state.t ?? 0;
    const to = from < 0.5 ? 1 : 0;
    const start = performance.now();
    const mine = ++run;
    get<{ playing: boolean }>(PLAY)?.setState({ playing: true });
    const frame = (now: number): void => {
      if (mine !== run) return;
      const k = Math.min(1, (now - start) / (1600 * Math.abs(to - from) || 1));
      const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      set(from + (to - from) * eased);
      if (k < 1) requestAnimationFrame(frame);
      else stop();
    };
    requestAnimationFrame(frame);
  };
  const slideTo = (s: ComponentHandle<{ t: number }>, worldX: number): void => {
    const local = applyToPoint(invert(s.transform) ?? s.transform, worldX, 0);
    stop();
    set(Math.min(1, Math.max(0, (local.x - X0) / (X1 - X0))));
  };
  const button: ComponentSpec<{ playing: boolean }> = {
    id: PLAY,
    state: { playing: false },
    meta: ({ playing }) => ({ source: "morph controls", role: "button", label: playing ? "Pause the morph" : "Play the morph" }),
    cursor: "pointer",
    draw: (c, { playing }, ui) => {
      c.fillStyle = ui.pressed ? "#1d4ed8" : ui.hovered ? "#3b82f6" : "#2563eb";
      c.beginPath();
      c.roundRect(at.x, y - 16, 90, 32, 16);
      c.fill();
      if (ui.focused) {
        c.strokeStyle = "#93c5fd";
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = "#ffffff";
      if (playing) {
        c.fillRect(at.x + 18, y - 7, 4, 14);
        c.fillRect(at.x + 26, y - 7, 4, 14);
      } else {
        c.beginPath();
        c.moveTo(at.x + 18, y - 8);
        c.lineTo(at.x + 31, y);
        c.lineTo(at.x + 18, y + 8);
        c.closePath();
        c.fill();
      }
      c.font = "600 13px system-ui, sans-serif";
      c.textBaseline = "middle";
      c.fillText(playing ? "Pause" : "Play", at.x + 40, y + 1);
    },
    on: {
      click: (e) => {
        e.stopPropagation();
        if (get<{ playing: boolean }>(PLAY)?.state.playing) stop();
        else play();
      },
    },
  };
  const slider: ComponentSpec<{ t: number }> = {
    id: SLIDER,
    state: { t: 0 },
    meta: ({ t }) => ({ source: "morph controls", role: "slider", label: "Day to night", value: Math.round(t * 100), min: 0, max: 100 }),
    cursor: "pointer",
    draw: (c, { t }, ui) => {
      c.beginGroup({ meta: { hitArea: true } });
      c.fillStyle = "rgba(0, 0, 0, 0)";
      c.fillRect(X0 - 12, y - 16, X1 - X0 + 24, 32);
      c.endGroup();
      // The track goes from the day sky to the night sky.
      const g = c.createLinearGradient(X0, 0, X1, 0);
      g.addColorStop(0, "#7dd3fc");
      g.addColorStop(1, "#1e1b4b");
      c.fillStyle = g;
      c.beginPath();
      c.roundRect(X0, y - 3, X1 - X0, 6, 3);
      c.fill();
      const x = X0 + t * (X1 - X0);
      c.fillStyle = "#ffffff";
      c.strokeStyle = ui.focused ? "#2563eb" : "#71717a";
      c.lineWidth = ui.focused || ui.hovered ? 2 : 1;
      c.beginPath();
      c.arc(x, y, ui.pressed ? 10 : 8, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.font = "12px system-ui, sans-serif";
      c.fillStyle = "#6b7280";
      c.textBaseline = "top";
      c.textAlign = "left";
      c.fillText("Day", X0, y + 12);
      c.textAlign = "right";
      c.fillText("Night", X1, y + 12);
      c.textAlign = "start";
    },
    on: {
      down: (e, s) => slideTo(s, e.point.x),
      dragstart: (e) => e.stopPropagation(),
      drag: (e, s) => {
        e.stopPropagation();
        slideTo(s, e.point.x);
      },
      keydown: (e, s) => {
        const key = (e.input as { key: string }).key;
        const step = key === "ArrowRight" || key === "ArrowUp" ? 0.05 : key === "ArrowLeft" || key === "ArrowDown" ? -0.05 : 0;
        if (step === 0) return;
        stop();
        set(Math.min(1, Math.max(0, s.state.t + step)));
      },
    },
  };
  return [button, slider];
};
