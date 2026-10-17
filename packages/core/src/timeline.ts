// Flash's time model on top of the IR: clips of drawn keyframes that morph
// between them (shape tweens), keyframed transforms (motion tweens), tracks
// that run clips on their own clocks, labels, and scripts on frames.
import { RecordingContext } from "./context";
import type { Scene } from "./geometry/scene";
import { IDENTITY } from "./math";
import { type Morph, type MorphOptions, blendTransforms, morph } from "./morph";
import type { IRDocument, JsonValue, Matrix2D } from "./types";

/** Maps progress through a tween (0 to 1) to how far along the blend is. */
export type Easing = (t: number) => number;

export const easings = {
  linear: (t: number): number => t,
  in: (t: number): number => t * t * t,
  out: (t: number): number => 1 - (1 - t) ** 3,
  inOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  /** Holds the keyframe until the next one: a frame-by-frame cut, no tween. */
  hold: (t: number): number => (t < 1 ? 0 : 1),
} satisfies Record<string, Easing>;

/**
 * Records a drawing into a group with the given id, as a clip's keyframe or a
 * component's frame: what `Scene.replaceGroup` swaps in under that id.
 */
export const drawing = (id: string, draw: (ctx: RecordingContext) => void, meta?: { readonly [key: string]: JsonValue }): IRDocument => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id, ...(meta ? { meta } : {}) });
  draw(ctx);
  ctx.endGroup();
  return ctx.getDocument();
};

/** A pose a clip passes through: a drawing, at a time in seconds, and how the tween leaving it eases. */
export interface Keyframe {
  readonly at: number;
  readonly drawing: IRDocument | (() => IRDocument);
  readonly ease?: Easing;
}

export interface ClipOptions {
  /** How the drawings' ops pair up between keyframes; see `morph`. */
  readonly key?: MorphOptions["key"];
  /** Loops back to the first keyframe, tweening into it, after `duration`. Default false: the last keyframe holds. */
  readonly loop?: boolean;
  /** The clip's length in seconds. Default: the last keyframe's time, or one keyframe gap past it when looping. */
  readonly duration?: number;
  /** Names for times, to jump to. */
  readonly labels?: { readonly [name: string]: number };
}

/**
 * A shape tween: drawings at keyframes, and the morph between each pair.
 * Keyframes are drawn and pairs prepared when first reached, so a long clip
 * costs nothing up front.
 */
export class Clip {
  readonly duration: number;
  readonly loop: boolean;
  readonly labels: { readonly [name: string]: number };
  private readonly keys: readonly Keyframe[];
  private readonly drawn = new Map<number, IRDocument>();
  private readonly morphs = new Map<number, Morph>();

  constructor(keyframes: readonly Keyframe[], private readonly options: ClipOptions = {}) {
    if (keyframes.length === 0) throw new Error("a clip needs a keyframe");
    this.keys = [...keyframes].sort((a, b) => a.at - b.at);
    this.loop = options.loop ?? false;
    const last = this.keys.at(-1)!.at;
    const gap = this.keys.length > 1 ? last - this.keys.at(-2)!.at : 1;
    this.duration = options.duration ?? (this.loop ? last + gap : last);
    this.labels = options.labels ?? {};
  }

  /** The clip's time for a playhead time: wrapped when looping, held at the ends otherwise. */
  local(t: number): number {
    if (this.duration <= 0) return 0;
    if (this.loop) return ((t % this.duration) + this.duration) % this.duration;
    return Math.min(this.duration, Math.max(0, t));
  }

  /** The drawing at time `t`. */
  frame(t: number): IRDocument {
    const time = this.local(t);
    const keys = this.keys;
    let i = keys.length - 1;
    while (i > 0 && keys[i]!.at > time) i--;
    const key = keys[i]!;
    const looping = this.loop && i === keys.length - 1 && keys.length > 1;
    const next = i + 1 < keys.length ? i + 1 : looping ? 0 : -1;
    if (next < 0 || time <= key.at) return this.keyframe(i);
    const end = next === 0 ? this.duration : keys[next]!.at;
    const k = (key.ease ?? easings.linear)((time - key.at) / (end - key.at));
    if (k <= 0) return this.keyframe(i);
    if (k >= 1) return this.keyframe(next);
    let m = this.morphs.get(i);
    if (!m) {
      m = morph(this.keyframe(i), this.keyframe(next), this.options.key ? { key: this.options.key } : {});
      this.morphs.set(i, m);
    }
    return m.at(k);
  }

