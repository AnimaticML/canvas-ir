// The Babylon page: crates and balls under Havok physics in a Babylon.js
// scene, with CanvasIR drawings on a panel of controls and on every crate,
// and one EventRouter for the meshes and the drawings. The crates and balls
// are Objects, the same 3D components the three.js page uses: they light up
// under the pointer, and a drag picks one up and throws it.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Scene as BabylonScene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";
import havokWasm from "@babylonjs/havok/lib/esm/HavokPhysics.wasm" with { type: "file" };
import { type ObjectHandle, Objects, Surface, World } from "@canvas-ir/babylon";
import { type ComponentHandle, Components, EventRouter, type Point, type RouterEvent } from "canvas-ir";
import { Floor, type FloorPage, type FloorThing, type FloorWindow, TABLE, UNITS } from "./floor";
import { type HandOptions, type HandSurface, Hands } from "./hands";
import { Tablet } from "./tablet";
import { FaceTracker } from "./face";
import { type Eye, screenMeters, throughWindow } from "./viewer";
import { thumbsticks } from "./thumbsticks";

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";
const PALETTE = ["#f97316", "#0ea5e9", "#8b5cf6", "#10b981", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];
const W = 480;
const H = 300;

export interface BabylonThing {
  readonly mesh: Mesh;
  readonly body: PhysicsAggregate;
  readonly handle: ObjectHandle<{ bumps: number }>;
  readonly label: { readonly surface: Surface; readonly ui: Components } | undefined;
}

/** Loads the playground in a frame laid over the whole page, and resolves with its floor hook once its board is drawn. */
const loadPage = (frame: HTMLIFrameElement): Promise<FloorPage> =>
  new Promise((resolve) => {
    const wait = (): void => {
      const page = (frame.contentWindow as unknown as { canvasIrFloor?: FloorPage } | null)?.canvasIrFloor;
      if (page?.bounds()) resolve(page);
      else setTimeout(wait, 50);
    };
    wait();
  });

/** A pointer's press, move or lift: what a mouse, a finger or a hand gives the board, a PointerEvent or made up like one. */
export type Press = Pick<PointerEvent, "pointerId" | "pointerType" | "button" | "buttons" | "clientX" | "clientY" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "timeStamp">;

export interface BabylonRuntime {
  engine: Engine; scene: BabylonScene; world: World; floor: Floor; panel: Mesh;
  things: Map<string, BabylonThing>; drop: (kind: "crate" | "ball") => void;
  resize: () => void; visible: boolean;
  controlAt: (point: Vector3) => string | null;
  events: {phase:string;surface:string;path:string[];before:number;after:number}[];
  pointer: (phase: "down" | "move" | "up" | "cancel", point: Vector3, target: "panel" | "board") => void;
  /**
   * The one way in for every pointer: a press, move, lift or cancel at a pixel of the canvas, taken exactly as a mouse's or a
   * finger's. Touch pointers pair up as two fingers. Whatever it lands on (the board, a tablet, the panel, a crate) handles it.
   */
  press: (phase: "down" | "move" | "up" | "cancel", at: Point, pointer?: Partial<Press>) => void;
  /** The same, at a room point, as seen from the camera. */
  pressAt: (phase: "down" | "move" | "up" | "cancel", at: Vector3, pointer?: Partial<Press>) => void;
  /** Hands: give them each frame's tracked joints, in room coordinates; see hands.ts. */
  hands: Hands;
  /**
   * Looking through the screen as through a window: give it where the viewer's eye is, in meters from the middle of the
   * screen (x right, y up, z toward the viewer), each frame it's known, and null to look as the navigation does.
   */
  viewer: { update(eye: Eye | null): void; readonly screen: { width: number; height: number } };
  /** Room point to canvas pixel, through the active camera. */
  toCanvas: (at: Vector3) => Point;
}

