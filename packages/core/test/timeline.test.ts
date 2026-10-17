import { describe, expect, test } from "bun:test";
import { Scene } from "../src/geometry/scene";
import { Clip, Player, Timeline, drawing, easings, motionAt, pose } from "../src/timeline";
import type { FillOp } from "../src/types";

/** A square at x, in a group with the given id. */
const square = (id: string, x: number) => drawing(id, (ctx) => ctx.fillRect(x, 0, 10, 10));

const left = (s: Scene, id: string): number => s.bounds(id)!.x;

describe("clips", () => {
  test("a clip morphs between keyframes and holds at its ends", () => {
    const clip = new Clip([
      { at: 0, drawing: square("box", 0) },
      { at: 1, drawing: square("box", 100) },
    ]);
    expect(clip.duration).toBe(1);
    const at = (t: number) => (clip.frame(t).ops[0] as FillOp).path;
    const x = (t: number) => new Scene(clip.frame(t)).bounds("o0")!.x;
    expect(x(0)).toBeCloseTo(0, 6);
    expect(x(0.25)).toBeCloseTo(25, 6);
    expect(x(1)).toBeCloseTo(100, 6);
    expect(x(5)).toBeCloseTo(100, 6);
    expect(at(-1)).toBe(at(0));
  });

  test("a looping clip tweens from its last keyframe back into its first", () => {
    const clip = new Clip(
      [
        { at: 0, drawing: square("box", 0) },
        { at: 1, drawing: square("box", 100) },
      ],
      { loop: true },
    );
    expect(clip.duration).toBe(2);
    const x = (t: number) => new Scene(clip.frame(t)).bounds("o0")!.x;
    expect(x(1.5)).toBeCloseTo(50, 6);
    expect(x(2.25)).toBeCloseTo(25, 6);
    expect(x(-0.5)).toBeCloseTo(50, 6);
  });

  test("easing shapes the tween, and hold cuts frame by frame", () => {
    const x = (ease: (t: number) => number, t: number) =>
      new Scene(
        new Clip([
          { at: 0, drawing: square("box", 0), ease },
          { at: 1, drawing: square("box", 100) },
        ]).frame(t),
      ).bounds("o0")!.x;
    expect(x(easings.in, 0.5)).toBeCloseTo(12.5, 6);
    expect(x(easings.hold, 0.99)).toBeCloseTo(0, 6);
  });

  test("keyframes drawn by functions are drawn once, when first reached", () => {
    let calls = 0;
    const clip = new Clip([
      { at: 0, drawing: () => (calls++, square("box", 0)) },
      { at: 1, drawing: () => (calls++, square("box", 100)) },
      { at: 2, drawing: () => (calls++, square("box", 200)) },
    ]);
    clip.frame(0.5);
    clip.frame(0.6);
    expect(calls).toBe(2);
  });
});

describe("motion", () => {
  test("a motion tween turns the short way and holds outside its keys", () => {
    const keys = [
      { at: 0, transform: pose({ angle: 0.1 }) },
      { at: 1, transform: pose({ angle: 2 * Math.PI - 0.1, x: 10 }) },
    ];
    const m = motionAt(keys, 0.5);
    expect(Math.atan2(m.b, m.a)).toBeCloseTo(0, 9);
    expect(m.e).toBeCloseTo(5, 9);
    expect(motionAt(keys, 9).e).toBeCloseTo(10, 9);
  });
});

describe("timelines", () => {
  const board = () => {
    const s = new Scene(drawing("stage", () => {}));
    s.replaceGroup("bike", square("bike", 0), { parent: "stage" });
    return s;
  };

  test("tracks put clips and motion on the board, each on its own clock", () => {
    const s = board();
    const wheel = new Clip(
      [
        { at: 0, drawing: square("wheel", 0) },
        { at: 0.5, drawing: square("wheel", 20) },
      ],
      { loop: true },
    );
    const timeline = new Timeline([
      { target: "bike", motion: [{ at: 0, transform: pose({}) }, { at: 4, transform: pose({ x: 400 }) }] },
      { target: "wheel", parent: "bike", clip: wheel, speed: 2 },
    ]);
    expect(timeline.duration).toBe(4);
    timeline.seek(s, 1);
    expect(left(s, "bike")).toBeCloseTo(100, 6);
    // The wheel is in the bike: its own clock (two turns a second) and the bike's motion add.
    expect(left(s, "wheel")).toBeCloseTo(100, 6);
    timeline.seek(s, 1.125);
    expect(left(s, "wheel")).toBeCloseTo(112.5 + 10, 6);
  });

  test("a held frame isn't drawn again", () => {
    const s = board();
    const timeline = new Timeline([{ target: "bike", clip: new Clip([{ at: 0, drawing: square("bike", 5) }]) }]);
    const changes: string[] = [];
    s.onChange((c) => changes.push(c.id));
    timeline.seek(s, 0);
    const first = changes.length;
    timeline.seek(s, 0.5);
    expect(first).toBeGreaterThan(0);
    expect(changes.length).toBe(first);
  });

  test("a nested timeline plays inside its track", () => {
    const s = board();
    const inner = new Timeline([{ target: "bike", motion: [{ at: 0, transform: pose({}) }, { at: 1, transform: pose({ y: 10 }) }] }]);
    s.addGroup({ id: "rider", parent: "stage" });
    const outer = new Timeline([{ target: "stage", motion: [{ at: 0, transform: pose({ x: 50 }) }], timeline: inner, start: 1 }]);
    outer.seek(s, 1.5);
    expect(s.bounds("bike")).toEqual({ x: 50, y: 5, width: 10, height: 10 });
  });
});

describe("player", () => {
  test("ticks advance the playhead, run scripts as they pass, and stop at the end", () => {
    const s = new Scene(drawing("stage", () => {}));
    s.replaceGroup("box", square("box", 0), { parent: "stage" });
    const timeline = new Timeline([{ target: "box", motion: [{ at: 0, transform: pose({}) }, { at: 1, transform: pose({ x: 100 }) }] }], { labels: { half: 0.5 } });
    const ran: number[] = [];
    timeline.at("half", (p) => ran.push(p.time));
    const player = new Player(timeline, s);
    player.play();
    player.tick(1000);
    player.tick(1040);
    expect(player.time).toBeCloseTo(0.04, 9);
    for (let now = 1080; now <= 2200; now += 40) player.tick(now);
    expect(ran.length).toBe(1);
    expect(player.isPlaying).toBe(false);
    expect(left(s, "box")).toBeCloseTo(100, 6);
  });

  test("a looping timeline runs its scripts every pass, and a script can jump", () => {
    const s = new Scene(drawing("stage", () => {}));
    const timeline = new Timeline([], { duration: 1, loop: true, labels: { start: 0, end: 0.9 } });
    let passes = 0;
    timeline.at("end", (p) => {
      passes++;
      if (passes === 3) p.gotoAndStop("start");
    });
    const player = new Player(timeline, s);
    player.play();
    for (let now = 0; now <= 5000; now += 50) player.tick(now);
    expect(passes).toBe(3);
    expect(player.isPlaying).toBe(false);
    expect(player.time).toBe(0);
  });
});
