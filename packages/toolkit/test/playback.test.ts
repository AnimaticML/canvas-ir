import { describe, expect, test } from "bun:test";
import type { ComponentHandle, ComponentSpec, RouterEvent } from "canvas-ir";
import { Playback, playButton, scrubber } from "../src/index";

const event = (input: object = {}, x = 0): RouterEvent => ({ input, point: { x, y: 0 }, stopPropagation: () => {} }) as unknown as RouterEvent;
const fire = <S>(spec: ComponentSpec<S>, type: string, e: RouterEvent) => (spec.on as Record<string, (e: RouterEvent, h: ComponentHandle<S>) => void>)[type]?.(e, {} as ComponentHandle<S>);

describe("playback", () => {
  test("plays, loops at the end, and played from the end starts again", () => {
    const p = new Playback({ duration: 1000 });
    p.play();
    p.tick(600);
    expect(p.t).toBe(600);
    p.tick(600);
    expect(p.t).toBe(200);
    expect(p.playing).toBe(true);
    const once = new Playback({ duration: 1000, loop: false });
    once.play();
    once.tick(1500);
    expect(once.t).toBe(1000);
    expect(once.playing).toBe(false);
    once.play();
    expect(once.t).toBe(0);
  });

  test("seeking and stepping pause it; steps go frame to frame, clamped", () => {
    const p = new Playback();
    p.load(400, [0, 100, 200, 300]);
    p.play();
    p.seek(150);
    expect(p.playing).toBe(false);
    p.step(1);
    expect(p.t).toBe(200);
    p.step(-5);
    expect(p.t).toBe(0);
    p.seek(9999);
    expect(p.t).toBe(400);
  });

  test("following another clock keeps it playing, and every change is said", () => {
    const p = new Playback({ duration: 1000 });
    const said: string[] = [];
    p.onChange((t, playing) => said.push(`${t} ${playing}`));
    p.play();
    p.follow(250);
    p.pause();
    expect(said).toEqual(["0 true", "250 true", "250 false"]);
  });

  test("a scrub bar seeks where it is pressed and dragged, and its keys step, page, end and play", () => {
    const p = new Playback();
    p.load(2000, [0, 500, 1000, 1500]);
    const bar = scrubber({ id: "scrub", playback: p, timeAt: (e) => e.point.x * 10, draw: () => {} });
    fire(bar, "down", event({}, 30));
    expect(p.t).toBe(300);
    fire(bar, "drag", event({}, 120));
    expect(p.t).toBe(1200);
    fire(bar, "keydown", event({ key: "ArrowLeft" }));
    expect(p.t).toBe(500);
    fire(bar, "keydown", event({ key: "PageUp" }));
    expect(p.t).toBe(1500);
    fire(bar, "keydown", event({ key: "End" }));
    expect(p.t).toBe(2000);
    fire(bar, "keydown", event({ key: " " }));
    expect(p.playing).toBe(true);
    expect(typeof bar.meta === "function" ? bar.meta({ t: 1234, duration: 2000, playing: true }) : null).toEqual({ role: "slider", label: "Time", value: 1.2 });
    const play = playButton({ id: "play", playback: p, draw: () => {} });
    fire(play, "click", event());
    expect(p.playing).toBe(false);
    expect(typeof play.meta === "function" ? play.meta({ playing: true }) : null).toEqual({ role: "button", label: "Pause" });
  });
});