export const startBabylon = async (options: { canvas: HTMLCanvasElement; frame: HTMLIFrameElement; toggle: HTMLButtonElement; fly: HTMLButtonElement; onEvent?: (text: string) => void; onMode?: (mode: "2d" | "3d") => void; start?: "2d" | "3d"; tilt?: boolean; ar?: boolean; hands?: Partial<HandOptions>; head?: HTMLButtonElement }): Promise<BabylonRuntime> => {
  const { canvas, frame, toggle } = options;
  const engine = new Engine(canvas, true, { alpha: !!options.ar, stencil: true, preserveDrawingBuffer: false }, true);
  engine.setHardwareScalingLevel(1 / Math.min(2, window.devicePixelRatio || 1));
  const scene = new BabylonScene(engine);
  scene.clearColor = options.ar ? new Color4(0, 0, 0, 0) : new Color4(0.86, 0.89, 0.93, 1);
  const hk = await HavokPhysics({ locateFile: () => havokWasm });
  const gravity = new Vector3(0, -9.81, 0);
  scene.enablePhysics(gravity, new HavokPlugin(true, hk));

  const camera = new ArcRotateCamera("camera", -Math.PI / 2 - 0.35, 1.12, 8, new Vector3(0, 1.1, 0), scene);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 150;
  camera.lowerBetaLimit = 0.0001;
  camera.minZ = 0.05;
  camera.fov = 0.9;
  const hemi = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.65;
  hemi.groundColor = new Color3(0.55, 0.6, 0.68);
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.5), scene);
  sun.position = new Vector3(6, 14, -8);
  sun.intensity = 0.75;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.useBlurExponentialShadowMap = true;
  shadows.blurKernel = 16;

  // The panel on its stand: a drawing on a plane, facing the camera, and a thin box behind it that the crates bounce off.
  const stand = new TransformNode("stand", scene);
  stand.position.set(0, 0, 3);
  const pole = CreateCylinder("", { height: 1.0, diameter: 0.08 }, scene);
  pole.parent = stand;
  pole.position.y = 0.5;
  const poleMaterial = new StandardMaterial("pole", scene);
  poleMaterial.diffuseColor = Color3.FromHexString("#64748b");
  pole.material = poleMaterial;
  const panel = CreatePlane("panel", { width: 2.88, height: 1.8 }, scene);
  panel.parent = stand;
  panel.position.y = 1.9;
  panel.material = new StandardMaterial("panel", scene);
  const back = CreateBox("", { width: 2.88, height: 1.8, depth: 0.04 }, scene);
  back.parent = stand;
  back.position.set(0, 1.9, 0.03);
  back.material = poleMaterial;
  back.isPickable = false;
  for (const m of [pole, back]) shadows.addShadowCaster(m);
  new PhysicsAggregate(back, PhysicsShapeType.BOX, { mass: 0, restitution: 0.4 }, scene);
  new PhysicsAggregate(pole, PhysicsShapeType.CYLINDER, { mass: 0 }, scene);

  const size = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 };
  const world = new World({ scene, size: () => size });
  const page = await loadPage(frame);
  const floor = new Floor(page, scene, world);
  // The table's body, made again when the board grows; and the room's floor, where what fell off lands before it comes back.
  let tableBody: PhysicsAggregate | null = null;
  floor.onResize = (top) => {
    tableBody?.dispose();
    tableBody = new PhysicsAggregate(top, PhysicsShapeType.BOX, { mass: 0, restitution: 0.4, friction: 0.7 }, scene);
  };
  floor.onResize(floor.top);
  new PhysicsAggregate(floor.ground, PhysicsShapeType.BOX, { mass: 0, restitution: 0.2, friction: 0.9 }, scene);
  for (const m of [floor.top]) shadows.addShadowCaster(m);
  const router = new EventRouter(world, { dragThreshold: 4 });
  const objects = new Objects(router);
  const panelSurface = world.add(new Surface({ version: 1, ops: [] }, { mesh: panel, width: W, height: H, pixelRatio: 2.5, background: "#f8fafc" }));
  const panelUi = new Components(panelSurface.scene, router, { onChange: () => panelSurface.invalidate() });

  const handles = new Map<string, ComponentHandle<unknown>>();
  const keep = <S>(handle: ComponentHandle<S>): ComponentHandle<S> => (handles.set(handle.id, handle as ComponentHandle<unknown>), handle);
  const redraw = (...ids: string[]): void => ids.forEach((id) => handles.get(id)?.redraw());
  const state = { gravity: true, bounce: 0.45, last: "Drag a crate or a ball to throw it" };
  const log = (text: string): void => {
    state.last = text;
    options.onEvent?.(text);
    redraw("log");
  };

  // The crates and balls.
  const things = new Map<string, BabylonThing>();
  let count = 0;
  let held: { thing: BabylonThing; normal: Vector3; offset: Vector3; target: Vector3 } | null = null;
  /** Things held by hands, by the hand's pointer: pulled toward the hand each frame, as the mouse's held thing is. */
  const handHolds = new Map<number, { thing: BabylonThing; offset: Vector3; target: Vector3 }>();
  const drop = (kind: "crate" | "ball"): void => {
    const n = ++count;
    const id = `${kind}-${n}`;
    const color = PALETTE[n % PALETTE.length]!;
    const mesh = kind === "crate" ? CreateBox(id, { size: options.ar ? 1.75 : 0.7, wrap: true }, scene) : CreateSphere(id, { diameter: options.ar ? 1.5 : 0.6, segments: 24 }, scene);
    if (options.ar) {
      const area = floor.table;
      mesh.position.set(area.center.x + ((n - 1) % 3 - 1) * area.width * 0.22, 2 + n * 0.2, area.center.z + (n <= 3 ? -0.08 : 0.12) * area.depth);
    } else mesh.position.set((Math.random() - 0.5) * 3, 4 + Math.random() * 2, (Math.random() - 0.5) * 2 - 0.5);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    const material = new StandardMaterial(id, scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    mesh.material = material;
    shadows.addShadowCaster(mesh);
    const body = new PhysicsAggregate(mesh, kind === "crate" ? PhysicsShapeType.BOX : PhysicsShapeType.SPHERE, { mass: kind === "crate" ? 1 : 0.6, restitution: state.bounce, friction: 0.6 }, scene);
    body.body.setAngularDamping(0.3);
    // A crate wears a drawing on each face: its number and how many times it was knocked hard, redrawn when that changes.
    let label: BabylonThing["label"];
    if (kind === "crate") {
      const surface = world.add(new Surface({ version: 1, ops: [] }, { mesh, width: 128, height: 128, background: color, unlit: false }));
      const ui = new Components(surface.scene, router, { onChange: () => surface.invalidate() });
      ui.mount({
        id: `${id}/label`,
        state: {},
        draw: (ctx) => {
          const bumps = things.get(id)?.handle.state.bumps ?? 0;
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 6;
          ctx.strokeRect(8, 8, 112, 112);
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `800 52px ${FONT}`;
          ctx.fillText(String(n), 64, 56);
          ctx.font = `600 15px ${FONT}`;
          ctx.fillText(bumps === 1 ? "1 bump" : `${bumps} bumps`, 64, 98);
        },
      });
      label = { surface, ui };
    }
    const handle = objects.mount({
      object: mesh,
      state: { bumps: 0 },
      cursor: () => (held ? "grabbing" : "grab"),
      draw: (_o, _s, ui) => {
        material.emissiveColor = ui.pressed ? new Color3(0.2, 0.28, 0.5) : ui.hovered ? new Color3(0.12, 0.17, 0.3) : Color3.Black();
        label?.ui.get(`${id}/label`)?.redraw();
      },
      on: {
        dragstart: (e) => {
          const pick = world.hit(e.input as { x: number; y: number }, [mesh]);
          const thing = things.get(id);
          if (!pick || !thing) return;
          // Held at the point grabbed, in the plane that faces the camera through it.
          const normal = camera.getForwardRay().direction.clone();
          held = { thing, normal, offset: mesh.getAbsolutePosition().subtract(pick.point), target: pick.point.clone() };
          log(`dragstart: ${e.path.join(" → ")}`);
          e.stopPropagation();
        },
        drag: (e) => {
          if (!held) return;
          const grab = held.target;
          const at = world.onPlane(e.input as { x: number; y: number }, grab, held.normal);
          if (at) held.target = at;
          e.stopPropagation();
        },
        dragend: () => {
          if (held) log(`threw ${id}`);
          held = null;
        },
      },
    });
    const thing: BabylonThing = { mesh, body, handle, label };
    things.set(id, thing);
    body.body.setCollisionCallbackEnabled(true);
    body.body.getCollisionObservable().add((c) => {
      if (c.type !== "COLLISION_STARTED" || c.impulse < 2.5) return;
      handle.setState((s) => ({ bumps: s.bumps + 1 }));
    });
    redraw("count");
  };
  const clear = (): void => {
    held = null;
    handHolds.clear();
    for (const [id, t] of things) {
      objects.unmount(id);
      if (t.label) world.remove(t.label.surface);
      t.body.dispose();
      t.mesh.dispose(false, true);
    }
    things.clear();
    redraw("count");
  };

  // The panel's controls.
  const button = (id: string, x: number, width: number, label: () => string, onClick: () => void): void => {
    keep(panelUi.mount({
      id,
      state: {},
      cursor: "pointer",
      transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: 92 },
      meta: { role: "button", label: label() },
      draw: (ctx, _s, ui) => {
        ctx.fillStyle = ui.pressed ? "#1d4ed8" : ui.hovered ? "#3b82f6" : "#2563eb";
        ctx.beginPath();
        ctx.roundRect(0, 0, width, 38, 10);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `600 15px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label(), width / 2, 19.5);
      },
      on: { click: (e) => (e.stopPropagation(), onClick()) },
    }));
  };
  keep(panelUi.mount({
    id: "heading",
    state: {},
    draw: (ctx) => {
      ctx.fillStyle = "#0f172a";
      ctx.font = `700 22px ${FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText("Babylon.js, Havok and CanvasIR", 24, 40);
      ctx.fillStyle = "#475569";
      ctx.font = `13px ${FONT}`;
      ctx.fillText("The floor is the playground's board: click what is drawn there.", 24, 62);
      ctx.fillText("Drag a crate or a ball to throw it; drag the floor to look around.", 24, 78);
    },
  }));
  button("crate", 24, 104, () => "Drop crate", () => drop("crate"));
  button("ball", 138, 96, () => "Drop ball", () => drop("ball"));
  button("gravity", 244, 120, () => (state.gravity ? "Float" : "Fall"), () => {
    state.gravity = !state.gravity;
    scene.getPhysicsEngine()?.setGravity(state.gravity ? gravity : Vector3.Zero());
    // Without gravity everything drifts up off the floor a little, so it can float.
    if (!state.gravity) for (const t of things.values()) t.body.body.setLinearVelocity(new Vector3((Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4));
    redraw("gravity");
  });
  button("clear", 374, 82, () => "Clear", clear);

  const SLIDER = { x: 24, y: 166, width: 432 };
  const setBounce = (e: RouterEvent, c: ComponentHandle<object>): void => {
    state.bounce = Math.max(0, Math.min(1, (e.point.x - SLIDER.x) / SLIDER.width));
    for (const t of things.values()) t.body.shape.material = { ...t.body.shape.material, restitution: state.bounce };
    c.redraw();
    e.stopPropagation();
  };
  keep(panelUi.mount({
    id: "bounce",
    state: {},
    cursor: "ew-resize",
    meta: { role: "slider", label: "Bounce", hitArea: true },
    draw: (ctx, _s, ui) => {
      ctx.fillStyle = "#334155";
      ctx.font = `600 13px ${FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText(`Bounce ${Math.round(state.bounce * 100)}%`, SLIDER.x, SLIDER.y - 6);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(SLIDER.x - 10, SLIDER.y, SLIDER.width + 20, 26);
      ctx.fillStyle = "#e2e8f0";
      ctx.beginPath();
      ctx.roundRect(SLIDER.x, SLIDER.y + 10, SLIDER.width, 6, 3);
      ctx.fill();
      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.roundRect(SLIDER.x, SLIDER.y + 10, SLIDER.width * state.bounce, 6, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(SLIDER.x + SLIDER.width * state.bounce, SLIDER.y + 13, ui.hovered || ui.pressed ? 11 : 9, 0, Math.PI * 2);
      ctx.fill();
    },
    on: { down: setBounce, dragstart: setBounce, drag: setBounce },
  }));
  keep(panelUi.mount({
    id: "count",
    state: {},
    draw: (ctx) => {
      ctx.fillStyle = "#334155";
      ctx.font = `600 13px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const crates = [...things.keys()].filter((k) => k.startsWith("crate")).length;
      ctx.fillText(`${crates} ${crates === 1 ? "crate" : "crates"}, ${things.size - crates} ${things.size - crates === 1 ? "ball" : "balls"}`, 24, 222);
    },
  }));
  keep(panelUi.mount({
    id: "log",
    state: {},
    draw: (ctx) => {
      ctx.fillStyle = "#f1f5f9";
      ctx.beginPath();
      ctx.roundRect(16, 248, W - 32, 34, 8);
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.font = `12px ui-monospace, Menlo, monospace`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(state.last, 26, 265, W - 52);
    },
  }));

  // Getting around. What is under the finger decides what a gesture does: on something drawn on the table it goes to the board,
  // on a crate or a ball it grabs it, and on empty table or sky it moves the camera: one finger or the left button orbits the pin,
  // two fingers or the right button slide along the table, a pinch or the wheel comes closer to the point under it, and a
  // two-finger twist turns. A click on empty table moves the pin there; a double click looks down on that spot, in 2D.
  let flight: { from: Vector3; to: Vector3; r0: number; r1: number; t0: number } | null = null;
  const lookAt = (mesh: AbstractMesh): void => {
    flight = { from: camera.target.clone(), to: mesh.getAbsolutePosition().clone(), r0: camera.radius, r1: Math.max(camera.lowerRadiusLimit ?? 2, 3), t0: performance.now() };
  };
  /** The point on the table (y = 0) under a host pixel, in the room, or null above the horizon. */
  const onTable = (p: Point): Vector3 | null => world.onPlane(p, Vector3.Zero(), Vector3.Up());

  // The pin: the point the camera turns around and comes closer to. The last few stay on the table as markers to jump back to.
  const pinMaterial = new StandardMaterial("pin", scene);
  pinMaterial.diffuseColor = Color3.FromHexString("#2563eb");
  pinMaterial.emissiveColor = Color3.FromHexString("#1d4ed8");
  const oldPinMaterial = new StandardMaterial("pin/old", scene);
  oldPinMaterial.diffuseColor = Color3.FromHexString("#94a3b8");
  oldPinMaterial.emissiveColor = new Color3(0.25, 0.28, 0.33);
  const pins: TransformNode[] = [];
  const makePin = (i: number): TransformNode => {
    const node = new TransformNode(`pin-${i}`, scene);
    const head = CreateSphere(`pin-${i}/head`, { diameter: 0.16, segments: 12 }, scene);
    head.position.y = 0.32;
    const needle = CreateCylinder(`pin-${i}/needle`, { height: 0.3, diameterTop: 0.03, diameterBottom: 0.005 }, scene);
    needle.position.y = 0.15;
    const ring = CreateTorus(`pin-${i}/ring`, { diameter: 0.34, thickness: 0.025, tessellation: 32 }, scene);
    ring.position.y = 0.01;
    for (const m of [head, needle, ring]) m.parent = node;
    return node;
  };
  const paintPins = (): void => {
    pins.forEach((p, i) => {
      for (const m of p.getChildMeshes()) m.material = i === pins.length - 1 ? pinMaterial : oldPinMaterial;
    });
  };
  /** Moves the pin to a point on the table, gliding the camera's target there; the old pin stays as a marker. */
  const pinAt = (at: Vector3, remember = true): void => {
    at.y = 0;
    const near = pins.findIndex((p) => Vector3.Distance(p.position, at) < 0.4);
    if (near >= 0) {
      const [p] = pins.splice(near, 1);
      pins.push(p!);
    } else if (remember) {
      const p = pins.length >= 5 ? pins.shift()! : makePin(pins.length);
      p.position.copyFrom(at);
      pins.push(p);
    }
    paintPins();
    void glide({ ...pose(), target: at }, 500);
  };

  let lastClick = { at: 0, target: "", x: 0, y: 0 };
  router.on("*", "click", (e) => {
    if (options.ar) return;
    const target = e.path.find((id) => things.has(id) || id === "stand" || id.startsWith("pin-")) ?? "";
    const { x, y } = e.input as Point;
    const now = performance.now();
    const double = target === lastClick.target && now - lastClick.at < 350 && Math.hypot(x - lastClick.x, y - lastClick.y) < 24;
    lastClick = double ? { at: 0, target: "", x, y } : { at: now, target, x, y };
    if (target.startsWith("pin-")) {
      const pin = pins.find((p) => p.name === target.split("/")[0]);
      if (pin) pinAt(pin.position.clone(), false);
      return;
    }
    if (target) {
      if (double) lookAt(target === "stand" ? panel : things.get(target)!.mesh);
      log(`click: ${e.path.join(" → ")}`);
      return;
    }
    // Empty table: the pin goes there; twice, and the camera looks down on it, in 2D.
    const at = onTable({ x, y });
    if (!at) return;
    if (double) void focusTable(at);
    else pinAt(at);
  });
  let orbiting: { x: number; y: number; slide: boolean } | null = null;
  router.on("*", "dragstart", (e) => {
    if (held || e.path.some((id) => id === "stand" || id === "panel")) return;
    const input = e.input as Point & { button?: number; shiftKey?: boolean };
    orbiting = { x: input.x, y: input.y, slide: input.button === 2 || input.button === 1 || input.shiftKey === true };
  });
  router.on("*", "drag", (e) => {
    if (!orbiting) return;
    const { x, y } = e.input as Point;
    if (orbiting.slide) slide(orbiting, { x, y });
    else orbit(x - orbiting.x, y - orbiting.y);
    orbiting = { ...orbiting, x, y };
  });
  router.on("*", "dragend", () => (orbiting = null));
  const orbit = (dx: number, dy: number): void => {
    camera.alpha -= dx * 0.006;
    camera.beta = Math.max(0.05, Math.min(1.52, camera.beta - dy * 0.006));
  };
  /** Slides the camera along the table so the point under `from` ends up under `to`. */
  const slide = (from: Point, to: Point): void => {
    const a = onTable(from);
    const b = onTable(to);
    if (!a || !b) return;
    const d = a.subtract(b);
    // Far toward the horizon a pixel is a long way: no jumps across the room.
    const most = camera.radius * 0.5;
    if (d.length() > most) d.normalize().scaleInPlace(most);
    aim(camera.target.add(d));
  };
  /** Comes closer (factor below 1) or goes back, toward the table point under a host pixel. */
  const zoom = (factor: number, at?: Point): void => {
    const radius = Math.max(camera.lowerRadiusLimit ?? 1, Math.min(camera.upperRadiusLimit ?? 150, camera.radius * factor));
    const k = 1 - radius / camera.radius;
    const toward = at ? onTable(at) : null;
    if (toward && Vector3.Distance(toward, camera.target) < camera.radius * 4) aim(camera.target.add(toward.subtract(camera.target).scale(k)));
    camera.radius = radius;
  };

  // The board under the room: presses on what is drawn there go to the page, at the board point under the pointer.
  const pageWindow = frame.contentWindow as Window & typeof globalThis;
  const pageCanvas = (): HTMLCanvasElement | null => frame.contentDocument?.getElementById("board") as HTMLCanvasElement | null;
  const stageRect = (): DOMRect => (frame.contentDocument?.getElementById("stage") ?? pageCanvas())!.getBoundingClientRect();
  const sendToPage = (e: Press, type: string, at: Point): void => {
    const board = pageCanvas();
    if (!board) return;
    const v = page.view();
    const r = stageRect();
    const keys = { altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
    board.dispatchEvent(
      new pageWindow.PointerEvent(type, {
        clientX: r.left + v.a * at.x + v.c * at.y + v.e,
        clientY: r.top + v.b * at.x + v.d * at.y + v.f,
        ...keys, button: e.button, buttons: e.buttons, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: true, bubbles: true, cancelable: true, composed: true, view: pageWindow,
      }),
    );
  };
  let forwarding: number | null = null;
  /** The tablet a forwarded press is on, if it is on one rather than the table. */
  let forwardingTablet: Tablet | null = null;
  let overPage = false;

  // Tablets: a double press on a window's title bar lifts the window off the table as a tablet that stands facing you.
  // Dragging its title bar carries it over the table, with Shift or the right button turns it, and a double press on
  // its title bar lays it down again, where the window then is on the board. The rest of its face works as the board does.
  const tablets = new Map<string, Tablet>();
  const tabletOf = (mesh: unknown): Tablet | null => [...tablets.values()].find((t) => t.holds(mesh)) ?? null;
  const holes = (): void => {
    floor.holes = [...tablets.values()].map((t) => ({ x: t.rect.x, y: t.rect.y, width: t.rect.width, height: t.rect.height }));
  };
  const facing = (at: Vector3): number => {
    const d = camera.globalPosition.subtract(at);
    return Math.atan2(-d.x, -d.z);
  };
  const liftWindow = (w: FloorWindow): void => {
    if (tablets.has(w.id)) return;
    const at = floor.toRoom({ x: w.x + w.width / 2, y: w.y + w.height / 2 });
    const tablet = new Tablet(scene, page, w, at, floor.background);
    tablets.set(w.id, tablet);
    shadows.addShadowCaster(tablet.slab);
    tablet.draw();
    holes();
    log(`${w.title} lifted off the table`);
    void tablet.glide({ up: 1, yaw: facing(at) }, 700).then(() => tablet.solid(true));
  };
  const layDown = async (tablet: Tablet, ms = 600): Promise<void> => {
    tablet.solid(false);
    await tablet.glide({ up: 0, yaw: 0 }, ms);
    // Where it lies now is where the window goes on the board.
    const to = floor.toBoard(tablet.pose.at);
    const r = tablet.rect;
    page.moveWindow(r.id, to.x - (r.x + r.width / 2), to.y - (r.y + r.height / 2));
    tablets.delete(r.id);
    shadows.removeShadowCaster(tablet.slab);
    tablet.dispose();
    holes();
    log(`${r.title} laid down on the table`);
  };
  /** A tablet held by its title bar: carried over the table, or turned. */
  let carrying: { tablet: Tablet; pointer: number; turn: boolean; last: Point; offset: Vector3 } | null = null;
  let lastBar = { id: "", at: 0 };
  const doubleOnBar = (id: string, now: number): boolean => {
    const double = lastBar.id === id && now - lastBar.at < 450;
    lastBar = double ? { id: "", at: 0 } : { id, at: now };
    return double;
  };
  /** The board point under a host pixel on a tablet's face, following a press past its edge in its plane. */
  const onTablet = (tablet: Tablet, p: Point): Point | null => {
    const { point, normal } = tablet.plane();
    const at = world.onPlane(p, point, normal);
    return at ? tablet.toBoard(at) : null;
  };

  // Pointer input: one pointer goes to the router, or to the page for what is drawn on the table; two fingers move the camera.
  const pointer = (e: Press | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  };
  const fingers = new Map<number, Point>();
  let pinch: { mid: Point; spread: number; angle: number } | null = null;
  /** Two fingers on a tablet: on its title bar they carry and turn it, on its face they magnify and move what it shows. */
  let tabletPinch: { tablet: Tablet; turn: boolean; last: { mid: Point; spread: number; angle: number }; offset: Vector3 } | null = null;
  const faceAt = (tablet: Tablet, p: Point): Point | null => {
    const { point, normal } = tablet.plane();
    const at = world.onPlane(p, point, normal);
    return at ? tablet.face(at) : null;
  };
  let pointerId: number | null = null;
  const twoFingers = (): { mid: Point; spread: number; angle: number } => {
    const [a, b] = [...fingers.values()];
    return { mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, spread: Math.hypot(a!.x - b!.x, a!.y - b!.y), angle: Math.atan2(b!.y - a!.y, b!.x - a!.x) };
  };
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  const down = (e: Press): void => {
    if (e.pointerType === "touch") fingers.set(e.pointerId, pointer(e));
    if (fingers.size === 2) {
      const on = carrying?.tablet ?? forwardingTablet;
      if (on) {
        const now = twoFingers();
        const ground = onTable(now.mid);
        tabletPinch = { tablet: on, turn: carrying !== null, last: now, offset: ground ? on.pose.at.subtract(ground) : Vector3.Zero() };
        carrying = null;
        forwardingTablet = null;
      }
      if (pointerId !== null) router.pointerCancel();
      if (forwarding !== null) pageCanvas()?.dispatchEvent(new pageWindow.PointerEvent("pointercancel", { pointerId: forwarding, pointerType: "touch" }));
      pointerId = null;
      forwarding = null;
      held = null;
      orbiting = null;
      if (!tabletPinch) pinch = twoFingers();
      return;
    }
    if (pinch !== null || tabletPinch !== null || pointerId !== null || forwarding !== null || moving) return;
    flight = null;
    const p = pointer(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    const hit = world.hit(p);
    const tablet = hit ? tabletOf(hit.mesh) : null;
    if (hit && tablet) {
      const at = tablet.toBoard(hit.point);
      if (at && tablet.onBar(at)) {
        if (e.button === 0 && doubleOnBar(tablet.id, e.timeStamp)) {
          void layDown(tablet);
          return;
        }
        const ground = onTable(p);
        carrying = { tablet, pointer: e.pointerId, turn: e.button !== 0 || e.shiftKey, last: p, offset: ground ? tablet.pose.at.subtract(ground) : Vector3.Zero() };
        return;
      }
      if (at && e.button === 0) {
        forwarding = e.pointerId;
        forwardingTablet = tablet;
        sendToPage(e, "pointerdown", at);
        return;
      }
    }
    if (hit && floor.holds(hit.mesh) && e.button === 0) {
      const at = floor.toBoard(hit.point);
      // A double press on a window's title bar lifts it off as a tablet.
      const bar = page.windows().find((w) => at.x >= w.x + 46 && at.x <= w.x + w.width && at.y >= w.y && at.y <= w.y + w.bar);
      if (bar && !tablets.has(bar.id) && doubleOnBar(bar.id, e.timeStamp)) {
        liftWindow(bar);
        return;
      }
      if (page.hits(at)) {
        forwarding = e.pointerId;
        sendToPage(e, "pointerdown", at);
        return;
      }
    }
    pointerId = e.pointerId;
    router.pointerDown(p);
  };
  canvas.addEventListener("pointerdown", down);
  const move = (e: Press): void => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, pointer(e));
    if (tabletPinch !== null) {
      if (fingers.size !== 2) return;
      const now = twoFingers();
      const { tablet, last } = tabletPinch;
      if (tabletPinch.turn) {
        // Held by its title bar: the tablet follows the fingers over the table and turns as they twist.
        let twist = now.angle - last.angle;
        twist -= Math.round(twist / (2 * Math.PI)) * 2 * Math.PI;
        const ground = onTable(now.mid);
        tablet.set({ yaw: tablet.pose.yaw + twist, ...(ground ? { at: ground.add(tabletPinch.offset) } : {}) });
      } else {
        // On its face: what it shows spreads and moves with the fingers.
        const from = faceAt(tablet, last.mid);
        const to = faceAt(tablet, now.mid);
        if (from && to) tablet.zoomAt(now.spread / Math.max(1, last.spread), from, to);
      }
      tabletPinch = { ...tabletPinch, last: now };
      return;
    }
    if (pinch !== null && fingers.size === 2) {
      // Two fingers: the table under them follows them, their spread comes closer to the point between them, and their twist turns the view.
      const now = twoFingers();
      slide(pinch.mid, now.mid);
      zoom(pinch.spread / Math.max(1, now.spread), now.mid);
      let twist = now.angle - pinch.angle;
      twist -= Math.round(twist / (2 * Math.PI)) * 2 * Math.PI;
      camera.alpha -= twist;
      pinch = now;
      return;
    }
    const p = pointer(e);
    if (carrying) {
      if (e.pointerId !== carrying.pointer) return;
      const t = carrying.tablet;
      if (carrying.turn) t.set({ yaw: t.pose.yaw + (p.x - carrying.last.x) * 0.01 });
      else {
        const ground = onTable(p);
        if (ground) t.set({ at: ground.add(carrying.offset) });
      }
      carrying = { ...carrying, last: p };
      return;
    }
    if (forwarding !== null) {
      if (e.pointerId !== forwarding) return;
      if (forwardingTablet) {
        const at = onTablet(forwardingTablet, p);
        if (at) sendToPage(e, "pointermove", at);
        return;
      }
      const at = onTable(p);
      if (at) sendToPage(e, "pointermove", floor.toBoard(at));
      return;
    }
    if (pointerId !== null && e.pointerId !== pointerId) return;
    router.pointerMove(p);
    // Hovering what is drawn on the table lights it up as on the page.
    if (pointerId === null) {
      const hit = world.hit(p);
      const over = hit ? tabletOf(hit.mesh) : null;
      const at = hit && over ? over.toBoard(hit.point) : hit && floor.holds(hit.mesh) ? floor.toBoard(hit.point) : null;
      if (at) sendToPage(e, "pointermove", at);
      else if (overPage) pageCanvas()?.dispatchEvent(new pageWindow.PointerEvent("pointerleave", { pointerId: e.pointerId, pointerType: e.pointerType }));
      overPage = at !== null;
    }
  };
  canvas.addEventListener("pointermove", move);
  const lift = (e: Press, cancel: boolean): void => {
    fingers.delete(e.pointerId);
    if (tabletPinch !== null) {
      if (fingers.size === 0) tabletPinch = null;
      return;
    }
    if (pinch !== null) {
      if (fingers.size === 0) pinch = null;
      return;
    }
    if (carrying && e.pointerId === carrying.pointer) {
      carrying = null;
      return;
    }
    if (e.pointerId === forwarding) {
      forwarding = null;
      const on = forwardingTablet;
      forwardingTablet = null;
      const at = on ? onTablet(on, pointer(e)) : (() => {
        const t = onTable(pointer(e));
        return t ? floor.toBoard(t) : null;
      })();
      if (at) sendToPage(e, cancel ? "pointercancel" : "pointerup", at);
      return;
    }
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (cancel) router.pointerCancel();
    else router.pointerUp(pointer(e));
  };
  canvas.addEventListener("pointerup", (e) => lift(e, false));
  canvas.addEventListener("pointercancel", (e) => lift(e, true));
  canvas.addEventListener("pointerleave", (e) => {
    if (pointerId === null) router.pointerLeave(pointer(e));
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      flight = null;
      const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? size.height : 1;
      // Over a tablet, the wheel goes to what is drawn there (the map, the stars, the rows), or else magnifies its face.
      const p = pointer(e);
      const hit = world.hit(p);
      const tablet = hit ? tabletOf(hit.mesh) : null;
      if (hit && tablet) {
        const at = tablet.toBoard(hit.point);
        if (at && !tablet.onBar(at) && page.wheel(at, e.deltaX * scale, e.deltaY * scale)) return;
        tablet.zoomAt(Math.exp(-e.deltaY * scale * 0.0015), tablet.face(hit.point));
        return;
      }
      zoom(Math.exp(e.deltaY * scale * 0.0012), pointer(e));
    },
    { passive: false },
  );

  // Keys: WASD or the arrows slide along the table the way the camera faces, Q and E turn, R and F tilt; Escape looks down, in 2D.
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (mode !== "3d") return;
    if (e.key === "Escape" && !moving) void focusTable(camera.target.clone());
    keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener("blur", () => keys.clear());
  const steer = (dt: number): void => {
    if (keys.size === 0 || mode !== "3d") return;
    const down = (...k: string[]): number => (k.some((x) => keys.has(x)) ? 1 : 0);
    const ahead = down("w", "ArrowUp") - down("s", "ArrowDown");
    const side = down("d", "ArrowRight") - down("a", "ArrowLeft");
    if (ahead || side) {
      flight = null;
      // Along the table, as the camera faces: speed grows with distance, so it's the same on screen near or far.
      const yaw = camera.alpha;
      const forward = new Vector3(-Math.cos(yaw), 0, -Math.sin(yaw));
      const right = new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
      const speed = camera.radius * 0.9 * dt;
      aim(camera.target.add(forward.scale(ahead * speed)).add(right.scale(side * speed)));
    }
    camera.alpha += (down("q") - down("e")) * 1.6 * dt;
    camera.beta = Math.max(0.05, Math.min(1.52, camera.beta + (down("f") - down("r")) * 1.2 * dt));
  };

  // Fly: two thumbsticks, the left floating the way the camera looks, up and down included, the right looking around from where it is.
  const sticks = thumbsticks(
    {
      move: (x, y, dt) => {
        flight = null;
        const forward = camera.target.subtract(camera.position).normalize();
        const right = Vector3.Cross(Vector3.Up(), forward).normalize();
        const speed = Math.max(2, camera.radius) * 1.2 * dt;
        const d = forward.scale(-y * speed).add(right.scale(x * speed));
        camera.position.addInPlace(d);
        camera.setTarget(camera.target.add(d));
      },
      look: (x, y, dt) => {
        flight = null;
        // Turning the head: the camera stays where it is and its target goes round it.
        const eye = camera.position.clone();
        const forward = camera.target.subtract(eye);
        const r = forward.length();
        const yaw = Math.atan2(forward.x, forward.z) + x * 1.8 * dt;
        let pitch = Math.asin(Math.max(-1, Math.min(1, forward.y / r))) - y * 1.2 * dt;
        pitch = Math.max(-1.45, Math.min(1.2, pitch));
        const to = eye.add(new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).scale(r));
        camera.setTarget(to);
        camera.setPosition(eye);
      },
    },
    { shown: false },
  );
  let flying = false;
  const fly = (on: boolean): void => {
    flying = on;
    sticks.show(on && mode === "3d");
    document.body.classList.toggle("flying", on && mode === "3d");
    options.fly.textContent = on ? "Stop flying" : "Fly";
    options.fly.setAttribute("aria-pressed", String(on));
  };
  options.fly.addEventListener("click", () => fly(!flying));


  const resize = (): void => {
    size.width = canvas.clientWidth || 1;
    size.height = canvas.clientHeight || 1;
    engine.resize();
  };
  window.addEventListener("resize", resize);
  resize();

  // 2D and 3D. In 2D the page is on top, live, and the room only runs its physics; the things show as footprints on the board.
  // The switch tilts between them: the 3D camera starts straight above the part of the board the page shows, at the size it shows it.
  let mode: "2d" | "3d" = options.start ?? "2d";
  let moving = false;
  const overhead = (): { target: Vector3; radius: number } => {
    const v = page.view();
    const r = stageRect();
    const k = Math.hypot(v.a, v.b) || 1;
    const center = { x: (r.width / 2 - v.e) / k, y: (r.height / 2 - v.f) / k };
    const meters = size.height / k / UNITS;
    return { target: floor.toRoom(center), radius: meters / 2 / Math.tan(camera.fov / 2) };
  };
  const SEEN = { alpha: -Math.PI / 2, beta: 0.0001 };
  /** Points the camera at a target, keeping its angles and distance (setTarget alone keeps its position instead). */
  const aim = (target: Vector3): void => camera.setTarget(target, false, false, true);
  type Pose = { alpha: number; beta: number; radius: number; target: Vector3 };
  const pose = (): Pose => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() });
  const glide = (to: Pose, ms: number): Promise<void> =>
    new Promise((done) => {
      const from = pose();
      // The shorter way round.
      let da = (to.alpha - from.alpha) % (2 * Math.PI);
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      const t0 = performance.now();
      const step = (): void => {
        const t = Math.min(1, (performance.now() - t0) / ms);
        const e = ease(t);
        aim(Vector3.Lerp(from.target, to.target, e));
        camera.alpha = from.alpha + da * e;
        camera.beta = from.beta + (to.beta - from.beta) * e;
        // Distance in log space, so a long way out and in feels even.
        camera.radius = Math.exp(Math.log(from.radius) + (Math.log(to.radius) - Math.log(from.radius)) * e);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      step();
    });
  const fade = (page2d: boolean): Promise<void> =>
    new Promise((done) => {
      frame.style.transition = "opacity 260ms ease";
      frame.style.opacity = page2d ? "1" : "0";
      setTimeout(done, 280);
    });
  const show = (m: "2d" | "3d"): void => {
    mode = m;
    frame.style.pointerEvents = m === "2d" ? "auto" : "none";
    canvas.style.visibility = m === "3d" ? "visible" : "hidden";
    toggle.textContent = m === "2d" ? "View in 3D" : "Look from above";
    sticks.show(flying && m === "3d");
    document.body.classList.toggle("flying", flying && m === "3d");
    if (m === "2d" && options.head?.getAttribute("aria-pressed") === "true") options.head.click();
    options.onMode?.(m);
  };
  const footprints = (): FloorThing[] =>
    [...things.entries()].map(([id, t]) => {
      const at = floor.toBoard(t.mesh.getAbsolutePosition());
      const angle = t.mesh.rotationQuaternion?.toEulerAngles().y ?? t.mesh.rotation.y;
      return { id, kind: id.startsWith("ball") ? "ball" : "crate", x: at.x, y: at.y, angle, size: (id.startsWith("ball") ? 0.6 : 0.7) * UNITS, color: (t.mesh.material as StandardMaterial).diffuseColor.toHexString() };
    });
  const to3d = async (): Promise<void> => {
    moving = true;
    page.footprints(null);
    const { target, radius } = overhead();
    aim(target);
    camera.alpha = SEEN.alpha;
    camera.beta = SEEN.beta;
    camera.radius = radius;
    floor.drawNow();
    show("3d");
    frame.style.opacity = "1";
    scene.render();
    await fade(false);
    await glide({ alpha: SEEN.alpha - 0.35, beta: 1.0, radius: Math.min(radius, 9), target }, 1400);
    pinAt(target);
    moving = false;
  };
  /**
   * Looks straight down on a point of the table and hands over to the page, in 2D: the page's view is set to show the
   * board there at the size the camera shows it, so the fade has nothing to jump. From as far as the camera is now, within reason.
   */
  const focusTable = async (at: Vector3): Promise<void> => {
    if (moving || mode !== "3d") return;
    moving = true;
    // Tablets lie back down where they stand, so the page shows their windows there.
    await Promise.all([...tablets.values()].map((t) => layDown(t, 400)));
    flight = null;
    at.y = 0;
    const radius = Math.max(2, Math.min(40, camera.radius));
    await glide({ ...SEEN, radius, target: at }, 1100);
    const r = stageRect();
    const k = size.height / (2 * radius * Math.tan(camera.fov / 2) * UNITS);
    const b = floor.toBoard(at);
    page.setView({ a: k, b: 0, c: 0, d: k, e: r.width / 2 - k * b.x, f: r.height / 2 - k * b.y });
    page.footprints(footprints());
    await fade(true);
    show("2d");
    moving = false;
  };
  toggle.addEventListener("click", () => {
    if (moving) return;
    void (mode === "2d" ? to3d() : focusTable(camera.target.clone()));
  });
  // A footprint dragged on the board drags its thing along the floor.
  page.onFootprint = (id, phase, point) => {
    const thing = things.get(id);
    if (!thing) return;
    if (phase === "end") {
      held = null;
      return;
    }
    const at = floor.toRoom(point);
    at.y = id.startsWith("ball") ? 0.3 : 0.35;
    if (phase === "start") held = { thing, normal: Vector3.Up(), offset: Vector3.Zero(), target: at };
    else if (held) held.target = at;
  };

  const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const velocity = new Vector3();
  /** What happens each frame in either mode: flights, the held body, things that fell off, and in 2D the footprints. */
  let last = performance.now();
  const fallen = new Map<string, number>();
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!options.ar) { steer(dt); sticks.apply(dt); }
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.t0) / 700);
      aim(Vector3.Lerp(flight.from, flight.to, ease(t)));
      camera.radius = flight.r0 + (flight.r1 - flight.r0) * ease(t);
      if (t >= 1) flight = null;
    }
    // The held body is pulled toward the pointer each frame, so it's thrown with the speed it had when let go.
    for (const h of held ? [held, ...handHolds.values()] : handHolds.values()) {
      const center = h.thing.mesh.getAbsolutePosition();
      h.target.add(h.offset).subtractToRef(center, velocity);
      velocity.scaleInPlace(12);
      if (velocity.length() > 18) velocity.normalize().scaleInPlace(18);
      h.thing.body.body.setLinearVelocity(velocity);
      h.thing.body.body.setAngularVelocity(Vector3.Zero());
    }
    // What rolled off the table lies on the room's floor a moment, then comes back, dropped onto the table from above.
    for (const [id, t] of things) {
      if (t.mesh.position.y > -TABLE.height * 0.5 && t.mesh.position.y > -30) {
        fallen.delete(id);
        continue;
      }
      if (held?.thing === t) held = null;
      for (const [k, h] of handHolds) if (h.thing === t) handHolds.delete(k);
      const since = fallen.get(id) ?? now;
      fallen.set(id, since);
      if (now - since < 1500 && t.mesh.position.y > -30) continue;
      fallen.delete(id);
      t.body.body.disablePreStep = false;
      t.mesh.position.set((Math.random() - 0.5) * 2, 4, (Math.random() - 0.5) * 2);
      t.body.body.setLinearVelocity(Vector3.Zero());
      t.body.body.setAngularVelocity(Vector3.Zero());
      scene.onAfterPhysicsObservable.addOnce(() => (t.body.body.disablePreStep = true));
      log(`${id} fell off the table and came back`);
    }
    if (mode === "2d" && !moving) page.footprints(footprints());
  };
  // Looking through the screen as through a window, from where the viewer's eye is. The navigation camera still decides
  // what the window looks onto; a camera of its own stands at the eye and looks through the window's edges.
  const viewerCamera = new FreeCamera("viewer", camera.position.clone(), scene);
  let eyeWanted: Eye | null = null;
  let eyeShown: Eye | null = null;
  let eyeSince = 0;
  const screenSize = (): { width: number; height: number } => screenMeters(canvas.clientWidth || 1, canvas.clientHeight || 1, matchMedia("(pointer: coarse)").matches);
  /** Where the eye has to be for the navigation camera's own view: on the axis, as far as its field of view says for this screen. */
  const nominalEye = (): Eye => ({ x: 0, y: 0, z: screenSize().height / 2 / Math.tan(camera.fov / 2) });
  const viewer = {
    get screen() {
      return screenSize();
    },
    update(eye: Eye | null): void {
      eyeWanted = eye;
      if (eye) eyeSince = performance.now();
      if (eye && !eyeShown) eyeShown = nominalEye();
    },
  };
  const placeViewer = (dt: number): void => {
    // A face lost for a moment keeps its place; lost for longer, the view eases back to the navigation's own.
    const lost = !eyeWanted && performance.now() - eyeSince > 600;
    if (!eyeShown || options.ar || mode !== "3d") {
      if (scene.activeCamera === viewerCamera) scene.activeCamera = camera;
      return;
    }
    const goal = eyeWanted ?? (lost ? nominalEye() : eyeShown);
    const k = 1 - Math.exp(-dt * 14);
    eyeShown = { x: eyeShown.x + (goal.x - eyeShown.x) * k, y: eyeShown.y + (goal.y - eyeShown.y) * k, z: eyeShown.z + (goal.z - eyeShown.z) * k };
    const target = camera.target;
    const forward = target.subtract(camera.position).normalize();
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();
    const up = Vector3.Cross(forward, right).normalize();
    const halfHeight = camera.radius * Math.tan(camera.fov / 2);
    const w = { center: target.clone(), right, up, forward, halfHeight, halfWidth: halfHeight * (size.width / size.height) };
    const far = camera.maxZ || 10000;
    const { position, projection } = throughWindow(eyeShown, screenSize(), w, camera.minZ, far);
    viewerCamera.position.copyFrom(position);
    viewerCamera.setTarget(position.add(forward));
    viewerCamera.minZ = camera.minZ;
    viewerCamera.maxZ = far;
    viewerCamera.freezeProjectionMatrix(projection);
    scene.activeCamera = viewerCamera;
    if (lost && Math.abs(eyeShown.x) + Math.abs(eyeShown.y) + Math.abs(eyeShown.z - goal.z) < 1e-3) {
      eyeShown = null;
      scene.activeCamera = camera;
    }
  };
  // The front camera, for "Look with your head".
  const headButton = options.head;
  const head = headButton
    ? new FaceTracker((eye) => {
        viewer.update(eye);
        const now = performance.now();
        if (eye && now - headLogged > 700) {
          headLogged = now;
          log(`eye ${Math.round(eye.z * 100)} cm from the screen, ${Math.round(Math.abs(eye.x) * 100)} cm ${eye.x < 0 ? "left" : "right"}, ${Math.round(Math.abs(eye.y) * 100)} cm ${eye.y < 0 ? "down" : "up"}`);
        }
      }, { fov: 63, camera: { x: 0, y: screenSize().height / 2 + 0.008 } })
    : null;
  let headLogged = 0;
  const headOn = async (on: boolean): Promise<void> => {
    if (!head || !headButton) return;
    if (!on) {
      head.stop();
      headButton.setAttribute("aria-pressed", "false");
      headButton.textContent = "Look with your head";
      return;
    }
    headButton.textContent = "Starting the camera…";
    try {
      head.options = { ...head.options, camera: { x: 0, y: screenSize().height / 2 + 0.008 } };
      await head.start();
      headButton.setAttribute("aria-pressed", "true");
      headButton.textContent = "Stop looking with your head";
      log("move your head: the screen is a window onto the table");
    } catch (error) {
      headButton.textContent = "Look with your head";
      log(`no front camera: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  headButton?.addEventListener("click", () => void headOn(!head?.active));
  let lastViewer = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    placeViewer(Math.min(0.1, (now - lastViewer) / 1000));
    lastViewer = now;
    if (pointerId === null && forwarding === null) router.refreshHover();
    world.draw();
    if (tablets.size > 0) {
      const open = page.windows();
      let moved = false;
      for (const t of [...tablets.values()]) {
        const w = open.find((x) => x.id === t.id);
        if (!w) {
          // Closed on the page: the tablet goes with it.
          tablets.delete(t.id);
          shadows.removeShadowCaster(t.slab);
          t.dispose();
          moved = true;
          continue;
        }
        if (w.x !== t.rect.x || w.y !== t.rect.y || w.width !== t.rect.width || w.height !== t.rect.height) moved = true;
        t.follow(w);
        t.draw();
      }
      if (moved) holes();
    }
    floor.draw();
    const pageCursor = overPage || forwarding !== null ? pageCanvas()?.style.cursor || null : null;
    canvas.style.cursor = pageCursor ?? panelUi.cursor ?? objects.cursor ?? "";
  });

  for (let i = 0; i < 5; i++) drop(i % 2 === 0 ? "crate" : "ball");
  show(mode);
  if (mode === "3d") {
    aim(new Vector3(0, 1.1, 0));
    floor.drawNow();
    frame.style.opacity = "0";
  }
  // Opened from the page's own View in 3D: the page shows where it was, then tilts down into the room.
  if (options.tilt && mode === "2d") setTimeout(() => void to3d(), 600);
  // Pointers that aren't the mouse's or a finger's on this canvas: a hand's, a test's. They go through the same handlers.
  const press = (phase: "down" | "move" | "up" | "cancel", at: Point, o: Partial<Press> = {}): void => {
    const r = canvas.getBoundingClientRect();
    const e: Press = {
      pointerId: 1, pointerType: "touch", button: 0, buttons: phase === "down" || phase === "move" ? 1 : 0,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, timeStamp: performance.now(),
      ...o, clientX: r.left + at.x, clientY: r.top + at.y,
    };
    if (phase === "down") down(e);
    else if (phase === "move") move(e);
    else lift(e, phase === "cancel");
  };
  const pressAt = (phase: "down" | "move" | "up" | "cancel", at: Vector3, o: Partial<Press> = {}): void => press(phase, onHost(at), o);
  // What a fingertip can touch: the table, each tablet's face, and the panel.
  const flat = (id: string, mesh: Mesh, width: number, height: number, axis: "y" | "z"): HandSurface => {
    const m = mesh.computeWorldMatrix(true);
    const inverse = m.clone().invert();
    const normal = Vector3.TransformNormal(axis === "y" ? Vector3.Up() : new Vector3(0, 0, -1), m).normalize();
    return {
      id, point: m.getTranslation(), normal,
      contains: (at, margin) => {
        const local = Vector3.TransformCoordinates(at, inverse);
        const sx = Vector3.TransformNormal(Vector3.Right(), m).length();
        const sv = Vector3.TransformNormal(axis === "y" ? Vector3.Forward() : Vector3.Up(), m).length();
        return Math.abs(local.x) * sx <= width / 2 + margin && Math.abs(axis === "y" ? local.z : local.y) * sv <= height / 2 + margin;
      },
    };
  };
  const surfaces = (): HandSurface[] => {
    const t = floor.table;
    const list: HandSurface[] = [];
    for (const tablet of tablets.values()) list.push(flat(`tablet:${tablet.id}`, tablet.screen, tablet.rect.width / UNITS, tablet.rect.height / UNITS, "y"));
    if (panel.isEnabled() && panel.isVisible) list.push(flat("panel", panel, 2.88, 1.8, "z"));
    list.push({
      id: "table", point: new Vector3(t.center.x, 0, t.center.z), normal: Vector3.Up(),
      contains: (at, margin) => Math.abs(at.x - t.center.x) <= t.width / 2 + margin && Math.abs(at.z - t.center.z) <= t.depth / 2 + margin,
    });
    return list;
  };
  const hands = new Hands(
    {
      scene,
      things: () => [...things].map(([id, t]) => ({ id, mesh: t.mesh })),
      surfaces,
      press: (phase, at, pointer, time, buttons) => pressAt(phase, at, { pointerId: pointer, pointerType: "touch", timeStamp: time, buttons }),
      hold: (pointer, id, at) => {
        const thing = id ? things.get(id) : undefined;
        if (!thing || !at) {
          handHolds.delete(pointer);
          return;
        }
        const was = handHolds.get(pointer);
        if (was?.thing === thing) was.target = at.clone();
        else handHolds.set(pointer, { thing, offset: thing.mesh.getAbsolutePosition().subtract(at), target: at.clone() });
      },
    },
    { metersPerUnit: 1, ...(options.hands ?? {}) },
  );
  const runtime: BabylonRuntime = {
    press, pressAt, hands, viewer, toCanvas: (at) => onHost(at),
    engine, scene, world, floor, panel, things, drop, resize, visible: !options.ar, events: [],
    controlAt: point => router.pick(onHost(point)).path.find(id=>handles.has(id))??null,
    pointer: (phase, point, target) => {
      const before=things.size,path=target==="panel"?router.pick(onHost(point)).path:[];
      if (target === "board") {
        sendToPage(new PointerEvent(`pointer${phase}`, { pointerId: 91, pointerType: "touch", button: 0, buttons: phase === "up" || phase === "cancel" ? 0 : 1 }), `pointer${phase}`, floor.toBoard(point));
      } else {
        const p = onHost(point);
        options.onEvent?.(`hand:${phase}:${router.pick(p).path.join(">")}`);
        if (phase === "down") router.pointerDown(p);
        else if (phase === "move") router.pointerMove(p);
        else if (phase === "up") router.pointerUp(p);
        else router.pointerCancel();
      }
      runtime.events.push({phase,surface:target,path,before,after:things.size});if(runtime.events.length>80)runtime.events.shift();
    },
  };
  if (options.ar) {
    floor.ground.isVisible = false;
    for (const mesh of scene.meshes) if (mesh.name.startsWith("table/leg")) mesh.isVisible = false;
    // The original control panel remains fully interactive, laid on the tabletop.
    panel.parent = null; panel.position.set(floor.table.center.x, 0.035, floor.table.center.z - floor.table.depth * 0.25);
    panel.rotation.x = Math.PI / 2;
    stand.setEnabled(false); back.physicsBody?.dispose(); pole.physicsBody?.dispose();
  }
  engine.runRenderLoop(() => {
    if (options.ar && !runtime.visible) return;
    tick();
    // In 2D nothing in the room is seen: it only steps its physics.
    if (mode === "3d" || moving) scene.render();
    else (scene as unknown as { _advancePhysicsEngineStep(ms: number): void })._advancePhysicsEngineStep(engine.getDeltaTime());
  });
  // For tests: where a mesh, or a point of the panel's drawing, is on the host.
  const onHost = (p: Vector3): { x: number; y: number } => {
    const q = Vector3.Project(p, Matrix.Identity(), scene.activeCamera!.getViewMatrix().multiply(scene.activeCamera!.getProjectionMatrix()), scene.activeCamera!.viewport.toGlobal(size.width, size.height));
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };
  (window as unknown as { canvasIrBabylon?: unknown }).canvasIrBabylon = {
    scene, camera, world, things, drop, hands, press, pressAt, handHolds, viewer, viewerCamera,
    at: (id: string) => onHost(things.get(id)!.mesh.getAbsolutePosition()),
    onBoard: (x: number, y: number) => onHost(floor.toRoom({ x, y })),
    floor,
    page,
    tablets,
    layDown: (id: string) => {
      const t = tablets.get(id);
      return t ? layDown(t) : Promise.resolve();
    },
    lift: (id: string) => {
      const w = page.windows().find((x) => x.id === id);
      if (w) liftWindow(w);
    },
    onPanel: (x: number, y: number) => onHost(Vector3.TransformCoordinates(new Vector3((x / W - 0.5) * 2.88, (0.5 - y / H) * 1.8, 0), panel.computeWorldMatrix(true))),
  };
  return runtime;
};
