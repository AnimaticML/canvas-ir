import { describe, expect, test } from "bun:test";
import { EventRouter, RecordingContext } from "canvas-ir";
import * as THREE from "three";
import { Surface, World } from "../src/index";

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
