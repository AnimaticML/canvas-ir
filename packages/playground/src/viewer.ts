// Looking through the screen as through a window. With the viewer's eye tracked (a front camera and the face's irises),
// the screen is a window onto the room: the camera sits where the eye is, and its view is skewed so the screen's edges
// stay where they are, as a window's frame does when you move your head. Move left and you see more of what is to the
// right; lean in and you see more of everything, and down onto the table.
//
// The room's window is where the navigation camera puts it: across its view, through the point it turns around (so that
// point stays put on the screen), at the size the camera's field of view shows there. An eye where the camera's field
// of view is right for this screen sees just what the navigation camera sees; elsewhere, the view is skewed off center.
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

/** Where the eye is, in meters, from the middle of the screen: x to the right, y up, z out of the screen toward the viewer. */
export interface Eye {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The window in the room: its middle, its axes (unit vectors: right, up, and forward, into the room) and its half size, in room units. */
export interface RoomWindow {
  readonly center: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
  readonly forward: Vector3;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * Where the eye is in the room, and the projection that shows the window's rectangle exactly filling the screen from
 * there: an off-axis frustum, through the window's edges. `screen` is the screen's size in meters; the window has the
 * screen's shape. Babylon's left-handed projection, row vectors, depth -1 to 1 (WebGL).
 */
export const throughWindow = (eye: Eye, screen: { width: number; height: number }, w: RoomWindow, near: number, far: number): { position: Vector3; projection: Matrix } => {
  // Room units per meter at the window.
  const k = w.halfHeight / (screen.height / 2);
  const position = w.center.add(w.right.scale(eye.x * k)).add(w.up.scale(eye.y * k)).subtract(w.forward.scale(eye.z * k));
  const toCenter = w.center.subtract(position);
  const d = Math.max(1e-4, Vector3.Dot(toCenter, w.forward));
  const dx = Vector3.Dot(toCenter, w.right);
  const dy = Vector3.Dot(toCenter, w.up);
  const s = near / d;
  const l = (dx - w.halfWidth) * s;
  const r = (dx + w.halfWidth) * s;
  const b = (dy - w.halfHeight) * s;
  const t = (dy + w.halfHeight) * s;
  // prettier-ignore
  const projection = Matrix.FromValues(
    (2 * near) / (r - l), 0, 0, 0,
    0, (2 * near) / (t - b), 0, 0,
    (l + r) / (l - r), (b + t) / (b - t), (far + near) / (far - near), 1,
    0, 0, (-2 * far * near) / (far - near), 0,
  );
  return { position, projection };
};

/**
 * The One Euro filter (Casiez, Roussel and Vogel, 2012): smooths a noisy signal hard while it is still, and less as it
 * moves, so a resting head doesn't shimmer and a moving one doesn't lag. `minCutoff` in hertz sets the smoothing at rest,
 * `beta` how fast it eases off with speed.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    private readonly minCutoff = 1,
    private readonly beta = 0.02,
    private readonly dCutoff = 1,
  ) {}
  reset(): void {
    this.x = null;
  }
  filter(value: number, ms: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = ms;
      return value;
    }
    const dt = Math.max(1e-3, (ms - this.t) / 1000);
    this.t = ms;
    const alpha = (cutoff: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const dx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff) * (value - this.x);
    return this.x;
  }
}

/** A guess at the screen's size in meters, from its size in CSS pixels: about 96 to the inch on a computer, finer on a phone. */
export const screenMeters = (cssWidth: number, cssHeight: number, coarse: boolean): { width: number; height: number } => {
  const meters = coarse ? 0.00016 : 0.00026;
  return { width: cssWidth * meters, height: cssHeight * meters };
};