  private keyframe(i: number): IRDocument {
    let doc = this.drawn.get(i);
    if (!doc) {
      const d = this.keys[i]!.drawing;
      doc = typeof d === "function" ? d() : d;
      this.drawn.set(i, doc);
    }
    return doc;
  }
}

/** A motion tween's keyframe: a transform at a time. */
export interface MotionKey {
  readonly at: number;
  readonly transform: Matrix2D;
  readonly ease?: Easing;
}

/** Where a motion tween puts its group at time `t`, held before the first and after the last key. */
export const motionAt = (keys: readonly MotionKey[], t: number): Matrix2D => {
  if (keys.length === 0) return IDENTITY;
  let i = keys.length - 1;
  while (i > 0 && keys[i]!.at > t) i--;
  const key = keys[i]!;
  const next = keys[i + 1];
  if (!next || t <= key.at) return key.transform;
  return blendTransforms(key.transform, next.transform, (key.ease ?? easings.linear)((t - key.at) / (next.at - key.at)));
};

/** The usual pieces of a transform, as a matrix: move, then turn and scale about the origin. */
export const pose = ({ x = 0, y = 0, angle = 0, scale = 1, scaleX = scale, scaleY = scale }: { x?: number; y?: number; angle?: number; scale?: number; scaleX?: number; scaleY?: number }): Matrix2D => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { a: cos * scaleX, b: sin * scaleX, c: -sin * scaleY, d: cos * scaleY, e: x, f: y };
};

/**
 * One layer of a timeline: a group on the board, and what plays on it: a clip
 * (its drawing), a motion tween (its live transform), a nested timeline, or
 * any mix. Each track has its own clock: it starts at `start` on the
 * timeline's, runs at `speed`, and its clip loops on its own, so a wheel can
 * spin while the bike it is on crosses the screen once.
 */
export interface Track {
  /** The group the track draws into and moves. */
  readonly target: string;
  readonly clip?: Clip;
  readonly motion?: readonly MotionKey[];
  /** A timeline nested in this track, on the track's clock. */
  readonly timeline?: Timeline;
  /** The group a new target group goes into. */
  readonly parent?: string;
  readonly start?: number;
  readonly speed?: number;
}

export interface TimelineOptions {
  /** Default: the longest track. */
  readonly duration?: number;
  readonly loop?: boolean;
  readonly labels?: { readonly [name: string]: number };
}

/**
 * Tracks on one clock, Flash's main timeline: `seek` puts every track where it
 * is at a time, drawing clips with `replaceGroup` (only when their frame
 * changed) and placing motion with `setTransform`. Scripts run when the
 * playhead passes their time; see `Player`.
 */
export class Timeline {
  readonly duration: number;
  readonly loop: boolean;
  readonly labels: { readonly [name: string]: number };
  private readonly scripts: { at: number; run: (player: Player) => void }[] = [];
  /** The clip time each target was last drawn at, so a held frame isn't drawn again. */
  private readonly shown = new Map<string, { clip: Clip; at: number }>();

  constructor(readonly tracks: readonly Track[], options: TimelineOptions = {}) {
    const end = (track: Track): number => {
      const length = Math.max(track.clip && !track.clip.loop ? track.clip.duration : 0, track.motion?.at(-1)?.at ?? 0, track.timeline && !track.timeline.loop ? track.timeline.duration : 0);
      return (track.start ?? 0) + length / (track.speed ?? 1);
    };
    this.duration = options.duration ?? Math.max(0, ...tracks.map(end));
    this.loop = options.loop ?? false;
    this.labels = options.labels ?? {};
  }

  /** Runs `script` each time the playhead reaches a time or label, as a frame script did. */
  at(time: number | string, script: (player: Player) => void): this {
    this.scripts.push({ at: this.time(time), run: script });
    return this;
  }

  /** A label's time, or the time itself. */
  time(at: number | string): number {
    if (typeof at === "number") return at;
    const t = this.labels[at];
    if (t === undefined) throw new Error(`no label ${at}`);
    return t;
  }

