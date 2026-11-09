// Two thumbsticks over the page, for moving through a 3D room on a touch screen: shared by the three.js and Babylon pages.

/**
 * Two thumbsticks over a touch screen: the left one floats through the room,
 * the right one looks around, each as far as it's pushed. By default they
 * show only on a touch screen; `show` turns them on or off.
 */
export const thumbsticks = (
  on: { move: (x: number, y: number, dt: number) => void; look: (x: number, y: number, dt: number) => void },
  options: { readonly shown?: boolean } = {},
) => {
  const bases: HTMLElement[] = [];
  const make = (side: "left" | "right") => {
    const base = document.createElement("div");
    const knob = document.createElement("div");
    Object.assign(base.style, {
      position: "fixed", bottom: "28px", [side]: "24px", width: "112px", height: "112px", borderRadius: "50%",
      background: "rgba(15,23,42,0.12)", border: "2px solid rgba(15,23,42,0.28)", backdropFilter: "blur(3px)", touchAction: "none",
    });
    Object.assign(knob.style, { position: "absolute", left: "34px", top: "34px", width: "44px", height: "44px", borderRadius: "50%", background: "rgba(255,255,255,0.9)", boxShadow: "0 1px 4px rgba(0,0,0,0.25)" });
    base.append(knob);
    base.setAttribute("aria-label", side === "left" ? "Move" : "Look");
    bases.push(base);
    document.body.append(base);
    const value = { x: 0, y: 0 };
    const set = (e: PointerEvent): void => {
      const r = base.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
      let y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const m = Math.hypot(x, y);
      if (m > 1) (x /= m), (y /= m);
      value.x = x;
      value.y = y;
      knob.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
    };
    const reset = (): void => {
      value.x = value.y = 0;
      knob.style.transform = "";
    };
    base.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      base.setPointerCapture(e.pointerId);
      set(e);
    });
    base.addEventListener("pointermove", (e) => base.hasPointerCapture(e.pointerId) && set(e));
    base.addEventListener("pointerup", reset);
    base.addEventListener("pointercancel", reset);
    return value;
  };
  const left = make("left");
  const right = make("right");
  const show = (shown: boolean): void => {
    for (const b of bases) b.style.display = shown ? "" : "none";
    if (!shown) left.x = left.y = right.x = right.y = 0;
  };
  show(options.shown ?? matchMedia("(pointer: coarse)").matches);
  // A little dead zone in the middle, and more speed toward the edge.
  const curve = (v: number): number => Math.sign(v) * Math.max(0, Math.abs(v) - 0.12) ** 1.5 / 0.88 ** 1.5;
  return {
    show,
    moving: (): boolean => left.x !== 0 || left.y !== 0 || right.x !== 0 || right.y !== 0,
    apply: (dt: number): void => {
      if (left.x !== 0 || left.y !== 0) on.move(curve(left.x), curve(left.y), dt);
      if (right.x !== 0 || right.y !== 0) on.look(curve(right.x), curve(right.y), dt);
    },
  };
};
