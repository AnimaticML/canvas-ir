// A learned correction of the tracker's 3D points. MediaPipe's world landmarks are good across the image and poor in
// depth, and some of their errors are the same every time a pose comes up: a forearm raised toward the camera is
// reported pointing at it, a wrist is placed short. A small network, trained on the bench (a rigged mannequin
// rendered in thousands of made-up poses, tracked, and compared with the pose it was rendered in), says from what
// the tracker reported where each of the main bones really points. The landmarks are then moved to agree, each bone
// keeping the length the tracker gave it, so everything after (calibration, filtering, the solve) is unchanged.
//
// It learned from one mannequin under three camera setups: how far it carries to real people is for real takes to
// tell (see docs/motion.md).
import type { Landmark } from "./landmarks";
import type { CameraInfo } from "./take";
import { type Vec3, add, length, normalize, scale, sub, v } from "./vec";

/** A correction's weights, as the trainer writes them. Arrays of numbers are little-endian float32, base64. */
export interface CorrectionWeights {
  /** The landmarks whose positions are fed in, by index. */
  readonly points: readonly number[];
  /** The bones it corrects, in the order of its outputs, each from and to landmarks (averaged when two). */
  readonly bones: readonly { readonly name: string; readonly from: readonly number[]; readonly to: readonly number[] }[];
  /** Which of those bones are moved when the correction is applied; the rest it was only trained on. */
  readonly apply: readonly string[];
  /** Each input's mean and spread over the training set. */
  readonly mean: string;
  readonly spread: string;
  /** The layers in order, each weights (inputs × outputs, row by row) and biases, rectified between layers. */
  readonly layers: readonly { readonly inputs: number; readonly outputs: number; readonly w: string; readonly b: string }[];
}

/** The landmarks moved with each landmark that a bone's far end moves: what hangs from it. */
const CARRIED: Readonly<Record<number, readonly number[]>> = {
  // Shoulders carry the arms and the head; ears carry the face; elbows the forearm and hand; wrists the hand.
  11: [13, 15, 17, 19, 21], 12: [14, 16, 18, 20, 22],
  13: [15, 17, 19, 21], 14: [16, 18, 20, 22],
  15: [17, 19, 21], 16: [18, 20, 22],
  25: [27, 29, 31], 26: [28, 30, 32],
  27: [29, 31], 28: [30, 32],
};
const HEAD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const floats = (s: string): Float32Array => {
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

export class Correction {
  private readonly mean: Float32Array;
  private readonly spread: Float32Array;
  private readonly layers: { inputs: number; outputs: number; w: Float32Array; b: Float32Array }[];

  constructor(private readonly weights: CorrectionWeights) {
    this.mean = floats(weights.mean);
    this.spread = floats(weights.spread);
    this.layers = weights.layers.map((l) => ({ inputs: l.inputs, outputs: l.outputs, w: floats(l.w), b: floats(l.b) }));
  }

  /** The tracker's directions for the bones, and the network's corrected ones, from one frame's landmarks. */
  directions(image: readonly Landmark[], world: readonly Landmark[], camera: CameraInfo): { seen: Vec3[]; corrected: Vec3[] } {
    const { points, bones } = this.weights;
    const W = world.map((l) => v(l.x, -l.y, -l.z));
    const aspect = camera.width / camera.height;
    const I = image.map((l) => ({ x: (l.x - 0.5) * aspect, y: -(l.y - 0.5) }));
    const avg = (list: readonly number[], at: (i: number) => Vec3): Vec3 => scale(list.map(at).reduce(add, v(0, 0, 0)), 1 / list.length);
    const hipW = avg([23, 24], (i) => W[i]!);
    const at2 = (i: number) => v(I[i]!.x, I[i]!.y, 0);
    const hipI = avg([23, 24], at2);
    const s = length(sub(avg([11, 12], at2), hipI)) + 1e-6;
    const seen = bones.map((b) => normalize(sub(avg(b.to, (i) => W[i]!), avg(b.from, (i) => W[i]!))));
    const x: number[] = [];
    for (const i of points) x.push(W[i]!.x - hipW.x, W[i]!.y - hipW.y, W[i]!.z - hipW.z);
    for (const i of points) x.push((I[i]!.x - hipI.x) / s, (I[i]!.y - hipI.y) / s);
    for (const i of points) x.push(image[i]!.visibility ?? 1);
    x.push(hipI.x, hipI.y, s);
    for (const d of seen) x.push(d.x, d.y, d.z);
    let h = Float32Array.from(x, (value, i) => (value - this.mean[i]!) / this.spread[i]!);
    this.layers.forEach((l, k) => {
      const out = Float32Array.from(l.b);
      for (let i = 0; i < l.inputs; i++) {
        const hi = h[i]!;
        if (hi === 0) continue;
        const row = i * l.outputs;
        for (let o = 0; o < l.outputs; o++) out[o]! += hi * l.w[row + o]!;
      }
      if (k < this.layers.length - 1) for (let o = 0; o < l.outputs; o++) out[o] = Math.max(0, out[o]!);
      h = out;
    });
    // The network says how far to turn each of the tracker's directions.
    const corrected = seen.map((d, k) => normalize(v(d.x + h[3 * k]!, d.y + h[3 * k + 1]!, d.z + h[3 * k + 2]!), d));
    return { seen, corrected };
  }

  /**
   * The world landmarks moved so the corrected bones point where the network says, each keeping its length, with what
   * hangs from it moved along. Bones whose landmarks weren't seen clearly are left as the tracker had them.
   */
  apply(image: readonly Landmark[], world: readonly Landmark[], camera: CameraInfo, visible = 0.5): Landmark[] {
    const { corrected } = this.directions(image, world, camera);
    const out = world.map((l) => ({ ...l }));
    const P = (i: number): Vec3 => v(out[i]!.x, -out[i]!.y, -out[i]!.z);
    const move = (i: number, by: Vec3) => {
      out[i] = { ...out[i]!, x: out[i]!.x + by.x, y: out[i]!.y - by.y, z: out[i]!.z - by.z };
    };
    const avg = (list: readonly number[]): Vec3 => scale(list.map(P).reduce(add, v(0, 0, 0)), 1 / list.length);
    // In the order of the outputs, which goes from the torso out, so a bone's near end has already moved.
    this.weights.bones.forEach((b, k) => {
      if (!this.weights.apply.includes(b.name)) return;
      if (Math.min(...[...b.from, ...b.to].map((i) => image[i]?.visibility ?? 1)) < visible) return;
      const near = avg(b.from);
      const far = avg(b.to);
      const by = sub(add(near, scale(corrected[k]!, length(sub(far, near)))), far);
      const moved = new Set<number>();
      for (const i of b.to) for (const j of [i, ...(CARRIED[i] ?? [])]) moved.add(j);
      // The torso's far end is the shoulders: the head goes with them. The neck's is the ears: the face goes with them.
      if (b.to.includes(11) || b.to.includes(7)) for (const j of HEAD) moved.add(j);
      for (const j of moved) move(j, by);
    });
    return out;
  }
}
