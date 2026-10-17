// The game page: keys and touch buttons, the HUD, and the game itself.
import { input, startGame } from "./game";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const time = document.getElementById("time")!;
const fish = document.getElementById("fish")!;
const stamina = document.getElementById("stamina")!;
const message = document.getElementById("message")!;

const game = startGame({
  canvas,
  hud: (s) => {
    time.textContent = `${s.time.toFixed(1)} s`;
    fish.textContent = `🐟 ${s.fish} / ${s.total}`;
    stamina.style.width = `${Math.round(s.stamina * 100)}%`;
  },
  message: (text) => {
    message.hidden = text === null;
    message.textContent = text ?? "";
  },
});

const keys: Record<string, keyof typeof input> = {
  ArrowRight: "right",
  KeyD: "right",
  ArrowLeft: "left",
  KeyA: "left",
  Space: "flap",
  ArrowUp: "flap",
  KeyW: "flap",
};
window.addEventListener("keydown", (e: KeyboardEvent) => {
  const key = keys[e.code];
  if (key) {
    input[key] = true;
    e.preventDefault();
  }
  if (e.code === "KeyR") game.restart();
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  const key = keys[e.code];
  if (key) input[key] = false;
});
window.addEventListener("blur", () => {
  input.left = input.right = input.flap = false;
});
document.querySelectorAll<HTMLButtonElement>(".pad button").forEach((button) => {
  const key = button.dataset["key"] as keyof typeof input;
  const set = (on: boolean) => (e: PointerEvent) => {
    e.preventDefault();
    input[key] = on;
    button.classList.toggle("on", on);
    if (on) button.setPointerCapture(e.pointerId);
  };
  button.addEventListener("pointerdown", set(true));
  button.addEventListener("pointerup", set(false));
  button.addEventListener("pointercancel", set(false));
});
