// Small vector and rotation math, kept here so the package needs no engine. Plain objects in, new objects out.

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A rotation as a unit quaternion. */
export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const ZERO: Vec3 = v(0, 0, 0);
export const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const normalize = (a: Vec3, fallback: Vec3 = v(0, 1, 0)): Vec3 => {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : fallback;
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const mid = (a: Vec3, b: Vec3): Vec3 => lerp(a, b, 0.5);

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const rotate = (q: Quat, p: Vec3): Vec3 => {
  // p' = q p q*, expanded.
  const tx = 2 * (q.y * p.z - q.z * p.y);
  const ty = 2 * (q.z * p.x - q.x * p.z);
  const tz = 2 * (q.x * p.y - q.y * p.x);
  return v(p.x + q.w * tx + (q.y * tz - q.z * ty), p.y + q.w * ty + (q.z * tx - q.x * tz), p.z + q.w * tz + (q.x * ty - q.y * tx));
};
export const axisAngle = (axis: Vec3, angle: number): Quat => {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angle / 2) };
};
/** The angle of a rotation, in radians, 0 to π. */
export const angleOf = (q: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
/** The angle between two rotations, in radians. */
export const angleBetween = (a: Quat, b: Quat): number => angleOf(qmul(conjugate(a), b));

/** The rotation whose x, y and z axes are the given orthonormal axes. */
export const fromAxes = (x: Vec3, y: Vec3, z: Vec3): Quat => {
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return qnormalize(q);
};

/**
 * A frame whose y axis points along `along` and whose x axis is as near `side` as it can be while square to it: how a
 * bone is oriented, its length along y and the side hint (the hinge axis, the shoulders' line) fixing its twist.
 */
export const frame = (along: Vec3, side: Vec3): Quat => {
  const y = normalize(along);
  let z = cross(side, y);
  if (length(z) < 1e-6) z = cross(Math.abs(y.x) < 0.9 ? v(1, 0, 0) : v(0, 0, 1), y);
  const zz = normalize(z);
  const x = cross(y, zz);
  return fromAxes(x, y, zz);
};

export const qnormalize = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
};

export const slerp = (a: Quat, b: Quat, t: number): Quat => {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const bb = d < 0 ? { x: -b.x, y: -b.y, z: -b.z, w: -b.w } : b;
  d = Math.abs(d);
  if (d > 0.9995) return qnormalize({ x: a.x + (bb.x - a.x) * t, y: a.y + (bb.y - a.y) * t, z: a.z + (bb.z - a.z) * t, w: a.w + (bb.w - a.w) * t });
  const th = Math.acos(d);
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return { x: a.x * ka + bb.x * kb, y: a.y * ka + bb.y * kb, z: a.z * ka + bb.z * kb, w: a.w * ka + bb.w * kb };
};

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
