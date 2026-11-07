import { describe, expect, test } from "bun:test";
import { EventRouter, RecordingContext } from "canvas-ir";
import * as THREE from "three";
import { Focus, Objects, Surface, World } from "../src/index";

/** A 2-by-1 panel facing the camera, in a stand, with a 200-by-100 drawing: a button in its top left corner. A cube stands in front of its right end. */
const setup = () => {
  const root = new THREE.Scene();
  const stand = new THREE.Group();
  stand.name = "stand";
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial());
  panel.name = "panel";
  stand.add(panel);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
  cube.name = "cube";
  cube.position.set(0.7, 0, 1);
  root.add(stand, cube);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "button" });
  ctx.fillRect(0, 0, 50, 50);
  ctx.endGroup();
  const fake = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const size = { width: 400, height: 400 };
  const world = new World({ root, camera, size: () => size });
  world.add(new Surface(ctx.getDocument(), { mesh: panel, width: 200, height: 100, canvas: fake }));
  /** A point in 3D, as the host's pixels. */
  const screen = (x: number, y: number, z = 0) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height };
  };
  return { world, screen };
};

describe("a world of meshes and drawings", () => {
  test("a click on a drawn button bubbles through its group, the panel and the stand; elsewhere on the panel it goes to the panel", () => {
    const { world, screen } = setup();
    const router = new EventRouter(world);
    const paths: string[][] = [];
    router.on("*", "click", (e) => paths.push([...e.path]));
    for (const at of [screen(-0.9, 0.4), screen(-0.2, -0.2), screen(0.7, 0, 1.2), screen(0, 2)]) {
      router.pointerDown(at);
      router.pointerUp(at);
    }
    const op = world.all[0]!.scene.document.ops[0]!.id;
    expect(paths).toEqual([[op, "button", "panel", "stand"], ["panel", "stand"], ["cube"], []]);
  });

  test("a drawing's points are in its own units, and a drag that leaves the panel goes on in its plane", () => {
    const { world, screen } = setup();
    const router = new EventRouter(world);
    const points: { x: number; y: number }[] = [];
    router.on("button", "down", (e) => points.push(e.point));
    router.on("button", "drag", (e) => points.push(e.point));
    router.pointerDown(screen(-0.9, 0.4));
    router.pointerMove(screen(-1.5, 0.4));
    expect(points[0]!.x).toBeCloseTo(10, 4);
    expect(points[0]!.y).toBeCloseTo(10, 4);
    expect(points[1]!.x).toBeCloseTo(-50, 4);
    expect(points[1]!.y).toBeCloseTo(10, 4);
  });
});

describe("a mesh that shows something else", () => {
  test("pointOn gives the content's point from the top left, and goes on past the edge in the plane", () => {
    const { world, screen } = setup();
    const panel = world.object("panel") as THREE.Mesh;
    const on = world.pointOn(panel, screen(-0.5, 0.25), 1280, 800)!;
    expect(on.x).toBeCloseTo(320, 3);
    expect(on.y).toBeCloseTo(200, 3);
    const off = world.pointOn(panel, screen(1.5, 0), 1280, 800)!;
    expect(off.x).toBeCloseTo(1600, 3);
    expect(off.y).toBeCloseTo(400, 3);
  });
});

describe("focus", () => {
  test("far away the whole panel is drawn at the detail its size on screen needs; up close only the part in view, finer", () => {
    const { world } = setup();
    const surface = world.all[0]!;
    const camera = (world as unknown as { options: { camera: THREE.PerspectiveCamera } }).options.camera;
    let t = 0;
    const focus = new Focus(world, surface.mesh, () => surface, { pixelRatio: () => 1, now: () => t });
    const far = focus.update()!;
    expect([far.x, far.y, far.width, far.height]).toEqual([0, 0, 200, 100]);
    // Seen 5 away by a 50° camera on 400 pixels, the panel's 2 meters are about 172 pixels for 200 units: 0.86 a unit, so a step of 1.
    expect(far.scale).toBe(1);
    expect(focus.update()).toBeNull();

    camera.position.set(-0.8, 0.3, 0.4);
    camera.updateMatrixWorld(true);
    // While the camera moves, the region follows at the detail it had; the detail comes once it rests.
    t = 16;
    expect(focus.update()?.scale ?? 1).toBe(1);
    t = 200;
    const near = focus.update()!;
    expect(near.scale).toBeGreaterThanOrEqual(8);
    expect(near.x).toBe(0);
    expect(near.y).toBe(0);
    expect(near.width).toBeLessThan(100);
    expect(near.height).toBeLessThan(100);
    // The texture's size in steps of 256 pixels, within the default budget for a 400 by 400 host: a million pixels.
    expect((near.width * near.scale) % 256).toBeCloseTo(0, 6);
    expect((near.height * near.scale) % 256).toBeCloseTo(0, 6);
    expect(near.width * near.scale * near.height * near.scale).toBeLessThanOrEqual(2 ** 20 + 512 * 1024);
    // Lines meant to look one pixel wide on the host: texture pixels per host pixel where the panel is closest.
    expect(near.ui).toBeGreaterThan(0);
  });
});

describe("objects", () => {
  test("an object is drawn again as it's hovered and pressed, and its handlers run before the router's others", () => {
    const { world, screen } = setup();
    const router = new EventRouter(world);
    const objects = new Objects(router);
    const cube = world.object("cube")!;
    const looks: string[] = [];
    const order: string[] = [];
    objects.mount({
      object: cube,
      state: { clicks: 0 },
      cursor: "grab",
      draw: (_o, s, ui) => looks.push(`${s.clicks}${ui.hovered ? " hovered" : ""}${ui.pressed ? " pressed" : ""}`),
      on: { click: (_e, c) => (order.push("cube"), c.setState((s) => ({ clicks: s.clicks + 1 }))) },
    });
    router.on("*", "click", () => order.push("*"));
    const at = screen(0.7, 0, 1.2);
    router.pointerMove(at);
    expect(objects.cursor).toBe("grab");
    router.pointerDown(at);
    router.pointerUp(at);
    router.pointerMove(screen(0, 2));
    expect(looks).toEqual(["0", "0 hovered", "0 hovered pressed", "0 hovered", "1 hovered", "1"]);
    expect(order).toEqual(["cube", "*"]);
    expect(objects.cursor).toBeNull();
  });
});
