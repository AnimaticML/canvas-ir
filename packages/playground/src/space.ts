// The 3D page: a room in three.js with three shapes and a panel of controls
// drawn with CanvasIR, and one EventRouter for all of it. The panel's buttons,
// slider and swatches are components on a canvas texture; the cube wears a
// drawing on every face. A click on a drawn button bubbles from its op through
// the panel mesh to the stand that holds it, a click on a shape goes to the
// shape, and both reach the same "*" handlers.
import { Components, EventRouter, type ComponentHandle, type RecordingContext, type RouterEvent, type WheelInput } from "canvas-ir";
import { Surface, World } from "@canvas-ir/three";
import * as THREE from "three";

const PALETTE = ["#f97316", "#0ea5e9", "#8b5cf6", "#22c55e", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];
const SHAPES = ["cube", "ball", "ring"] as const;
type ShapeName = (typeof SHAPES)[number];
const W = 480;
const H = 300;
const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

export interface SpaceHost {
  readonly canvas: HTMLCanvasElement;
  /** Shows the last event's type and path. */
  readonly onEvent: (text: string) => void;
}

export const startSpace = (host: SpaceHost): void => {
  const { canvas } = host;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const root = new THREE.Scene();
  root.background = new THREE.Color("#dbe4ee");
  root.fog = new THREE.Fog("#dbe4ee", 12, 30);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  root.add(new THREE.HemisphereLight("#ffffff", "#94a3b8", 1.6));
  const sun = new THREE.DirectionalLight("#ffffff", 1.6);
  sun.position.set(3, 6, 4);
  root.add(sun);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({ color: "#eef2f7" }));
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);
  const grid = new THREE.GridHelper(28, 28, "#cbd5e1", "#dfe6ee");
  grid.position.y = 0.002;
  grid.userData["hit"] = false;
  root.add(grid);

  // The shapes: named, so they are hit by name. The cube's material takes its surface's texture.
  const shape = (name: ShapeName, geometry: THREE.BufferGeometry, color: string, x: number, z: number, y: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
    mesh.name = name;
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };
  const shapes: Record<ShapeName, THREE.Mesh> = {
    cube: shape("cube", new THREE.BoxGeometry(0.9, 0.9, 0.9), "#ffffff", -2.1, 1.2, 0.45),
    ball: shape("ball", new THREE.SphereGeometry(0.5, 48, 24), PALETTE[1]!, 0.1, 1.9, 0.5),
    ring: shape("ring", new THREE.TorusGeometry(0.42, 0.16, 24, 64), PALETTE[2]!, 2.2, 1.1, 0.62),
  };

  // The panel: a plane on a stand, its front a drawing, its back plain. The back is unnamed, so it is hit as the stand.
  const stand = new THREE.Group();
  stand.name = "stand";
  stand.position.set(0, 1.45, -1.2);
  root.add(stand);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.88, 1.8), new THREE.MeshBasicMaterial({ toneMapped: false }));
  panel.name = "panel";
  stand.add(panel);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(2.88, 1.8), new THREE.MeshStandardMaterial({ color: "#64748b" }));
  back.rotation.y = Math.PI;
  stand.add(back);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55), new THREE.MeshStandardMaterial({ color: "#64748b" }));
  pole.position.y = -1.18;
  stand.add(pole);

  const size = { width: 1, height: 1 };
  const world = new World({ root, camera, size: () => size });
  const router = new EventRouter(world, { dragThreshold: 4 });

  const panelSurface = world.add(new Surface({ version: 1, ops: [] }, { mesh: panel, width: W, height: H, pixelRatio: 2.5, background: "#f8fafc" }));
  const cubeSurface = world.add(new Surface({ version: 1, ops: [] }, { mesh: shapes.cube, width: 128, height: 128, pixelRatio: 2, background: null }));
  const panelUi = new Components(panelSurface.scene, router, { onChange: () => panelSurface.invalidate() });
  const cubeUi = new Components(cubeSurface.scene, router, { onChange: () => cubeSurface.invalidate() });

  // A component's handle, kept to redraw it when what it shows changes elsewhere.
  const handles = new Map<string, ComponentHandle<unknown>>();
  const keep = <S>(handle: ComponentHandle<S>): ComponentHandle<S> => (handles.set(handle.id, handle as ComponentHandle<unknown>), handle);
  const redraw = (...ids: string[]): void => ids.forEach((id) => handles.get(id)?.redraw());

  // What the controls change.
  const state = { spinning: true, speed: 0.4, selected: "ball" as ShapeName, last: "Click or drag anything" };
  const cubeColor = { value: PALETTE[0]! };

  const button = (id: string, x: number, width: number, label: () => string, onClick: () => void): void => {
    keep(panelUi.mount({
      id,
      state: {},
      cursor: "pointer",
      transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: 84 },
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
      on: { click: () => onClick() },
    }));
  };

  keep(
    panelUi.mount({
      id: "heading",
      state: {},
      draw: (ctx) => {
        ctx.fillStyle = "#0f172a";
        ctx.font = `700 22px ${FONT}`;
        ctx.textBaseline = "alphabetic";
        ctx.fillText("One router for 3D and 2D", 24, 40);
        ctx.fillStyle = "#475569";
        ctx.font = `13px ${FONT}`;
        ctx.fillText("Click a shape to pick it, drag shapes over the floor,", 24, 62);
        ctx.fillText("drag the panel's margin to turn it, the floor to look around.", 24, 78);
      },
    }),
  );
  button("spin", 24, 128, () => (state.spinning ? "Pause" : "Spin"), () => {
    state.spinning = !state.spinning;
    redraw("spin");
  });
  button("shuffle", 164, 148, () => "Shuffle colors", () => {
    for (const name of SHAPES) paint(name, PALETTE[Math.floor(Math.random() * PALETTE.length)]!);
  });
  button("home", 324, 132, () => "Reset view", () => {
    orbit.theta = 0.35;
    orbit.phi = 1.1;
    orbit.radius = 7.5;
    stand.rotation.set(0, 0, 0);
  });

  // The speed slider: its drags come in the drawing's units, wherever the panel is turned.
  const SLIDER = { x: 24, y: 150, width: 432 };
  const setSpeed = (e: RouterEvent, c: ComponentHandle<object>): void => {
    state.speed = Math.max(0, Math.min(1, (e.point.x - SLIDER.x) / SLIDER.width));
    c.redraw();
    e.stopPropagation();
  };
  keep(
    panelUi.mount({
      id: "speed",
      state: {},
      cursor: "ew-resize",
      meta: { role: "slider", label: "Speed", hitArea: true },
      draw: (ctx, _s, ui) => {
        ctx.fillStyle = "#334155";
        ctx.font = `600 13px ${FONT}`;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        ctx.fillText(`Speed ${Math.round(state.speed * 100)}%`, SLIDER.x, SLIDER.y - 6);
        ctx.fillStyle = "rgba(0,0,0,0)";
        ctx.fillRect(SLIDER.x - 10, SLIDER.y, SLIDER.width + 20, 26);
        ctx.fillStyle = "#e2e8f0";
        ctx.beginPath();
        ctx.roundRect(SLIDER.x, SLIDER.y + 10, SLIDER.width, 6, 3);
        ctx.fill();
        ctx.fillStyle = "#2563eb";
        ctx.beginPath();
        ctx.roundRect(SLIDER.x, SLIDER.y + 10, SLIDER.width * state.speed, 6, 3);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(SLIDER.x + SLIDER.width * state.speed, SLIDER.y + 13, ui.hovered || ui.pressed ? 11 : 9, 0, Math.PI * 2);
        ctx.fill();
      },
      on: { down: setSpeed, dragstart: setSpeed, drag: setSpeed },
    }),
  );

  // Swatches color the picked shape: the drawing changes the 3D scene.
  const SWATCH_Y = 214;
  keep(
    panelUi.mount({
      id: "picked",
      state: {},
      draw: (ctx) => {
        ctx.fillStyle = "#334155";
        ctx.font = `600 13px ${FONT}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(`Color the ${state.selected}:`, 24, SWATCH_Y);
      },
    }),
  );
  PALETTE.forEach((color, i) => {
    panelUi.mount({
      id: `swatch-${i}`,
      state: {},
      cursor: "pointer",
      meta: { role: "button", label: `Color ${color}` },
      transform: { a: 1, b: 0, c: 0, d: 1, e: 156 + i * 37, f: SWATCH_Y },
      draw: (ctx, _s, ui) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, ui.hovered ? 15 : 13, 0, Math.PI * 2);
        ctx.fill();
      },
      on: { click: () => paint(state.selected, color) },
    });
  });
  keep(
    panelUi.mount({
      id: "log",
      state: {},
      draw: (ctx) => {
        ctx.fillStyle = "#f1f5f9";
        ctx.beginPath();
        ctx.roundRect(16, 250, W - 32, 34, 8);
        ctx.fill();
        ctx.fillStyle = "#0f172a";
        ctx.font = `12px ui-monospace, Menlo, monospace`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(state.last, 26, 267, W - 52);
      },
    }),
  );

  // The cube's faces: one drawing on all six, its color and how often it was clicked, with a small button that resets the count.
  const cubeFace = keep(
    cubeUi.mount({
      id: "cube-face",
      state: { clicks: 0 },
      draw: (ctx: RecordingContext, s: { clicks: number }) => {
        ctx.fillStyle = cubeColor.value;
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 44px ${FONT}`;
        ctx.fillText(String(s.clicks), 64, 54);
        ctx.font = `600 13px ${FONT}`;
        ctx.fillText(s.clicks === 1 ? "click" : "clicks", 64, 86);
      },
    }),
  );
  cubeUi.mount({
    id: "cube-reset",
    state: {},
    cursor: "pointer",
    meta: { role: "button", label: "Reset the count" },
    transform: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 4 },
    draw: (ctx, _s, ui) => {
      ctx.fillStyle = ui.hovered ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(12, 12, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.translate(4, 4);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(4, 4);
      ctx.lineTo(12, 12);
      ctx.moveTo(12, 4);
      ctx.lineTo(4, 12);
      ctx.stroke();
    },
    // Kept from the cube, whose own click handler counts.
    on: {
      click: (e) => {
        e.stopPropagation();
        cubeFace.setState({ clicks: 0 });
      },
    },
  });

  const paint = (name: ShapeName, color: string): void => {
    if (name === "cube") {
      cubeColor.value = color;
      cubeFace.redraw();
    } else (shapes[name].material as THREE.MeshStandardMaterial).color.set(color);
  };
  const select = (name: ShapeName): void => {
    state.selected = name;
    for (const n of SHAPES) (shapes[n].material as THREE.MeshStandardMaterial).emissive.set(n === name ? "#334155" : "#000000");
    redraw("picked");
  };
  select("ball");

  // Every event, from either world, through one handler: the panel and the HUD show its path.
  for (const type of ["click", "dragstart"] as const) {
    router.on("*", type, (e) => {
      state.last = `${type}: ${e.path.length > 0 ? e.path.join(" › ") : "(floor)"}`;
      host.onEvent(state.last);
      redraw("log");
    });
  }
  // The shapes: a click picks and counts, a drag slides it over the floor.
  for (const name of SHAPES) {
    router.on(name, "click", () => {
      select(name);
      if (name === "cube") cubeFace.setState((s: { clicks: number }) => ({ clicks: s.clicks + 1 }));
    });
    let grip: THREE.Vector3 | null = null;
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const at = (e: RouterEvent): THREE.Vector3 | null => world.ray(e.screen).intersectPlane(ground, new THREE.Vector3());
    router.on(name, "dragstart", (e) => {
      ground.constant = -shapes[name].position.y;
      const p = at(e);
      grip = p ? p.sub(shapes[name].position) : null;
      select(name);
    });
    router.on(name, "drag", (e) => {
      const p = at(e);
      if (!p || !grip) return;
      const to = p.sub(grip);
      const r = Math.hypot(to.x, to.z);
      if (r > 9) to.multiplyScalar(9 / r);
      shapes[name].position.set(to.x, shapes[name].position.y, to.z);
    });
  }
  // The panel's margin, or its back, turns the stand; the floor turns the camera; the wheel moves it in and out.
  const orbit = { theta: 0.35, phi: 1.1, radius: 7.5 };
  router.on("stand", "drag", (e) => {
    stand.rotation.y += e.delta!.x * 0.008;
    e.stopPropagation();
  });
  router.on("*", "drag", (e) => {
    if (e.target !== null) return;
    orbit.theta -= e.delta!.x * 0.006;
    orbit.phi = Math.max(0.25, Math.min(1.45, orbit.phi - e.delta!.y * 0.006));
  });
  router.on("*", "wheel", (e) => {
    const dy = (e.input as WheelInput).deltaY;
    orbit.radius = Math.max(3, Math.min(16, orbit.radius * Math.exp(dy * 0.0015)));
  });

  // The host's input, in CSS pixels over the canvas.
  let pointerId: number | null = null;
  const pointer = (e: PointerEvent | WheelEvent) => ({ x: e.offsetX, y: e.offsetY, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  canvas.addEventListener("pointerdown", (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    router.pointerDown(pointer(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointerId === null || e.pointerId === pointerId) router.pointerMove(pointer(e));
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    router.pointerUp(pointer(e));
  });
  canvas.addEventListener("pointercancel", () => {
    pointerId = null;
    router.pointerCancel();
  });
  canvas.addEventListener("pointerleave", (e) => pointerId === null && router.pointerLeave(pointer(e)));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? size.height : 1;
      router.wheel({ ...pointer(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale });
    },
    { passive: false },
  );

  const resize = (): void => {
    size.width = canvas.clientWidth;
    size.height = canvas.clientHeight;
    renderer.setSize(size.width, size.height, false);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  let then = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - then) / 1000);
    then = now;
    if (state.spinning) {
      const turn = dt * state.speed * 2.5;
      shapes.cube.rotation.y += turn;
      shapes.ball.rotation.y += turn;
      shapes.ring.rotation.x += turn;
      shapes.ring.rotation.y += turn * 0.6;
    }
    const target = new THREE.Vector3(0, 0.9, 0);
    camera.position.setFromSphericalCoords(orbit.radius, orbit.phi, orbit.theta).add(target);
    camera.lookAt(target);
    root.updateMatrixWorld();
    // What is under a still pointer changes as things turn: hover follows.
    if (pointerId === null) router.refreshHover();
    const hovered = router.hoveredPath;
    canvas.style.cursor = panelUi.cursor ?? cubeUi.cursor ?? (hovered.some((id) => SHAPES.includes(id as ShapeName) || id === "stand") ? "grab" : "");
    world.draw();
    renderer.render(root, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
