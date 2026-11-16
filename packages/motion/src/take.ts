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

/** A small picture of what the camera saw, kept in the take so the movement can be seen without the video. */
export interface TakeImage {
  readonly t: number;
  /** A data URL, usually a small JPEG. */
  readonly src: string;
}

/**
 * What was being done over a stretch of the take, in words: said by the person while recording, or added afterwards
 * by whoever watched it (a person, or a model looking at the images). It is the truth the solve is checked against.
 */
export interface TakeLabel {
  /** From when, and until when, in milliseconds; open-ended labels run to the next label or the end. */
  readonly t0: number;
  readonly t1?: number;
  readonly text: string;
  readonly by?: "person" | "watcher";
}

/**
 * A mark drawn on the image at a moment: a box around something, a line or an arrow showing a movement, a word.
 * Points are in the image's own units, 0 to 1 across and down.
 */
export interface TakeMark {
  readonly t0: number;
  readonly t1?: number;
  readonly kind: "box" | "line" | "arrow" | "text";
  readonly points: readonly (readonly [number, number])[];
  readonly text?: string;
  readonly color?: string;
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
  readonly images?: readonly TakeImage[];
  readonly labels?: readonly TakeLabel[];
  readonly marks?: readonly TakeMark[];
}

/** The labels in force at `t`. */
export const labelsAt = (take: Take, t: number): TakeLabel[] => {
  const labels = [...(take.labels ?? [])].sort((a, b) => a.t0 - b.t0);
  // An open-ended label runs until the next one by the same hand.
  const end = (l: TakeLabel, i: number) => l.t1 ?? labels.slice(i + 1).find((n) => (n.by ?? "person") === (l.by ?? "person"))?.t0 ?? Infinity;
  return labels.filter((l, i) => l.t0 <= t && t < end(l, i));
};

/** The image nearest before `t`, if the take has images. */
export const imageAt = (take: Take, t: number): TakeImage | undefined => {
  const images = take.images;
  if (!images?.length) return undefined;
  let lo = 0;
  let hi = images.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (images[m]!.t <= t) lo = m;
    else hi = m - 1;
  }
  return images[lo];
};

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
