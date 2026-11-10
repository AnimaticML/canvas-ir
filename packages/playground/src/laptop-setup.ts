// Setting up "Look with your head" on a model of the laptop: a small 3D laptop at its real proportions, with the screen
// as big as the diagonal says and as wide as this screen is, its lid open at the hinge's angle, and the webcam a dot on
// the bezel. Drag the lid to open or close it, drag the webcam where yours is, pick the size; drag elsewhere to look
// around the model. What it sets is what the window needs: the screen's size, the lid's angle, and where the webcam is.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

/** The laptop: its screen's diagonal in inches, how far the lid is open (degrees from the keyboard), and the webcam's place from the middle of the screen's top edge, in meters (x right, y up). */
export interface Laptop {
  diagonal: number;
  lid: number;
  camera: { x: number; y: number };
}

export const LAPTOP_DEFAULTS: Laptop = { diagonal: 14, lid: 110, camera: { x: 0, y: 0.008 } };

/** The bezel around the screen, in meters: the sides, the top (where the webcam is) and the chin over the hinge. */
const SIDE = 0.007;
const TOP = 0.013;
const CHIN = 0.018;
const LID = 0.006;
const BASE = 0.016;

/** The screen's size in meters from its diagonal and its shape. */
export const screenOf = (diagonal: number, aspect: number): { width: number; height: number } => {
  const d = diagonal * 0.0254;
  const height = d / Math.hypot(aspect, 1);
  return { width: height * aspect, height };
};

