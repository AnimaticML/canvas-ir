// The parts every demo window shares: a close button at the left of its
// title bar, as on a desktop, where the title starts after it.
import type { ComponentSpec, RecordingContext } from "canvas-ir";
import { FONT } from "./kit";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a window's title starts, after its close button. */
export const TITLE_LEFT = 46;

/** The close button in a title bar `title` tall, in the window's own units. */
export const closeBox = (title: number): Box => ({ x: 12, y: (title - 24) / 2, width: 24, height: 24 });

export const inBox = (p: { readonly x: number; readonly y: number }, b: Box): boolean => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

/** A round button with a cross, light on a light title bar or dark on a dark one. */
export const drawClose = (c: RecordingContext, b: Box, dark = false): void => {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  c.beginGroup({ meta: { role: "button", label: "Close" } });
  c.beginPath();
  c.arc(cx, cy, b.width / 2, 0, Math.PI * 2);
  c.fillStyle = dark ? "#1e293b" : "#f1f5f9";
  c.fill();
  c.strokeStyle = dark ? "#cbd5e1" : "#475569";
  c.lineWidth = 1.6;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(cx - 4.5, cy - 4.5);
  c.lineTo(cx + 4.5, cy + 4.5);
  c.moveTo(cx + 4.5, cy - 4.5);
  c.lineTo(cx - 4.5, cy + 4.5);
  c.stroke();
  c.lineCap = "butt";
  c.endGroup();
};

/** The title bar's height in a frame around drawn content. */
export const BAR = 40;

/**
 * A window frame for content drawn straight on the board, such as the pelican
 * or the physics sandbox: a title bar above `rect` with the close button, and
 * a border around it. It draws nothing over the content, so it can be mounted
 * after it; the host moves the content and its frame together.
 */
export const windowFrame = (options: { id: string; title: string; rect: Box; onClose: () => void }): ComponentSpec<null> => {
  const { rect } = options;
  const close = closeBox(BAR);
  return {
    id: options.id,
    state: null,
    meta: { role: "dialog", label: options.title, source: "window frame" },
    cursor: () => "default",
    draw: (c) => {
      c.translate(rect.x, rect.y - BAR);
      c.shadowColor = "rgba(15, 23, 42, 0.16)";
      c.shadowBlur = 18;
      c.shadowOffsetY = 4;
      c.beginPath();
      c.roundRect(0, 0, rect.width, BAR, [10, 10, 0, 0]);
      c.fillStyle = "#ffffff";
      c.fill();
      c.shadowColor = "transparent";
      c.strokeStyle = "#cbd5e1";
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect(0.5, 0.5, rect.width - 1, BAR + rect.height - 1, 10);
      c.stroke();
      c.fillStyle = "#e2e8f0";
      c.fillRect(0, BAR - 1, rect.width, 1);
      c.font = `600 15px ${FONT}`;
      c.fillStyle = "#0f172a";
      c.textBaseline = "middle";
      c.fillText(options.title, TITLE_LEFT, BAR / 2);
      c.beginGroup({ id: "close" });
      drawClose(c, close);
      c.endGroup();
    },
    on: {
      click: (e) => {
        if (!e.path.some((id) => id === "close" || id.endsWith("/close"))) return;
        e.stopPropagation();
        options.onClose();
      },
    },
  };
};
