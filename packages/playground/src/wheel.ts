// A wheel or trackpad over something that zooms with up and down and pans
// sideways. A trackpad scrolling up wobbles sideways a little, and as a flick
// dies away its steps get so small that the wobble can outweigh them, so
// deciding by each event alone turns the end of a zoom into a pan. A gesture
// decides once, on its first event, and keeps to it until the wheel rests.
export interface WheelInput {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly shiftKey?: boolean;
}

/** How long the wheel rests before the next event starts a new gesture, in milliseconds. */
const REST = 200;

export class WheelGesture {
  private mode: "zoom" | "pan" = "zoom";
  private last = Number.NEGATIVE_INFINITY;

  /** How much this event zooms (the vertical delta) or pans (the sideways one, or any with Shift). */
  read(input: WheelInput): { zoom: number; pan: number } {
    const dx = input.deltaX ?? 0;
    const dy = input.deltaY ?? 0;
    const now = performance.now();
    // Mostly sideways to start: a pan; anything else zooms.
    if (now - this.last > REST) this.mode = Math.abs(dx) > 2 * Math.abs(dy) ? "pan" : "zoom";
    this.last = now;
    if (input.shiftKey) return { zoom: 0, pan: dy || dx };
    return this.mode === "pan" ? { zoom: 0, pan: dx } : { zoom: dy, pan: 0 };
  }
}
