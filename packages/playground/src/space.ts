// The 3D page: a room in three.js with three shapes and a panel of controls
// drawn with CanvasIR, and one EventRouter for all of it. The panel's buttons,
// slider and swatches are components on a canvas texture; the cube wears a
// drawing on every face. A click on a drawn button bubbles from its op through
// the panel mesh to the stand that holds it, a click on a shape goes to the
// shape, and both reach the same "*" handlers.
import { Components, EventRouter, type ComponentHandle, type RecordingContext, type RouterEvent, type WheelInput } from "canvas-ir";
import { Focus, type Region, Surface, World, fitRegion } from "@canvas-ir/three";
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

  // The panel: a plane on a stand, its front a drawing, its back plain. The back and the pole are unnamed, so they are hit as the stand.
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.88, 1.8), new THREE.MeshBasicMaterial({ toneMapped: false }));
  panel.name = "panel";
  const { stand, board } = easel(root, { name: "stand", x: 0, z: -1.2, yaw: 0, face: panel, legs: [0], height: 0.55, color: "#64748b" });

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
        ctx.fillText("Click a shape to pick it, drag it over the floor. Drag the", 24, 62);
        ctx.fillText("floor to look around. WASD walks, E or Space rises, Q or C sinks.", 24, 78);
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
    home();
    stand.rotation.set(0, 0, 0);
    board.rotation.set(0, 0, 0);
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
  // The panel's margin, or its back, turns the stand; the floor turns the camera; the wheel and the keys walk.
  const walker = { at: new THREE.Vector3(), yaw: 0, pitch: 0 };
  const home = (): void => {
    walker.at.setFromSphericalCoords(7.5, 1.1, 0.35).add(new THREE.Vector3(0, 0.9, 0));
    camera.position.copy(walker.at);
    camera.lookAt(-0.6, 1.1, -1);
    const look = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    walker.yaw = look.y;
    walker.pitch = look.x;
  };
  home();
  // A view to start from, as #view=x,y,z,yaw,pitch: a place to come back to, and how the page is checked up close.
  const start = /^#view=([-\d.,]+)$/.exec(location.hash)?.[1]?.split(",").map(Number);
  if (start?.length === 5 && start.every(Number.isFinite)) {
    walker.at.set(start[0]!, start[1]!, start[2]!);
    walker.yaw = start[3]!;
    walker.pitch = start[4]!;
  }
  // Sideways turns a stand, up and down tilts its board on the hinge at the top of its legs.
  const turnable = (name: string, stand: THREE.Object3D, board: THREE.Object3D): void => {
    router.on(name, "drag", (e) => {
      stand.rotation.y += e.delta!.x * 0.008;
      board.rotation.x = Math.max(-1.2, Math.min(1.2, board.rotation.x + e.delta!.y * 0.006));
      e.stopPropagation();
    });
  };
  turnable("stand", stand, board);
  router.on("*", "drag", (e) => {
    if (e.target !== null) return;
    walker.yaw += e.delta!.x * 0.004;
    walker.pitch = Math.max(-1.4, Math.min(1.4, walker.pitch + e.delta!.y * 0.004));
  });
  router.on("*", "wheel", (e) => {
    const dy = (e.input as WheelInput).deltaY;
    walker.at.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), -dy * 0.004);
    walker.at.y = Math.max(0.3, walker.at.y);
  });
  const held = new Set<string>();
  const MOVES: Record<string, [number, number, number]> = {
    KeyW: [0, 0, -1], ArrowUp: [0, 0, -1], KeyS: [0, 0, 1], ArrowDown: [0, 0, 1],
    KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0], KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
    KeyE: [0, 1, 0], Space: [0, 1, 0], PageUp: [0, 1, 0], KeyQ: [0, -1, 0], KeyC: [0, -1, 0], PageDown: [0, -1, 0],
  };
  // While the playground has the keyboard its keys go to it, in its own window; these come only while this page has it.
  window.addEventListener("keydown", (e) => {
    if (!MOVES[e.code] || e.ctrlKey || e.metaKey || e.altKey) return;
    held.add(e.code);
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => held.clear());
  const walk = (dt: number, fast: boolean): void => {
    if (held.size === 0) return;
    const step = new THREE.Vector3();
    for (const code of held) step.add(new THREE.Vector3(...MOVES[code]!));
    if (step.lengthSq() === 0) return;
    step.normalize().multiplyScalar(dt * (fast ? 7 : 3));
    walker.at.add(new THREE.Vector3(step.x, 0, step.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), walker.yaw));
    walker.at.y = Math.max(0.3, Math.min(12, walker.at.y + step.y));
  };
  let shift = false;
  window.addEventListener("keydown", (e) => (shift = e.shiftKey));
  window.addEventListener("keyup", (e) => (shift = e.shiftKey));

  const playground = showPlayground(root, world);
  turnable("screen-stand", playground.stand, playground.board);

  // The host's input, in CSS pixels over the canvas.
  let pointerId: number | null = null;
  const pointer = (e: PointerEvent | WheelEvent) => ({ x: e.offsetX, y: e.offsetY, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  // A press on the playground's screen keeps going to it until it's released, as the playground's own pointer capture would.
  let pressOnScreen = false;
  canvas.addEventListener("pointerdown", (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    pressOnScreen = playground.under(pointer(e));
    if (pressOnScreen) playground.forward(e, pointer(e));
    else playground.release();
    router.pointerDown(pointer(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointerId !== null && e.pointerId !== pointerId) return;
    if (pointerId !== null ? pressOnScreen : playground.under(pointer(e))) playground.forward(e, pointer(e));
    else playground.leave();
    router.pointerMove(pointer(e));
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (pressOnScreen) playground.forward(e, pointer(e));
    pressOnScreen = false;
    router.pointerUp(pointer(e));
  });
  canvas.addEventListener("pointercancel", (e) => {
    pointerId = null;
    if (pressOnScreen) playground.forward(e, pointer(e));
    pressOnScreen = false;
    router.pointerCancel();
  });
  canvas.addEventListener("pointerleave", (e) => {
    if (pointerId !== null) return;
    playground.leave();
    router.pointerLeave(pointer(e));
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Over the screen the wheel is the playground's: it zooms its board, or scrolls what scrolls there.
      if (playground.under(pointer(e))) return playground.forward(e, pointer(e));
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
    walk(dt, shift);
    camera.position.copy(walker.at);
    camera.rotation.set(walker.pitch, walker.yaw, 0, "YXZ");
    root.updateMatrixWorld();
    camera.updateMatrixWorld();
    // What is under a still pointer changes as things turn: hover follows.
    if (pointerId === null) router.refreshHover();
    const hovered = router.hoveredPath;
    canvas.style.cursor =
      (hovered[0] === "playground" ? playground.cursor() : null) ?? panelUi.cursor ?? cubeUi.cursor ?? (hovered.some((id) => SHAPES.includes(id as ShapeName) || id === "stand") ? "grab" : "");
    world.draw();
    playground.draw();
    renderer.render(root, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

/** The playground's page size on the screen, in CSS pixels: 16 by 10, as the screen is. */
const PAGE = { width: 1280, height: 800 };

/**
 * The whole playground on a big screen in the room: its page runs in a frame
 * of its own behind the 3D canvas, and its three canvases (the board, the
 * cards, the marks) are copied into the screen's texture whenever it draws.
 * Pointer and wheel input over the screen is sent to its board at the point
 * under the ray, and a press on it gives it the keyboard.
 */
const showPlayground = (root: THREE.Object3D, world: World) => {
  const geometry = new THREE.PlaneGeometry(4.8, 3);
  const shot = document.createElement("canvas");
  shot.width = PAGE.width;
  shot.height = PAGE.height;
  const sctx = shot.getContext("2d")!;
  sctx.fillStyle = "#f8fafc";
  sctx.fillRect(0, 0, shot.width, shot.height);
  sctx.fillStyle = "#475569";
  sctx.font = "600 40px system-ui, sans-serif";
  sctx.textAlign = "center";
  sctx.fillText("Loading the playground…", shot.width / 2, shot.height / 2);
  const texture = new THREE.CanvasTexture(shot);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const screen = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  screen.name = "playground";
  const { stand, board } = easel(root, { name: "screen-stand", x: -4.6, z: -3.6, yaw: 0.55, face: screen, legs: [-1.6, 1.6], height: 0.8, color: "#475569" });

  // The page, laid out at its size but covered by the 3D canvas, so the browser keeps running it.
  const frame = document.createElement("iframe");
  frame.src = "./index.html";
  frame.title = "The playground, shown on the screen";
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${PAGE.width}px`, height: `${PAGE.height}px`, border: "0", zIndex: "-1", pointerEvents: "none" });
  document.body.append(frame);
  let page: { win: Window & typeof globalThis; board: HTMLCanvasElement; layers: HTMLCanvasElement[] } | null = null;
  let dirty = false;
  let over = false;
  let background = "#ffffff";
  // Less than a CanvasIR surface's budget: the whole board redraws into it as things move.
  const focus = new Focus(world, screen, () => page?.board.getBoundingClientRect() ?? PAGE, { maxPixels: 4_194_304 });
  frame.addEventListener("load", () => {
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    const board = win?.document.getElementById("board") as HTMLCanvasElement | null;
    if (!win || !board) return;
    const layers = ["board", "cards", "overlay"].map((id) => win.document.getElementById(id) as HTMLCanvasElement).filter(Boolean);
    page = { win, board, layers };
    const behind = [board.parentElement, win.document.body, win.document.documentElement].map((e) => (e ? win.getComputedStyle(e).backgroundColor : ""));
    background = behind.find((c) => c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") ?? "#ffffff";
    // The page draws in its animation frames: each one marks the screen to copy again.
    const raf = win.requestAnimationFrame.bind(win);
    win.requestAnimationFrame = (callback) => raf((t) => (callback(t), (dirty = true)));
    dirty = true;
  });

  /** Where a host pixel lands on the page, in its client pixels, or null off the screen. */
  const at = (p: { x: number; y: number }) => {
    if (!page) return null;
    const r = page.board.getBoundingClientRect();
    const on = world.pointOn(screen, p, r.width, r.height);
    return on ? { clientX: r.left + on.x, clientY: r.top + on.y } : null;
  };
  return {
    stand,
    board,
    /** Whether the screen is what a host pixel shows. */
    under: (p: { x: number; y: number }): boolean => world.intersect(p)?.object === screen,
    /** Sends a pointer or wheel event to the page's board where the ray meets the screen. */
    forward: (e: PointerEvent | WheelEvent, p: { x: number; y: number }): void => {
      const to = at(p);
      if (!page || !to) return;
      const keys = { altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
      const common = { ...to, ...keys, button: e.button, buttons: e.buttons, bubbles: true, cancelable: true, composed: true, view: page.win };
      if (e instanceof WheelEvent) page.board.dispatchEvent(new page.win.WheelEvent("wheel", { ...common, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode }));
      else {
        if (e.type === "pointerdown") page.win.focus();
        page.board.dispatchEvent(new page.win.PointerEvent(e.type, { ...common, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: true }));
      }
      over = true;
      dirty = true;
    },
    /** The pointer went off the screen. */
    leave: (): void => {
      if (!over || !page) return;
      over = false;
      page.board.dispatchEvent(new page.win.PointerEvent("pointerleave", { pointerId: 1, pointerType: "mouse" }));
    },
    /** A press elsewhere in the room takes the keyboard back from the page. */
    release: (): void => {
      if (document.activeElement === frame) frame.blur();
      window.focus();
    },
    cursor: (): string | null => page?.board.style.cursor || null,
    /** Copies the page's canvases into the screen, if it drew since the last time. */
    draw: (): void => {
      if (!page) return;
      // The page draws the part of itself in view, at the detail the view needs.
      const host = page.win as unknown as { canvasIrCapture?: (r: Region) => void; canvasIrDrawn?: Region };
      const wanted = focus.update();
      if (wanted) host.canvasIrCapture?.(wanted);
      if (!dirty) return;
      dirty = false;
      const { board, layers } = page;
      if (shot.width !== board.width || shot.height !== board.height) {
        shot.width = board.width;
        shot.height = board.height;
        texture.dispose();
      }
      const rect = board.getBoundingClientRect();
      if (host.canvasIrDrawn) fitRegion(texture, host.canvasIrDrawn, rect.width, rect.height);
      // The board's canvas is transparent over the page's own background.
      sctx.fillStyle = background;
      sctx.fillRect(0, 0, shot.width, shot.height);
      for (const layer of layers) if (layer.width > 0) sctx.drawImage(layer, 0, 0);
      texture.needsUpdate = true;
    },
  };
};

/**
 * A board on legs: the stand stands on the floor and turns, and the board,
 * the face and a plain back, tilts on a hinge at the top of the legs.
 */
const easel = (
  root: THREE.Object3D,
  o: { name: string; x: number; z: number; yaw: number; face: THREE.Mesh; legs: number[]; height: number; color: string },
): { stand: THREE.Group; board: THREE.Group } => {
  const material = new THREE.MeshStandardMaterial({ color: o.color });
  const stand = new THREE.Group();
  stand.name = o.name;
  stand.position.set(o.x, 0, o.z);
  stand.rotation.y = o.yaw;
  root.add(stand);
  for (const x of o.legs) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, o.height + 0.1), material);
    leg.position.set(x, (o.height + 0.1) / 2, 0);
    stand.add(leg);
  }
  const board = new THREE.Group();
  board.position.y = o.height;
  stand.add(board);
  const { height } = (o.face.geometry as THREE.PlaneGeometry).parameters;
  o.face.position.y = height / 2;
  const back = new THREE.Mesh(o.face.geometry, material);
  back.rotation.y = Math.PI;
  back.position.y = height / 2;
  board.add(o.face, back);
  return { stand, board };
};
