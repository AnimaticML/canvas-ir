// The Babylon page's entry: the playground's board as the floor of a room, a switch between 2D and 3D, and the HUD line that shows each event's path.
import { startBabylon } from "./babylon";

const event = document.getElementById("event")!;
if (matchMedia("(pointer: coarse)").matches) {
  document.getElementById("hint")!.textContent = "Tap what is drawn on the table to use it · drag to orbit the pin · two fingers slide, pinch and turn · tap the table to move the pin, double-tap to look down · double-tap a window's title bar to lift it as a tablet · two fingers on its title bar carry and turn it, on its face pinch to zoom in";
}
const hud = document.querySelector(".hud") as HTMLElement;
const fly = document.getElementById("fly") as HTMLButtonElement;
const head = document.getElementById("head") as HTMLButtonElement;
void startBabylon({
  canvas: document.getElementById("scene") as HTMLCanvasElement,
  frame: document.getElementById("page") as HTMLIFrameElement,
  toggle: document.getElementById("toggle") as HTMLButtonElement,
  fly: fly,
  head,
  start: location.hash === "#3d" ? "3d" : "2d",
  tilt: location.hash === "#tilt",
  onEvent: (text) => (event.textContent = text),
  onMode: (mode) => {
    hud.style.display = mode === "3d" ? "" : "none";
    fly.hidden = mode !== "3d";
    head.hidden = mode !== "3d" || !navigator.mediaDevices?.getUserMedia;
    history.replaceState(null, "", mode === "3d" ? "#3d" : location.pathname + location.search);
  },
});
