// A take: everything a tracker reported over a stretch of time, frame by frame, with the camera it came from. Takes are
// what experiments are run on: recorded once, replayed through the solver as it changes, and compared, so a change can
// be judged on the same movements every time. The video, when kept, is a file beside the take.
import type { Landmark } from "./landmarks";
import type { SetupId } from "./setups";

export interface HandObservation {
  /** Which of the person's hands, when the tracker or the body says; the tracker's own guess can be mirrored. */
  readonly side: "left" | "right" | null;
  readonly score: number;
  readonly image: readonly Landmark[];
  /** In meters, around the hand's own middle, axes as the image's (x right, y down, z away). */
  readonly world: readonly Landmark[];
}

export interface Frame {
  /** Milliseconds from the start of the take. */
  readonly t: number;
  readonly pose?: {
    readonly image: readonly Landmark[];
    /** In meters, around the middle of the hips, axes as the image's (x right, y down, z away from the camera). */
    readonly world: readonly Landmark[];
  };
  readonly hands: readonly HandObservation[];
}

export interface CameraInfo {
  /** The image's size in pixels. */
  readonly width: number;
  readonly height: number;
  /** Which way the camera faces: toward the person holding it, away, or not known. */
  readonly facing: "user" | "environment" | "unknown";
  /** The field of view across the image, in degrees, when known. */
  readonly fov?: number;
  /** Whether the image was shown mirrored, as a selfie view is. The landmarks are always of the image as captured. */
  readonly mirrored?: boolean;
}

export interface Take {
  readonly version: 1;
  readonly name: string;
  readonly setup: SetupId;
  readonly camera: CameraInfo;
  /** When it was recorded, as an ISO date. */
  readonly created: string;
  /** What the person was asked to do or did, for finding it again. */
  readonly notes?: string;
  /** The video recorded with it, by file name, when there is one. */
  readonly video?: string;
  readonly frames: readonly Frame[];
}

export const duration = (take: Take): number => (take.frames.length ? take.frames[take.frames.length - 1]!.t : 0);

/** The index of the last frame at or before `t`, or 0. */
export const frameIndexAt = (take: Take, t: number): number => {
  const f = take.frames;
  let lo = 0;
  let hi = f.length - 1;
  if (hi < 0 || t <= f[0]!.t) return 0;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (f[m]!.t <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
};

export const frameAt = (take: Take, t: number): Frame | undefined => take.frames[frameIndexAt(take, t)];

const round = (n: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};
const pack = (l: Landmark, places: number): number[] => {
  const out = [round(l.x, places), round(l.y, places), round(l.z, places)];
  if (l.visibility !== undefined) out.push(round(l.visibility, 3));
  return out;
};
const unpack = (a: readonly number[]): Landmark => (a.length > 3 ? { x: a[0]!, y: a[1]!, z: a[2]!, visibility: a[3]! } : { x: a[0]!, y: a[1]!, z: a[2]! });

/** A take as JSON text, its landmarks as short arrays rounded to a tenth of a millimeter or a hundred-thousandth of the image. */
export const saveTake = (take: Take): string =>
  JSON.stringify({
    ...take,
    frames: take.frames.map((f) => ({
      t: round(f.t, 1),
      ...(f.pose ? { pose: { image: f.pose.image.map((l) => pack(l, 5)), world: f.pose.world.map((l) => pack(l, 4)) } } : {}),
      hands: f.hands.map((h) => ({ side: h.side, score: round(h.score, 3), image: h.image.map((l) => pack(l, 5)), world: h.world.map((l) => pack(l, 4)) })),
    })),
  });

/** Reads a take saved by `saveTake`. Throws on anything that isn't one. */
export const loadTake = (text: string): Take => {
  const raw = JSON.parse(text) as { version?: number; frames?: unknown[] } & Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.frames)) throw new Error("not a motion take");
  type RawFrame = { t: number; pose?: { image: number[][]; world: number[][] }; hands?: { side: "left" | "right" | null; score: number; image: number[][]; world: number[][] }[] };
  const frames = (raw.frames as RawFrame[]).map(
    (f): Frame => ({
      t: f.t,
      ...(f.pose ? { pose: { image: f.pose.image.map(unpack), world: f.pose.world.map(unpack) } } : {}),
      hands: (f.hands ?? []).map((h) => ({ side: h.side, score: h.score, image: h.image.map(unpack), world: h.world.map(unpack) })),
    }),
  );
  return { ...(raw as unknown as Take), frames };
};
