import { describe, expect, test } from "bun:test";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene as BabylonScene } from "@babylonjs/core/scene";
import { EventRouter, RecordingContext } from "canvas-ir";
import { Focus, Objects, Surface, World } from "../src/index";

/** A 2-by-1 panel facing the camera, in a stand, with a 200-by-100 drawing: a button in its top left corner. A cube stands in front of its right end. As the three.js package's test, in Babylon's left-handed space: the camera looks along +z. */
const setup = () => {
  const engine = new NullEngine({ renderWidth: 400, renderHeight: 400, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new BabylonScene(engine);
  const stand = new TransformNode("stand", scene);
  const panel = CreatePlane("panel", { width: 2, height: 1 }, scene);
  panel.material = new StandardMaterial("panel", scene);
  panel.parent = stand;
  const cube = CreateBox("cube", { size: 0.4 }, scene);
  cube.position.set(0.7, 0, -1);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  camera.fov = (50 * Math.PI) / 180;
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  camera.getViewMatrix(true);
  for (const m of scene.meshes) m.computeWorldMatrix(true);

  const ctx = new RecordingContext();
  ctx.beginGroup({ id: "button" });
  ctx.fillRect(0, 0, 50, 50);
  ctx.endGroup();
  const size = { width: 400, height: 400 };
  const world = new World({ scene, size: () => size });
  world.add(new Surface(ctx.getDocument(), { mesh: panel, width: 200, height: 100, canvas: fakeCanvas() }));
  /** A point in 3D, as the host's pixels. */
  const screen = (x: number, y: number, z = 0) => {
    const p = Vector3.Project(new Vector3(x, y, z), Matrix.Identity(), camera.getViewMatrix().multiply(camera.getProjectionMatrix()), camera.viewport.toGlobal(size.width, size.height));
    return { x: p.x, y: p.y };
  };
  return { world, screen, camera, scene };
};

/** A canvas a test can draw into and ignore. */
const fakeCanvas = (): HTMLCanvasElement => {
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
};

describe("a Babylon world of meshes and drawings", () => {
  test("a click on a drawn button bubbles through its group, the panel and the stand; elsewhere on the panel it goes to the panel", () => {
    const { world, screen } = setup();
    const router = new EventRouter(world);
    const paths: string[][] = [];
    router.on("*", "click", (e) => paths.push([...e.path]));
    for (const at of [screen(-0.9, 0.4), screen(-0.2, -0.2), screen(0.7, 0, -1.2), screen(0, 2)]) {
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
    expect(points[0]!.x).toBeCloseTo(10, 3);
    expect(points[0]!.y).toBeCloseTo(10, 3);
    expect(points[1]!.x).toBeCloseTo(-50, 3);
    expect(points[1]!.y).toBeCloseTo(10, 3);
  });

  test("a focus draws the whole panel from afar, and only the part in view, finer, up close", () => {
    const { world, camera } = setup();
    const surface = world.all[0]!;
    let t = 0;
    const focus = new Focus(world, surface.mesh, () => surface, { pixelRatio: () => 1, now: () => t });
    const far = focus.update()!;
    expect([far.x, far.y, far.width, far.height]).toEqual([0, 0, 200, 100]);
    expect(far.scale).toBe(1);
    camera.position.set(-0.8, 0.3, -0.4);
    camera.setTarget(new Vector3(-0.8, 0.3, 0));
    camera.getViewMatrix(true);
    t = 16;
    focus.update();
    t = 200;
    const near = focus.update()!;
    expect(near.scale).toBeGreaterThanOrEqual(8);
    expect(near.x).toBe(0);
    expect(near.y).toBe(0);
    expect(near.width).toBeLessThan(100);
    expect(near.height).toBeLessThan(100);
  });

  test("objects over Babylon nodes are drawn as they're hovered and pressed", () => {
    const { world, screen, scene } = setup();
    const router = new EventRouter(world);
    const objects = new Objects(router);
    const looks: string[] = [];
    objects.mount({
      object: scene.getMeshByName("cube")!,
      state: { clicks: 0 },
      draw: (_o, s, ui) => looks.push(`${s.clicks}${ui.hovered ? " hovered" : ""}${ui.pressed ? " pressed" : ""}`),
      on: { click: (_e, c) => c.setState((s) => ({ clicks: s.clicks + 1 })) },
    });
    const at = screen(0.7, 0, -1.2);
    router.pointerMove(at);
    router.pointerDown(at);
    router.pointerUp(at);
    router.pointerMove(screen(0, 2));
    expect(looks).toEqual(["0", "0 hovered", "0 hovered pressed", "0 hovered", "1 hovered", "1"]);
  });
});
