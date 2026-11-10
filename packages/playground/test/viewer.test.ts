import { describe, expect, test } from "bun:test";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { eyeFrom } from "../src/face";
import { OneEuro, throughWindow } from "../src/viewer";

const window = { center: new Vector3(0, 0, 10), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), halfWidth: 4, halfHeight: 3 };
const screen = { width: 0.4, height: 0.3 };
// Where a room point lands on the screen, -1 to 1, from an eye's position and projection looking along +z.
const onScreen = (p: Vector3, eye: Vector3, projection: Matrix): { x: number; y: number } => {
  const view = Matrix.LookAtLH(eye, eye.add(new Vector3(0, 0, 1)), Vector3.Up());
  const q = Vector3.TransformCoordinates(p, view.multiply(projection));
  return { x: q.x, y: q.y };
};

describe("looking through the screen", () => {
  test("the window's corners stay at the screen's corners wherever the eye is", () => {
    for (const eye of [{ x: 0, y: 0, z: 0.5 }, { x: 0.2, y: -0.1, z: 0.4 }, { x: -0.3, y: 0.15, z: 0.9 }]) {
      const { position, projection } = throughWindow(eye, screen, window, 0.1, 1000);
      const corner = onScreen(new Vector3(4, 3, 10), position, projection);
      expect(corner.x).toBeCloseTo(1, 5);
      expect(corner.y).toBeCloseTo(1, 5);
      const other = onScreen(new Vector3(-4, -3, 10), position, projection);
      expect(other.x).toBeCloseTo(-1, 5);
      expect(other.y).toBeCloseTo(-1, 5);
    }
  });

  test("what's behind the window moves against the eye, as through a real window", () => {
    const far = new Vector3(0, 0, 30);
    const left = throughWindow({ x: -0.1, y: 0, z: 0.5 }, screen, window, 0.1, 1000);
    const right = throughWindow({ x: 0.1, y: 0, z: 0.5 }, screen, window, 0.1, 1000);
    expect(onScreen(far, left.position, left.projection).x).toBeLessThan(0);
    expect(onScreen(far, right.position, right.projection).x).toBeGreaterThan(0);
  });

  test("the eye is placed in the room at the window's scale", () => {
    // 3 units of window over 0.15 m of screen: 20 units a meter.
    expect(throughWindow({ x: 0.1, y: 0, z: 0.5 }, screen, window, 0.1, 1000).position.asArray()).toEqual([2, 0, 0]);
  });
});

describe("the eye from the face", () => {
  const options = { fov: 60, camera: { x: 0, y: 0.17 } };
  const face = (cx: number, cy: number, iris: number) => {
    const marks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    const put = (i: number, x: number, y: number) => (marks[i] = { x: x / 640, y: y / 480 });
    for (const [c, a, b, dx] of [[468, 469, 471, -30], [473, 474, 476, 30]] as const) {
      put(c, cx + dx, cy);
      put(a, cx + dx + iris / 2, cy);
      put(b, cx + dx - iris / 2, cy);
    }
    return marks;
  };

  test("an iris's size in the image says how far the eye is", () => {
    const f = 320 / Math.tan(Math.PI / 6);
    const near = eyeFrom(face(320, 240, 20), 640, 480, options)!;
    expect(near.eye.z).toBeCloseTo((f * 0.0117) / 20, 6);
    expect(eyeFrom(face(320, 240, 10), 640, 480, options)!.eye.z).toBeCloseTo(near.eye.z * 2, 6);
  });

  test("a face on the image's left is the viewer's right, and the camera sits above the screen's middle", () => {
    const e = eyeFrom(face(200, 240, 20), 640, 480, options)!.eye;
    expect(e.x).toBeGreaterThan(0);
    expect(e.y).toBeCloseTo(0.17, 6);
  });
});

test("the One Euro filter smooths a still signal and follows a moving one", () => {
  const f = new OneEuro(1, 0.5);
  let out = 0;
  for (let i = 0; i < 60; i++) out = f.filter(i % 2 ? 0.01 : -0.01, i * 16);
  expect(Math.abs(out)).toBeLessThan(0.005);
  for (let i = 60; i < 120; i++) out = f.filter((i - 60) * 0.02, i * 16);
  expect(out).toBeGreaterThan(1.0);
});
