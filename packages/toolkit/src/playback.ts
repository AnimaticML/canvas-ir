// Playing something back: a clock with a time and a duration, playing or paused, that loops or stops at the end, steps
// frame by frame, and can follow another clock (a video's) while it plays. With a scrub bar and a play button for it,
// so every page that replays a take, an animation or a recording scrubs and plays the same way, by pointer and by key.
import type { ComponentSpec, ComponentUi, RecordingContext, RouterEvent } from "canvas-ir";
import { pressable } from "./behaviours";

export interface PlaybackOptions {
  readonly duration?: number;
  /** Back to the start at the end (the default), or stop there. */
  readonly loop?: boolean;
  /** How fast time goes when playing; default 1. */
  readonly rate?: number;
}

export class Playback {
  private time = 0;
  private on = false;
  private length: number;
  private frames: readonly number[] = [];
  private readonly listeners = new Set<(t: number, playing: boolean) => void>();
  loop: boolean;
  rate: number;

  constructor(options: PlaybackOptions = {}) {
    this.length = Math.max(0, options.duration ?? 0);
    this.loop = options.loop ?? true;
    this.rate = options.rate ?? 1;
  }

  get t(): number {
    return this.time;
  }

  get playing(): boolean {
    return this.on;
  }

  get duration(): number {
    return this.length;
  }

  /** A new thing to play: its length, and the times of its frames, for stepping. Back to the start. */
  load(duration: number, frames: readonly number[] = []): void {
    this.length = Math.max(0, duration);
    this.frames = frames;
    this.time = 0;
    this.said();
  }

  play(): void {
    if (this.on) return;
    // Played from the end, it starts again.
    if (this.time >= this.length) this.time = 0;
    this.on = true;
    this.said();
  }

  pause(): void {
    if (!this.on) return;
    this.on = false;
    this.said();
  }

  toggle(): void {
    if (this.on) this.pause();
    else this.play();
  }

  /** Goes to a time, pausing, as a scrub does. */
  seek(t: number): void {
    this.on = false;
    this.time = Math.max(0, Math.min(this.length, t));
    this.said();
  }

  /** Steps to the next frame (or `n` frames on, or back when negative), pausing; without frames, by a 30th of a second. */
  step(n = 1): void {
    if (this.frames.length === 0) return this.seek(this.time + (n * 1000) / 30);
    // The frame now: the last that starts at or before the time.
    let i = 0;
    while (i + 1 < this.frames.length && this.frames[i + 1]! <= this.time) i++;
    this.seek(this.frames[Math.max(0, Math.min(this.frames.length - 1, i + n))]!);
  }

  /** Moves time on by `dt` milliseconds while playing; at the end it loops or stops. Called once a frame. */
  tick(dt: number): number {
    if (!this.on) return this.time;
    this.time += dt * this.rate;
    if (this.time >= this.length) {
      if (this.loop && this.length > 0) this.time %= this.length;
      else {
        this.time = this.length;
        this.on = false;
      }
    }
    this.said();
    return this.time;
  }

  /** Takes the time from another clock that is playing (a video's), without pausing. */
  follow(t: number): void {
    this.time = Math.max(0, Math.min(this.length, t));
    this.said();
  }

  /** Called with the time and whether it plays, whenever either changes. */
  onChange(listener: (t: number, playing: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private said(): void {
    for (const l of this.listeners) l(this.time, this.on);
  }
}

export interface ScrubState {
  readonly t: number;
  readonly duration: number;
  readonly playing: boolean;
}

/**
 * A scrub bar for a playback: a press or a drag goes to the time under it (`timeAt`), the arrows step a frame, Page Up
 * and Down a second, Home and End go to the ends, Space plays or pauses. To screen readers it is a slider of seconds.
 * The host keeps its state showing the playback (`playback.onChange` → `setState`) and draws it.
 */
export const scrubber = (o: {
  readonly id: string;
  readonly playback: Playback;
  /** The time, in milliseconds, at the point of a press or drag. */
  readonly timeAt: (e: RouterEvent) => number;
  readonly draw: (c: RecordingContext, s: ScrubState, ui: ComponentUi) => void;
  readonly label?: string;
  readonly cursor?: string;
}): ComponentSpec<ScrubState> => {
  const p = o.playback;
  const key = (e: RouterEvent): string => (e.input as { key?: string }).key ?? "";
  return {
    id: o.id,
    state: { t: p.t, duration: p.duration, playing: p.playing },
    meta: (s) => ({ role: "slider", label: o.label ?? "Time", value: Math.round(s.t / 100) / 10 }),
    cursor: o.cursor ?? "ew-resize",
    draw: o.draw,
    on: {
      down: (e) => {
        e.stopPropagation();
        p.seek(o.timeAt(e));
      },
      dragstart: (e) => e.stopPropagation(),
      drag: (e) => {
        e.stopPropagation();
        p.seek(o.timeAt(e));
      },
      keydown: (e) => {
        const k = key(e);
        if (k === "ArrowRight" || k === "ArrowUp") p.step(1);
        else if (k === "ArrowLeft" || k === "ArrowDown") p.step(-1);
        else if (k === "PageUp") p.seek(p.t + 1000);
        else if (k === "PageDown") p.seek(p.t - 1000);
        else if (k === "Home") p.seek(0);
        else if (k === "End") p.seek(p.duration);
        else if (k === " ") p.toggle();
      },
    },
  };
};

/** A play button for a playback: Play or Pause, pressed by pointer, Enter or Space. The host draws it. */
export const playButton = (o: {
  readonly id: string;
  readonly playback: Playback;
  readonly draw: (c: RecordingContext, s: { playing: boolean }, ui: ComponentUi) => void;
}): ComponentSpec<{ playing: boolean }> =>
  pressable({
    id: o.id,
    state: { playing: o.playback.playing },
    label: (s) => (s.playing ? "Pause" : "Play"),
    onPress: () => o.playback.toggle(),
    draw: o.draw,
  });
