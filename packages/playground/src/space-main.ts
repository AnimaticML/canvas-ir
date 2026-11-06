// The 3D page's entry: the room, and the HUD line that shows each event's path.
import { startSpace } from "./space";

const event = document.getElementById("event")!;
startSpace({ canvas: document.getElementById("space") as HTMLCanvasElement, onEvent: (text) => (event.textContent = text) });
