// A physics sandbox: crates, balls and stars drawn as canvas code, made bodies
// by @canvas-ir/physics. planck.js simulates; each body's group moves by a
// live transform, so nothing is recorded again while it falls.
import { type ComponentSpec, type IRDocument, RecordingContext, type Scene } from "canvas-ir";
import { Physics } from "@canvas-ir/physics";

export const PHYSICS_ID = "physics";
export const PHYSICS_AT = { x: 40, y: 1760 };
const W = 620;
const H = 420;

const PALETTE = ["#f97316", "#0ea5e9", "#22c55e", "#e11d48", "#a855f7", "#eab308"];

type Kind = "crate" | "ball" | "star";

/** One body's drawing, in its own group, around (x, y). */
const drawBody = (ctx: RecordingContext, id: string, kind: Kind, x: number, y: number, size: number, color: string): void => {
  ctx.beginGroup({ id, meta: { name: kind, body: true } });
  ctx.save();
  ctx.translate(x, y);
  if (kind === "crate") {
    ctx.fillStyle = "#b45309";
    ctx.beginPath();
    ctx.roundRect(-size / 2, -size / 2, size, size, 3);
    ctx.fill();
    // Planks and a brace, so turning shows.
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 2;
    ctx.strokeRect(-size / 2 + 3, -size / 2 + 3, size - 6, size - 6);
    ctx.beginPath();
    ctx.moveTo(-size / 2 + 4, size / 2 - 4);
    ctx.lineTo(size / 2 - 4, -size / 2 + 4);
    ctx.stroke();
  } else if (kind === "ball") {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(0, 0, size / 2, size / 8, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? size / 2 : size / 4.5;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.endGroup();
};

/** The box, the ramps and the pegs: static, collided with through their drawn outlines. */
const drawStage = (ctx: RecordingContext): void => {
  const { x, y } = PHYSICS_AT;
  ctx.beginGroup({ id: `${PHYSICS_ID}/backdrop`, meta: { name: "backdrop", snap: false } });
  ctx.fillStyle = "#f1f5f9";
  ctx.beginPath();
  ctx.roundRect(x, y, W, H, 12);
  ctx.fill();
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillStyle = "#475569";
  ctx.textBaseline = "top";
  ctx.fillText("Physics: planck.js (Box2D). Drag anything.", x + 16, y + 14);
  ctx.endGroup();
  const wall = (name: string, draw: () => void): void => {
    ctx.beginGroup({ id: `${PHYSICS_ID}/${name}`, meta: { name, ground: true } });
    ctx.fillStyle = "#334155";
    ctx.beginPath();
    draw();
    ctx.fill();
    ctx.endGroup();
  };
  wall("floor", () => ctx.rect(x, y + H - 16, W, 16));
  wall("left wall", () => ctx.rect(x, y + 40, 12, H - 56));
  wall("right wall", () => ctx.rect(x + W - 12, y + 40, 12, H - 56));
  wall("ramp", () => {
    ctx.moveTo(x + 12, y + 150);
    ctx.lineTo(x + 250, y + 210);
    ctx.lineTo(x + 250, y + 222);
    ctx.lineTo(x + 12, y + 168);
    ctx.closePath();
  });
  wall("bowl", () => {
    // A curved ramp: its outline is what the balls roll on.
    ctx.moveTo(x + 340, y + 260);
    ctx.quadraticCurveTo(x + 470, y + 340, x + W - 12, y + 230);
    ctx.lineTo(x + W - 12, y + 246);
    ctx.quadraticCurveTo(x + 470, y + 356, x + 340, y + 272);
    ctx.closePath();
  });
  for (let i = 0; i < 5; i++) wall(`peg ${i}`, () => ctx.arc(x + 300 + i * 56, y + 120 + (i % 2) * 34, 7, 0, Math.PI * 2));
};

export interface Sandbox {
  readonly physics: Physics;
  /** Drops more bodies in from the top; returns the ids. */
  drop(count: number): string[];
}

let made = 0;
const random = (() => {
  let seed = 7;
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
})();

/** Draws the sandbox onto the scene and gives its parts bodies. */
export const createSandbox = (scene: Scene): Sandbox => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: PHYSICS_ID, meta: { source: "physics sandbox" } });
  drawStage(ctx);
  ctx.endGroup();
  scene.replaceGroup(PHYSICS_ID, ctx.getDocument());
  const physics = new Physics(scene);
  for (const id of ["floor", "left wall", "right wall", "ramp", "bowl", ...Array.from({ length: 5 }, (_, i) => `peg ${i}`)]) {
    physics.add(`${PHYSICS_ID}/${id}`, { collider: "outline" });
  }
  const drop = (count: number): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const kinds: Kind[] = ["crate", "ball", "star"];
      const kind = kinds[made % 3]!;
      const id = `${PHYSICS_ID}/body ${made++}`;
      const size = 22 + Math.floor(random() * 18);
      const x = PHYSICS_AT.x + 40 + random() * (W - 80);
      const y = PHYSICS_AT.y + 50 + random() * 40;
      const one = new RecordingContext();
      drawBody(one, id, kind, x, y, size, PALETTE[made % PALETTE.length]!);
      const doc: IRDocument = one.getDocument();
      // The scene the bodies are on now: the board may have been replayed into a new one.
      physics.scene.replaceGroup(id, doc, { parent: PHYSICS_ID });
      physics.add(id, {
        collider: kind === "crate" ? "box" : kind === "ball" ? "circle" : "hull",
        restitution: kind === "ball" ? 0.45 : 0.1,
        density: kind === "crate" ? 1.5 : 1,
        velocity: { x: (random() - 0.5) * 200, y: 0 },
      });
      ids.push(id);
    }
    return ids;
  };
  drop(18);
  return { physics, drop };
};

/** The sandbox's controls, drawn on the board: drop more, and a count. */
export const sandboxButton = (onDrop: () => void): ComponentSpec<{ bodies: number }> => {
  const x = PHYSICS_AT.x;
  const y = PHYSICS_AT.y + H + 24;
  return {
    id: "physics-drop",
    state: { bodies: 0 },
    meta: { source: "physics controls", role: "button", label: "Drop more bodies" },
    cursor: "pointer",
    draw: (c, { bodies }, ui) => {
      c.fillStyle = ui.pressed ? "#334155" : ui.hovered ? "#64748b" : "#475569";
      c.beginPath();
      c.roundRect(x, y - 16, 116, 32, 16);
      c.fill();
      if (ui.focused) {
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = "#ffffff";
      c.font = "600 13px system-ui, sans-serif";
      c.textBaseline = "middle";
      c.fillText("Drop 6 more", x + 20, y + 1);
      c.fillStyle = "#6b7280";
      c.font = "12px system-ui, sans-serif";
      c.fillText(`${bodies} bodies, each a group moved by a live transform, nothing re-recorded`, x + 132, y + 1);
    },
    on: {
      click: (e) => {
        e.stopPropagation();
        onDrop();
      },
    },
  };
};
