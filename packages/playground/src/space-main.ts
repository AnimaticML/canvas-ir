// The 3D page's entry: the room, and the HUD line that shows each event's path.
import { startSpace } from "./space";

const event = document.getElementById("event")!;
// On a touch screen the keys are gestures.
if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint")!.textContent = "Drag to look · pinch to walk · two fingers to slide and rise · pinch the big screen to zoom it";
}
startSpace({ canvas: document.getElementById("space") as HTMLCanvasElement, onEvent: (text) => (event.textContent = text) });