  /** The timeline's time for a playhead time: wrapped when looping, held at the ends otherwise. */
  local(t: number): number {
    if (this.duration <= 0) return 0;
    if (this.loop) return ((t % this.duration) + this.duration) % this.duration;
    return Math.min(this.duration, Math.max(0, t));
  }

  /** Puts every track where it is at time `t`. A nested timeline's groups sit inside its track's, so they move with it. */
  seek(scene: Scene, t: number): void {
    const time = this.local(t);
    for (const track of this.tracks) {
      const own = (time - (track.start ?? 0)) * (track.speed ?? 1);
      if (track.clip) {
        const at = track.clip.local(own);
        const last = this.shown.get(track.target);
        if (!last || last.clip !== track.clip || last.at !== at || !scene.getGroup(track.target)) {
          scene.replaceGroup(track.target, track.clip.frame(at), track.parent !== undefined ? { parent: track.parent } : {});
          this.shown.set(track.target, { clip: track.clip, at });
        }
      }
      if (track.motion && scene.getGroup(track.target)) scene.setTransform(track.target, motionAt(track.motion, own));
      track.timeline?.seek(scene, own);
    }
  }

  /** Scripts whose time lies in (from, to], in order, across a loop's end. */
  scriptsBetween(from: number, to: number): ((player: Player) => void)[] {
    if (this.scripts.length === 0 || to <= from) return [];
    const out: { at: number; run: (player: Player) => void }[] = [];
    const span = this.loop && this.duration > 0 ? this.duration : Infinity;
    for (const s of this.scripts) {
      // Each pass of the playhead over the script's time, looping or not.
      const first = span === Infinity ? s.at : s.at + Math.ceil((from - s.at) / span) * span;
      for (let at = first === from ? first + span : first; at <= to; at += span) {
        if (at > from) out.push({ at, run: s.run });
        if (span === Infinity) break;
      }
    }
    return out.sort((a, b) => a.at - b.at).map((s) => s.run);
  }
}

/**
 * Plays a timeline on a scene: `play`, `stop`, `gotoAndPlay` and
 * `gotoAndStop`, as in Flash. `tick(now)` advances it; `play` drives it with
 * `requestAnimationFrame` where there is one. Time is in seconds.
 */
export class Player {
  /** The playhead, in timeline seconds; it runs on past a loop's end, and the timeline wraps it. */
  time = 0;
  speed = 1;
  private playing = false;
  private last: number | null = null;
  private frame: number | null = null;
  private readonly listeners = new Set<(time: number) => void>();

  constructor(
    readonly timeline: Timeline,
    private readonly scene: Scene,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Calls `listener` after each frame is placed, with the playhead time. */
  onFrame(listener: (time: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.last = null;
    this.schedule();
  }

  stop(): void {
    this.playing = false;
    this.last = null;
    if (this.frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  gotoAndPlay(at: number | string): void {
    this.seek(this.timeline.time(at));
    this.play();
  }

  gotoAndStop(at: number | string): void {
    this.stop();
    this.seek(this.timeline.time(at));
  }

  /** Moves the playhead without running the scripts it jumps over. */
  seek(time: number): void {
    this.time = time;
    this.timeline.seek(this.scene, time);
    for (const listener of this.listeners) listener(time);
  }

  /** Advances by the time since the last tick, in ms as `requestAnimationFrame` gives it, running the scripts passed. */
  tick(now: number): void {
    if (!this.playing) return;
    const dt = this.last === null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    let to = this.time + dt * this.speed;
    if (!this.timeline.loop && to >= this.timeline.duration) to = this.timeline.duration;
    const from = this.time;
    this.time = to;
    this.timeline.seek(this.scene, to);
    for (const script of this.timeline.scriptsBetween(from, to)) {
      script(this);
      // A script that jumped or stopped the playhead ends this frame's scripts.
      if (this.time !== to || !this.playing) break;
    }
    for (const listener of this.listeners) listener(this.time);
    if (!this.timeline.loop && this.time >= this.timeline.duration) this.stop();
  }

  private schedule(): void {
    if (typeof requestAnimationFrame !== "function") return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = null;
      if (!this.playing) return;
      this.tick(now);
      if (this.playing) this.schedule();
    });
  }
}
