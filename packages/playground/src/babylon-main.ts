// The Babylon page's entry: the scene, and the HUD line that shows each event's path.
import { startBabylon } from "./babylon";

const event = document.getElementById("event")!;
if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint")!.textContent = "Drag a crate or ball to throw it · drag the floor to look around · pinch to come closer · double-tap to look at one";
}
void startBabylon({ canvas: document.getElementById("scene") as HTMLCanvasElement, onEvent: (text) => (event.textContent = text) });
