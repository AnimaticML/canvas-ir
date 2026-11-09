/** All physical quantities are metres. Table axes: X right, Y up, Z toward the near edge.
 * OpenCV camera axes: X right, Y down, Z forward. R is row-major, table → camera. */
export type V3 = [number, number, number];
export interface Pose { r: number[]; t: V3 }
export interface Intrinsics { width: number; height: number; fx: number; fy: number; cx: number; cy: number }
export type Pixel = { x: number; y: number };
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a: V3): number => Math.hypot(...a);
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a: V3): V3 => scale(a, 1 / Math.max(length(a), 1e-9));
export const rotate = (r: number[], p: V3): V3 => [dot(r.slice(0, 3) as V3, p), dot(r.slice(3, 6) as V3, p), dot(r.slice(6, 9) as V3, p)];
export const transpose = (r: number[]): number[] => [r[0]!, r[3]!, r[6]!, r[1]!, r[4]!, r[7]!, r[2]!, r[5]!, r[8]!];
export const toCamera = (pose: Pose, p: V3): V3 => add(rotate(pose.r, p), pose.t);
export const toTable = (pose: Pose, p: V3): V3 => rotate(transpose(pose.r), sub(p, pose.t));
export const project = (pose: Pose, k: Intrinsics, p: V3): Pixel => {
  const q = toCamera(pose, p);
  return { x: k.fx * q[0] / q[2] + k.cx, y: k.fy * q[1] / q[2] + k.cy };
};
export const onTable = (pose: Pose, k: Intrinsics, p: Pixel): V3 | null => {
  const r = transpose(pose.r);
  const origin = scale(rotate(r, pose.t), -1);
  const ray = rotate(r, [(p.x - k.cx) / k.fx, (p.y - k.cy) / k.fy, 1]);
  if (Math.abs(ray[1]) < 1e-5) return null;
  const d = -origin[1] / ray[1];
  return d > 0 ? add(origin, scale(ray, d)) : null;
};
export const markerCorners = (size: number, center: V3 = [0, 0, 0], angle = 0): V3[] => {
  const h = size / 2, c = Math.cos(angle), s = Math.sin(angle);
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => [center[0] + c * x! - s * z!, 0, center[2] + s * x! + c * z!]);
};
export const intrinsics = (width: number, height: number, horizontalFov: number): Intrinsics => {
  const f = width / (2 * Math.tan(horizontalFov * Math.PI / 360));
  return { width, height, fx: f, fy: f, cx: width / 2, cy: height / 2 };
};
export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
