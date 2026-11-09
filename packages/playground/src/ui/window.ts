// The parts every demo window shares: a close button at the left of its
// title bar, as on a desktop, where the title starts after it.
import type { RecordingContext } from "canvas-ir";

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
