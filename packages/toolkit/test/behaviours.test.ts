import { describe, expect, test } from "bun:test";
import type { ComponentHandle, ComponentSpec, RouterEvent } from "canvas-ir";
import { checkable, pressable, ranged } from "../src/index";

/** A component's handle, without a scene: state and setState. */
const handle = <S>(spec: ComponentSpec<S>): ComponentHandle<S> => {
  const h = { state: spec.state, setState: (p: Partial<S>) => (h.state = { ...h.state, ...p }) };
  return h as unknown as ComponentHandle<S>;
};
const event = (input: object = {}, x = 0): RouterEvent => ({ input, point: { x, y: 0 }, stopPropagation: () => {} }) as unknown as RouterEvent;
const fire = <S>(spec: ComponentSpec<S>, h: ComponentHandle<S>, type: string, e: RouterEvent) => (spec.on as Record<string, (e: RouterEvent, h: ComponentHandle<S>) => void>)[type]?.(e, h);
const meta = <S>(spec: ComponentSpec<S>, h: ComponentHandle<S>) => (typeof spec.meta === "function" ? spec.meta(h.state) : spec.meta);
const noDraw = () => {};

describe("behaviours", () => {
  test("a pressable clicks on a click and on Enter or Space, and names itself a button", () => {
    let presses = 0;
    const spec = pressable({
      id: "play",
      state: { on: false },
      draw: noDraw,
      label: (s) => (s.on ? "Pause" : "Play"),
      pressed: (s) => s.on,
      onPress: (self) => {
        presses++;
        self.setState({ on: !self.state.on });
      },
    });
    const h = handle(spec);
    fire(spec, h, "click", event());
    fire(spec, h, "keydown", event({ key: "Enter" }));
    fire(spec, h, "keydown", event({ key: " " }));
    fire(spec, h, "keydown", event({ key: "a" }));
    expect(presses).toBe(3);
    expect(meta(spec, h)).toEqual({ role: "button", label: "Pause", pressed: true });
  });

  test("a checkable flips and says so, as a checkbox or a switch", () => {
    const said: boolean[] = [];
    const spec = checkable({ id: "loop", checked: false, draw: noDraw, label: "Loop", role: "switch", onChange: (v) => said.push(v) });
    const h = handle(spec);
    fire(spec, h, "click", event());
    fire(spec, h, "keydown", event({ key: " " }));
    expect(said).toEqual([true, false]);
    expect(meta(spec, h)).toEqual({ role: "switch", label: "Loop", value: false });
  });

  test("a range jumps to a press, snaps to its steps from its minimum, and keys step, page and go to the ends", () => {
    const said: number[] = [];
    const spec = ranged({ id: "gain", value: 1, min: 1, max: 21, step: 2, valueAt: (e) => e.point.x, draw: noDraw, label: "Gain", onChange: (v) => said.push(v) });
    const h = handle(spec);
    fire(spec, h, "down", event({}, 8.2));
    fire(spec, h, "drag", event({}, 99));
    fire(spec, h, "keydown", event({ key: "ArrowLeft" }));
    fire(spec, h, "keydown", event({ key: "Home" }));
    fire(spec, h, "keydown", event({ key: "PageUp" }));
    fire(spec, h, "keydown", event({ key: "End" }));
    expect(said).toEqual([9, 21, 19, 1, 21]);
    expect(meta(spec, h)).toEqual({ role: "slider", label: "Gain", value: 21 });
  });

  test("a relative range, as a knob, moves by how far a drag went rather than jumping to it", () => {
    const said: number[] = [];
    const spec = ranged({ id: "pan", value: 50, min: 0, max: 100, relative: true, valueAt: (e) => -e.point.x, draw: noDraw, label: "Pan", onChange: (v) => said.push(v) });
    const h = handle(spec);
    fire(spec, h, "down", event({}, 300));
    expect(said).toEqual([]);
    fire(spec, h, "drag", event({}, 290));
    fire(spec, h, "drag", event({}, 200));
    expect(said).toEqual([60, 100]);
  });
});
