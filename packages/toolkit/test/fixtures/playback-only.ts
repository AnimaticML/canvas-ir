// An app that wants only the playback clock and its controls.
import { Playback, scrubber } from "@canvas-ir/toolkit/playback";

export const clock = new Playback({ duration: 1000 });
export const bar = scrubber({ id: "scrub", playback: clock, timeAt: () => 0, draw: () => {} });