/** Opens the setup over the page; resolves with the laptop as set when Done is pressed, or null when it's closed without. */
export const setUpLaptop = (start: Laptop, aspect: number): Promise<Laptop | null> =>
  new Promise((resolve) => {
    const laptop: Laptop = { diagonal: start.diagonal, lid: start.lid, camera: { ...start.camera } };
    const overlay = document.createElement("div");
    overlay.className = "laptop-setup";
    overlay.innerHTML = `
      <div class="laptop-card" role="dialog" aria-label="Your laptop">
        <h2>Your laptop</h2>
        <p>Pick your screen's size. Drag the lid to open it as far as yours is, and drag the green dot to where your webcam is. Drag around the laptop to turn it.</p>
        <canvas></canvas>
        <div class="laptop-row">
          <label>Screen <input type="range" min="10" max="18" step="0.1"> <output></output></label>
          <label>Lid <input type="range" min="80" max="180" step="1"> <output></output></label>
        </div>
        <p class="laptop-camera"></p>
        <div class="laptop-row"><button type="button" data-cancel>Cancel</button><button type="button" data-done>Done</button></div>
      </div>`;
    document.body.append(overlay);
    const canvas = overlay.querySelector("canvas")!;
    const [sizeInput, lidInput] = Array.from(overlay.querySelectorAll("input")) as [HTMLInputElement, HTMLInputElement];
    const [sizeOut, lidOut] = Array.from(overlay.querySelectorAll("output")) as [HTMLOutputElement, HTMLOutputElement];
    const cameraText = overlay.querySelector(".laptop-camera")!;
    sizeInput.value = String(laptop.diagonal);
    lidInput.value = String(laptop.lid);

    const engine = new Engine(canvas, true, { stencil: false, antialias: true }, true);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.94, 0.95, 0.97, 1);
    const view = new ArcRotateCamera("laptop/view", -Math.PI / 2 - 0.6, 1.1, 0.75, new Vector3(0, 0.1, 0), scene);
    view.minZ = 0.01;
    view.lowerRadiusLimit = 0.3;
    view.upperRadiusLimit = 2;
    view.wheelDeltaPercentage = 0.01;
    view.attachControl(canvas, true);
    new HemisphericLight("laptop/light", new Vector3(0.3, 1, -0.5), scene).groundColor = new Color3(0.5, 0.5, 0.55);
    const material = (name: string, hex: string, emissive = false): StandardMaterial => {
      const m = new StandardMaterial(`laptop/${name}`, scene);
      m.diffuseColor = Color3.FromHexString(hex);
      m.specularColor = new Color3(0.15, 0.15, 0.15);
      if (emissive) m.emissiveColor = Color3.FromHexString(hex);
      return m;
    };
    const aluminium = material("body", "#9aa3ae");
    const black = material("bezel", "#1e293b");
    const glass = material("screen", "#1e3a8a", true);
    const webcamMaterial = material("webcam", "#22c55e", true);
    // The hinge runs along x at the back of the base; the lid turns around it.
    const hinge = new TransformNode("laptop/hinge", scene);
    const base = CreateBox("laptop/base", { size: 1 }, scene);
    base.material = aluminium;
    const lid = CreateBox("laptop/lid", { size: 1 }, scene);
    lid.material = black;
    lid.parent = hinge;
    const screen = CreatePlane("laptop/screen", { size: 1 }, scene);
    screen.material = glass;
    screen.parent = hinge;
    const webcam = CreateSphere("laptop/webcam", { diameter: 0.006, segments: 12 }, scene);
    webcam.material = webcamMaterial;
    webcam.parent = hinge;
    const keys = CreatePlane("laptop/keys", { size: 1 }, scene);
    keys.material = material("keys", "#475569");
    keys.rotation.x = Math.PI / 2;

    const place = (): void => {
      const s = screenOf(laptop.diagonal, aspect);
      const width = s.width + 2 * SIDE;
      const tall = s.height + TOP + CHIN;
      base.scaling.set(width, BASE, tall);
      base.position.set(0, BASE / 2, -tall / 2);
      keys.scaling.set(width * 0.85, tall * 0.5, 1);
      keys.position.set(0, BASE + 0.0005, -tall * 0.55);
      hinge.position.set(0, BASE, 0);
      // Open by `lid` degrees from the keyboard: at 90 it stands up, past it it leans back (away from the viewer, +z).
      hinge.rotation.x = ((laptop.lid - 90) * Math.PI) / 180;
      lid.scaling.set(width, tall, LID);
      lid.position.set(0, tall / 2, LID / 2);
      screen.scaling.set(s.width, s.height, 1);
      screen.position.set(0, CHIN + s.height / 2, -0.0003);
      const top = CHIN + s.height;
      laptop.camera.x = Math.max(-width / 2 + 0.004, Math.min(width / 2 - 0.004, laptop.camera.x));
      laptop.camera.y = Math.max(-s.height + 0.004, Math.min(TOP - 0.003, laptop.camera.y));
      webcam.position.set(laptop.camera.x, top + laptop.camera.y, -0.0015);
      sizeOut.textContent = `${laptop.diagonal.toFixed(1)}″`;
      lidOut.textContent = `${Math.round(laptop.lid)}°`;
      const cm = (m: number): string => (Math.abs(m) * 100).toFixed(1);
      cameraText.textContent = `Screen ${cm(s.width)} × ${cm(s.height)} cm. Webcam ${laptop.camera.x === 0 ? "centered" : `${cm(laptop.camera.x)} cm ${laptop.camera.x < 0 ? "left" : "right"} of center`}, ${cm(laptop.camera.y)} cm ${laptop.camera.y < 0 ? "below" : "above"} the screen's top edge.`;
    };
    place();

    // Dragging the lid opens it; dragging the webcam moves it over the lid.
    let drag: "lid" | "webcam" | null = null;
    const ray = (): { from: Vector3; dir: Vector3 } => {
      const r = scene.createPickingRay(scene.pointerX, scene.pointerY, null, view);
      return { from: r.origin, dir: r.direction };
    };
    const onPlane = (point: Vector3, normal: Vector3): Vector3 | null => {
      const { from, dir } = ray();
      const d = Vector3.Dot(dir, normal);
      if (Math.abs(d) < 1e-6) return null;
      const t = Vector3.Dot(point.subtract(from), normal) / d;
      return t > 0 ? from.add(dir.scale(t)) : null;
    };
    canvas.addEventListener("pointerdown", () => {
      const hit = scene.pick(scene.pointerX, scene.pointerY);
      drag = hit?.pickedMesh === webcam ? "webcam" : hit?.pickedMesh === lid || hit?.pickedMesh === screen ? "lid" : null;
      if (drag) view.detachControl();
    });
    canvas.addEventListener("pointermove", () => {
      if (drag === "lid") {
        // In the plane across the hinge: the lid points from the hinge to the pointer.
        const at = onPlane(hinge.getAbsolutePosition(), Vector3.Right());
        if (!at) return;
        const d = at.subtract(hinge.getAbsolutePosition());
        laptop.lid = Math.round(Math.max(80, Math.min(180, 90 + (Math.atan2(d.z, d.y) * 180) / Math.PI)));
        lidInput.value = String(Math.round(laptop.lid));
      } else if (drag === "webcam") {
        // Over the lid's face: its place in the lid's own coordinates.
        const m = hinge.computeWorldMatrix(true);
        const normal = Vector3.TransformNormal(new Vector3(0, 0, -1), m).normalize();
        const at = onPlane(Vector3.TransformCoordinates(Vector3.Zero(), m), normal);
        if (!at) return;
        const local = Vector3.TransformCoordinates(at, m.clone().invert());
        const s = screenOf(laptop.diagonal, aspect);
        laptop.camera = { x: Math.abs(local.x) < 0.003 ? 0 : local.x, y: local.y - (CHIN + s.height) };
      } else return;
      place();
    });
    const up = (): void => {
      if (drag) view.attachControl(canvas, true);
      drag = null;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    sizeInput.addEventListener("input", () => {
      laptop.diagonal = Number(sizeInput.value);
      place();
    });
    lidInput.addEventListener("input", () => {
      laptop.lid = Number(lidInput.value);
      place();
    });
    const resize = (): void => engine.resize();
    window.addEventListener("resize", resize);
    engine.runRenderLoop(() => scene.render());
    const close = (result: Laptop | null): void => {
      window.removeEventListener("resize", resize);
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("[data-done]")!.addEventListener("click", () => close(laptop));
    overlay.querySelector("[data-cancel]")!.addEventListener("click", () => close(null));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
    });
    (overlay.querySelector("[data-done]") as HTMLButtonElement).focus();
  });
