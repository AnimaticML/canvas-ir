// The Babylon page's entry: the playground's board as the floor of a room, a switch between 2D and 3D, and the HUD line that shows each event's path.
import { startBabylon } from "./babylon";

const event = document.getElementById("event")!;
if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint")!.textContent = "Tap what is drawn on the floor to use it · drag a crate or ball to throw it · drag the floor to look around · pinch to come closer";
}
const hud = document.querySelector(".hud") as HTMLElement;
void startBabylon({
  canvas: document.getElementById("scene") as HTMLCanvasElement,
  frame: document.getElementById("page") as HTMLIFrameElement,
  toggle: document.getElementById("toggle") as HTMLButtonElement,
  start: location.hash === "#3d" ? "3d" : "2d",
  onEvent: (text) => (event.textContent = text),
  onMode: (mode) => {
    hud.style.display = mode === "3d" ? "" : "none";
    history.replaceState(null, "", mode === "3d" ? "#3d" : location.pathname + location.search);
  },
});
