// The 3D page's entry: the room, and the HUD line that shows each event's path.
import { startSpace } from "./space";

const event = document.getElementById("event")!;
// On a touch screen the keys are gestures.
if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint")!.textContent = "Left stick floats, right stick looks · tap the floor to walk there · double-tap to fly to it · tap a shape, then twist two fingers to turn it";
}
startSpace({ canvas: document.getElementById("space") as HTMLCanvasElement, onEvent: (text) => (event.textContent = text) });
