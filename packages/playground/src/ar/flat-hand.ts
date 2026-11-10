// Calibrating a hand's size by laying it flat on the table. One camera sees a hand's shape but not how big it is, so a big
// hand far away looks like a small one close up, and the hand's depth is only as good as the guess of its size. Laid flat on
// the table, every joint is about as high above the table as the finger is thick, and the table's plane is known from the
// markers: so each joint's pixel ray, met with a plane that much above the table, is where that joint really is. Comparing
// those depths with the tracked hand's own gives the scale that makes the tracked hand its true size, from all 21 joints in
// one frame; how much the joints disagree says whether the hand really was flat.
import { add, length, median, rotate, scale, sub, toCamera, transpose, type Intrinsics, type Pixel, type Pose, type V3 } from "./geometry";

/**
 * How high above the table each of MediaPipe's 21 joints is when a hand lies flat, palm down, in meters: about half the
 * thickness of the hand or finger there. Rough, for an adult hand; the scale is the median over the joints, so a few
 * off by millimeters change little.
 */
export const FLAT_HEIGHTS: readonly number[] = [
  0.02, // wrist
  0.022, 0.018, 0.012, 0.008, // thumb
  0.016, 0.012, 0.009, 0.007, // index
  0.016, 0.012, 0.009, 0.007, // middle
  0.015, 0.011, 0.009, 0.007, // ring
  0.013, 0.01, 0.008, 0.006, // little
];

/** Where a pixel's ray meets the plane `height` above the table, in table coordinates, or null if it doesn't, in front. */
export const onPlaneAbove = (table: Pose, k: Intrinsics, p: Pixel, height: number): V3 | null => {
  const r = transpose(table.r);
  const origin = scale(rotate(r, table.t), -1);
  const ray = rotate(r, [(p.x - k.cx) / k.fx, (p.y - k.cy) / k.fy, 1]);
  if (Math.abs(ray[1]) < 1e-5) return null;
  const d = (height - origin[1]) / ray[1];
  return d > 0 ? add(origin, scale(ray, d)) : null;
};

export interface FlatHand {
  /** What to multiply the tracked hand's camera points by to make it its true size. */
  readonly scale: number;
  /** How much the joints disagree about it, as a fraction (median absolute deviation over the median): small when the hand lay flat. */
  readonly spread: number;
  /** Where each joint really is, in table coordinates (null where its ray missed). */
  readonly joints: readonly (V3 | null)[];
  /** The hand's true size: wrist to the middle finger's knuckle, in meters. */
  readonly palm: number | null;
}

/**
 * The scale from one frame of a hand laid flat: `camera` is the tracked hand's joints in camera coordinates (meters, at
 * the size the tracker guessed), `pixels` where they are in the image. Null when fewer than 12 joints' rays meet the table.
 */
export const flatHandScale = (camera: readonly V3[], pixels: readonly Pixel[], table: Pose, k: Intrinsics, heights: readonly number[] = FLAT_HEIGHTS): FlatHand | null => {
  const joints = pixels.map((p, i) => onPlaneAbove(table, k, p, heights[i] ?? 0.01));
  const factors: number[] = [];
  joints.forEach((at, i) => {
    const z = camera[i]?.[2];
    if (!at || !z || z <= 0) return;
    factors.push(toCamera(table, at)[2] / z);
  });
  if (factors.length < 12) return null;
  const middle = median(factors);
  const spread = median(factors.map((f) => Math.abs(f - middle))) / middle;
  const wrist = joints[0];
  const knuckle = joints[9];
  return { scale: middle, spread, joints, palm: wrist && knuckle ? length(sub(knuckle, wrist)) : null };
};
