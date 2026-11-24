/** A wheel delta in a consistent unit throughout a gesture. */
export interface WheelDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export type WheelSource = "mouse" | "trackpad" | "ambiguous";

/**
 * Estimates the source of one vertical wheel gesture. Call with a batch of
 * samples from the same gesture. A single delta, even a large one, cannot
 * establish a notch size.
 */
export function classifyWheel(samples: readonly WheelDelta[]): WheelSource {
  const vertical: number[] = [];
  for (const { deltaX, deltaY } of samples) {
    // A horizontal component is evidence for pan under the vertical-wheel model.
    if (deltaX !== 0) return "trackpad";
    if (deltaY !== 0) vertical.push(Math.abs(deltaY));
  }
  if (vertical.length < 3) return "ambiguous";

  return notchSize(vertical) === undefined ? "trackpad" : "mouse";
}

function matchesNotch(delta: number, step: number): boolean {
  const notches = Math.abs(delta) / step;
  const rounded = Math.round(notches);
  return rounded >= 1 && rounded <= 8 && Math.abs(notches - rounded) <= 0.02;
}

function notchSize(vertical: readonly number[]): number | undefined {
  // The smallest observed event may already contain several coalesced notches.
  const smallest = Math.min(...vertical);
  for (let count = 1; count <= 4; count++) {
    const step = smallest / count;
    if (vertical.every((delta) => matchesNotch(delta, step))) return step;
  }
}

export interface WheelSample extends WheelDelta {
  readonly timeStamp: number;
  readonly ctrlKey: boolean;
}

export type WheelAction = "pan" | "zoom";

/** Chooses an action on the first event and keeps it until the burst ends. */
export class WheelGesture {
  private previous?: WheelSample;
  private action: WheelAction = "pan";
  private notch: number | undefined;
  private vertical: number[] = [];
  private horizontal = false;
  private isolated: number[] = [];

  constructor(private readonly idleMs = 100) {}

  push(sample: WheelSample): WheelAction {
    if (sample.deltaX === 0 && sample.deltaY === 0) return this.action;
    const previous = this.previous;
    if (!previous || sample.timeStamp - previous.timeStamp >= this.idleMs || sample.ctrlKey !== previous.ctrlKey) {
      if (previous && !previous.ctrlKey) this.learn();
      this.vertical = [];
      this.horizontal = false;
      const knownNotch = sample.deltaX === 0 && this.notch !== undefined && matchesNotch(sample.deltaY, this.notch);
      this.action = sample.ctrlKey || knownNotch ? "zoom" : "pan";
    }
    this.previous = sample;
    if (!sample.ctrlKey) {
      if (sample.deltaX !== 0) this.horizontal = true;
      if (sample.deltaY !== 0 && this.vertical.length < 12) this.vertical.push(Math.abs(sample.deltaY));
    }
    return this.action;
  }

  private learn(): void {
    if (!this.horizontal && this.vertical.length === 1) {
      // A mouse can deliver isolated clicks separated by more than the idle gap.
      this.isolated.push(this.vertical[0]!);
      if (this.isolated.length > 3) this.isolated.shift();
      if (this.isolated.length === 3) this.notch = notchSize(this.isolated) ?? this.notch;
      return;
    }
    this.isolated = [];
    if (!this.horizontal && this.vertical.length >= 3) this.notch = notchSize(this.vertical) ?? this.notch;
  }
}
