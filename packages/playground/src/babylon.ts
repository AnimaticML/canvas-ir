// The Babylon page: crates and balls under Havok physics in a Babylon.js
// scene, with CanvasIR drawings on a panel of controls and on every crate,
// and one EventRouter for the meshes and the drawings. The crates and balls
// are Objects, the same 3D components the three.js page uses: they light up
// under the pointer, and a drag picks one up and throws it.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
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
import { type ComponentHandle, Components, EventRouter, type RouterEvent } from "canvas-ir";

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";
const PALETTE = ["#f97316", "#0ea5e9", "#8b5cf6", "#10b981", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];
const W = 480;
const H = 300;

interface Thing {
  readonly mesh: Mesh;
  readonly body: PhysicsAggregate;
  readonly handle: ObjectHandle<{ bumps: number }>;
  readonly label: { readonly surface: Surface; readonly ui: Components } | undefined;
}

export const startBabylon = async (options: { canvas: HTMLCanvasElement; onEvent?: (text: string) => void }): Promise<void> => {
  const { canvas } = options;
  const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
  engine.setHardwareScalingLevel(1 / Math.min(2, window.devicePixelRatio || 1));
  const scene = new BabylonScene(engine);
  scene.clearColor = new Color4(0.86, 0.89, 0.93, 1);
  const hk = await HavokPhysics({ locateFile: () => havokWasm });
  const gravity = new Vector3(0, -9.81, 0);
  scene.enablePhysics(gravity, new HavokPlugin(true, hk));

  const camera = new ArcRotateCamera("camera", -Math.PI / 2 - 0.35, 1.12, 8, new Vector3(0, 1.1, 0), scene);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 30;
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

  const ground = CreateGround("ground", { width: 160, height: 160 }, scene);
  const groundMaterial = new StandardMaterial("ground", scene);
  groundMaterial.diffuseColor = Color3.FromHexString("#e8edf3");
  groundMaterial.specularColor = Color3.Black();
  ground.material = groundMaterial;
  ground.receiveShadows = true;
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, restitution: 0.4, friction: 0.7 }, scene);

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
  const things = new Map<string, Thing>();
  let count = 0;
  let held: { thing: Thing; normal: Vector3; offset: Vector3; target: Vector3 } | null = null;
  const drop = (kind: "crate" | "ball"): void => {
    const n = ++count;
    const id = `${kind}-${n}`;
    const color = PALETTE[n % PALETTE.length]!;
    const mesh = kind === "crate" ? CreateBox(id, { size: 0.7, wrap: true }, scene) : CreateSphere(id, { diameter: 0.6, segments: 24 }, scene);
    mesh.position.set((Math.random() - 0.5) * 3, 4 + Math.random() * 2, (Math.random() - 0.5) * 2 - 0.5);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    const material = new StandardMaterial(id, scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    mesh.material = material;
    shadows.addShadowCaster(mesh);
    const body = new PhysicsAggregate(mesh, kind === "crate" ? PhysicsShapeType.BOX : PhysicsShapeType.SPHERE, { mass: kind === "crate" ? 1 : 0.6, restitution: state.bounce, friction: 0.6 }, scene);
    body.body.setAngularDamping(0.3);
    // A crate wears a drawing on each face: its number and how many times it was knocked hard, redrawn when that changes.
    let label: Thing["label"];
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
    const thing: Thing = { mesh, body, handle, label };
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
      ctx.fillText("Drag a crate or a ball to pick it up and throw it. Double-click", 24, 62);
      ctx.fillText("one to look at it; drag the floor to look around.", 24, 78);
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

  // The camera: a drag on the floor or the sky looks around, the wheel or a pinch comes closer, and a double click looks at what it hit.
  let flight: { from: Vector3; to: Vector3; r0: number; r1: number; t0: number } | null = null;
  const lookAt = (mesh: AbstractMesh): void => {
    flight = { from: camera.target.clone(), to: mesh.getAbsolutePosition().clone(), r0: camera.radius, r1: Math.max(camera.lowerRadiusLimit ?? 2, 3), t0: performance.now() };
  };
  let lastClick = { at: 0, target: "" };
  router.on("*", "click", (e) => {
    const target = e.path.find((id) => things.has(id) || id === "stand") ?? "";
    const now = performance.now();
    if (target && target === lastClick.target && now - lastClick.at < 350) {
      lookAt(target === "stand" ? panel : things.get(target)!.mesh);
      lastClick = { at: 0, target: "" };
      return;
    }
    lastClick = { at: now, target };
    log(`click: ${e.path.join(" → ") || "nothing"}`);
  });
  let orbiting: { x: number; y: number } | null = null;
  router.on("*", "dragstart", (e) => {
    if (held || e.path.some((id) => id === "stand" || id === "panel")) return;
    orbiting = { x: (e.input as { x: number }).x, y: (e.input as { y: number }).y };
  });
  router.on("*", "drag", (e) => {
    if (!orbiting) return;
    const { x, y } = e.input as { x: number; y: number };
    camera.alpha -= (x - orbiting.x) * 0.006;
    camera.beta = Math.max(0.15, Math.min(1.5, camera.beta - (y - orbiting.y) * 0.006));
    orbiting = { x, y };
  });
  router.on("*", "dragend", () => (orbiting = null));
  const zoom = (factor: number): void => {
    camera.radius = Math.max(camera.lowerRadiusLimit ?? 2, Math.min(camera.upperRadiusLimit ?? 30, camera.radius * factor));
  };

  // Pointer input: one pointer goes to the router; a second finger makes a pinch.
  const pointer = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  };
  const fingers = new Map<number, { x: number; y: number }>();
  let pinch: number | null = null;
  let pointerId: number | null = null;
  const spread = (): number => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") fingers.set(e.pointerId, pointer(e));
    if (fingers.size === 2) {
      if (pointerId !== null) router.pointerCancel();
      pointerId = null;
      held = null;
      orbiting = null;
      pinch = spread();
      return;
    }
    if (pinch !== null || pointerId !== null) return;
    pointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    router.pointerDown(pointer(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, pointer(e));
    if (pinch !== null && fingers.size === 2) {
      const now = spread();
      zoom(pinch / Math.max(1, now));
      pinch = now;
      return;
    }
    if (pointerId !== null && e.pointerId !== pointerId) return;
    router.pointerMove(pointer(e));
  });
  const lift = (e: PointerEvent, cancel: boolean): void => {
    fingers.delete(e.pointerId);
    if (pinch !== null) {
      if (fingers.size === 0) pinch = null;
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
      const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? size.height : 1;
      zoom(Math.exp(e.deltaY * scale * 0.0012));
    },
    { passive: false },
  );

  const resize = (): void => {
    size.width = canvas.clientWidth || 1;
    size.height = canvas.clientHeight || 1;
    engine.resize();
  };
  window.addEventListener("resize", resize);
  resize();

  const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const velocity = new Vector3();
  scene.onBeforeRenderObservable.add(() => {
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.t0) / 700);
      camera.setTarget(Vector3.Lerp(flight.from, flight.to, ease(t)));
      camera.radius = flight.r0 + (flight.r1 - flight.r0) * ease(t);
      if (t >= 1) flight = null;
    }
    // The held body is pulled toward the pointer each frame, so it's thrown with the speed it had when let go.
    if (held) {
      const center = held.thing.mesh.getAbsolutePosition();
      held.target.add(held.offset).subtractToRef(center, velocity);
      velocity.scaleInPlace(12);
      if (velocity.length() > 18) velocity.normalize().scaleInPlace(18);
      held.thing.body.body.setLinearVelocity(velocity);
      held.thing.body.body.setAngularVelocity(Vector3.Zero());
    }
    // What fell off the edge comes back from the sky.
    for (const t of things.values()) {
      if (t.mesh.position.y < -15) {
        t.body.body.disablePreStep = false;
        t.mesh.position.set(0, 6, 0);
        t.body.body.setLinearVelocity(Vector3.Zero());
        scene.onAfterPhysicsObservable.addOnce(() => (t.body.body.disablePreStep = true));
      }
    }
    if (pointerId === null) router.refreshHover();
    world.draw();
    canvas.style.cursor = panelUi.cursor ?? objects.cursor ?? "";
  });

  for (let i = 0; i < 5; i++) drop(i % 2 === 0 ? "crate" : "ball");
  engine.runRenderLoop(() => scene.render());
  // For tests: where a mesh, or a point of the panel's drawing, is on the host.
  const onHost = (p: Vector3): { x: number; y: number } => {
    const q = Vector3.Project(p, Matrix.Identity(), camera.getViewMatrix().multiply(camera.getProjectionMatrix()), camera.viewport.toGlobal(size.width, size.height));
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };
  (window as unknown as { canvasIrBabylon?: unknown }).canvasIrBabylon = {
    scene, camera, world, things, drop,
    at: (id: string) => onHost(things.get(id)!.mesh.getAbsolutePosition()),
    onPanel: (x: number, y: number) => onHost(Vector3.TransformCoordinates(new Vector3((x / W - 0.5) * 2.88, (0.5 - y / H) * 1.8, 0), panel.computeWorldMatrix(true))),
  };
};
