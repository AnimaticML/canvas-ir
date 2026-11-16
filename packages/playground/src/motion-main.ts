// The motion lab: a camera or a take on the left with what the tracker found drawn over it, the solved body as a
// mannequin in the middle, and on the right what the solver knows: each part's source, the person's proportions, the
// hands, and how a compared take differs. Takes are recorded from the camera, saved and opened again, replayed and
// scrubbed on the timeline, and solved again whenever a setting changes, so one take can be tried many ways.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import "@babylonjs/core/Culling/ray";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { Scene } from "@babylonjs/core/scene";
import { Surface } from "@canvas-ir/babylon";
import { Components, EventRouter } from "canvas-ir";
import {
  BONES, BONE_NAMES, type Body, type BoneName, type Frame, type JointName, SETUPS, type SetupId, type SolveOptions, Solver, type Take, type TakeLabel,
  boneDifference, coverage, duration, frameIndexAt, imageAt, jitter, labelsAt, lag, loadTake, saveTake, solveTake, v,
} from "@canvas-ir/motion";
import { Capture } from "./motion/capture";
import { Character, ROBOT } from "./motion/character";
import { Mannequin } from "./motion/mannequin";
import { Overlay, Timeline } from "./motion/views";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sourceSelect = $<HTMLSelectElement>("source");
const setupSelect = $<HTMLSelectElement>("setup");
const compareSelect = $<HTMLSelectElement>("compare");
const recordButton = $<HTMLButtonElement>("record");
const info = $<HTMLElement>("info");
const video = $<HTMLVideoElement>("video");
const cameraBox = $<HTMLElement>("camera");
const still = $<HTMLImageElement>("still");
const labelInput = $<HTMLInputElement>("label");

// The 3D view.
const canvas = $<HTMLCanvasElement>("scene");
const engine = new Engine(canvas, true, { stencil: true }, true);
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.93, 0.95, 0.97, 1);
new HemisphericLight("sky", new Vector3(0, 1, 0.3), scene).intensity = 0.8;
const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.6), scene);
sun.intensity = 0.5;
const orbit = new ArcRotateCamera("orbit", Math.PI / 2 + 0.5, 1.2, 4, new Vector3(0, 0, -2), scene);
orbit.lowerRadiusLimit = 0.5;
orbit.upperRadiusLimit = 15;
orbit.wheelDeltaPercentage = 0.02;
orbit.minZ = 0.02;
orbit.attachControl(canvas, true);
const seeing = new UniversalCamera("seeing", new Vector3(0, 0, 0), scene);
seeing.setTarget(new Vector3(0, 0, -1));
seeing.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
seeing.minZ = 0.02;
scene.activeCamera = orbit;

// The floor, a grid drawn with CanvasIR on a ground plane, and the camera as a small frustum at the origin.
const floor = CreateGround("floor", { width: 8, height: 8 }, scene);
floor.isPickable = false;
const floorSurface = new Surface({ version: 1, ops: [] }, { mesh: floor, width: 1024, height: 1024, background: "#f8fafc", unlit: false });
new Components(floorSurface.scene, new EventRouter(floorSurface.scene), { onChange: () => floorSurface.invalidate() }).mount({
  id: "grid",
  state: {},
  draw: (ctx) => {
    // A line every 25 cm, darker every meter.
    for (let i = 0; i <= 32; i++) {
      const at = (i / 32) * 1024;
      ctx.strokeStyle = i % 4 === 0 ? "#94a3b8" : "#e2e8f0";
      ctx.lineWidth = i % 4 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at, 1024);
      ctx.moveTo(0, at);
      ctx.lineTo(1024, at);
      ctx.stroke();
    }
  },
});
floorSurface.draw();
let frustum = CreateLines("camera", { points: [] }, scene);
const drawFrustum = (fov: number, aspect: number): void => {
  frustum.dispose();
  const d = 0.25;
  const w = d * Math.tan((fov * Math.PI) / 360);
  const h = w * aspect;
  const o = new Vector3(0, 0, 0);
  const c = [new Vector3(-w, h, -d), new Vector3(w, h, -d), new Vector3(w, -h, -d), new Vector3(-w, -h, -d)];
  frustum = CreateLines("camera", { points: [o, c[0]!, c[1]!, o, c[2]!, c[3]!, o, c[0]!, c[3]!, c[2]!, c[1]!] }, scene);
  frustum.color = new Color3(0.1, 0.1, 0.2);
  frustum.isPickable = false;
};

const mannequin = new Mannequin(scene, "a");
// The robot, driven by the same body; it loads in a moment.
let character: Character | null = null;
Character.load(scene, ROBOT).then(
  (c) => (character = c),
  (e) => console.error("the character didn't load", e),
);
let showing = "robot" as "robot" | "rods" | "both";
const ghost = new Mannequin(scene, "b", { ghost: "#7c3aed" });
ghost.setEnabled(false);

// State.
type ViewName = "orbit" | "behind" | "side" | "camera";
const state = {
  take: null as Take | null,
  bodies: [] as Body[],
  videoUrl: null as string | null,
  videoBlob: null as Blob | null,
  takeB: null as Take | null,
  bodiesB: [] as Body[],
  live: false,
  recording: null as Frame[] | null,
  t: 0,
  playing: true,
  selected: null as JointName | null,
  view: "orbit" as ViewName,
  inferMs: 0,
  liveBody: null as Body | null,
  liveFrame: null as Frame | null,
  /** Labels said while recording, before the take exists. */
  recLabels: [] as TakeLabel[],
};

const options = (): SolveOptions => {
  const height = Number(($<HTMLInputElement>("height")).value);
  return {
    setup: setupSelect.value as SetupId,
    ...(height > 0 ? { height } : {}),
    filter: $<HTMLInputElement>("smooth").checked ? { minCutoff: Number($<HTMLInputElement>("minCutoff").value), beta: Number($<HTMLInputElement>("beta").value), dCutoff: 1 } : false,
    hold: Number($<HTMLInputElement>("hold").value),
  };
};
let liveSolver = new Solver(options());

/** Solves the take (and the compared one) again with the settings as they are. */
const resolve = (): void => {
  for (const id of ["minCutoff", "beta", "hold"]) $<HTMLOutputElement>(`${id}Out`).textContent = $<HTMLInputElement>(id).value;
  liveSolver = new Solver(options());
  if (state.take) {
    state.bodies = solveTake(state.take, options());
    timeline.setTake(state.bodies, duration(state.take), state.take.labels ?? []);
  }
  const compare = compareSelect.value;
  if (compare === "raw" && state.take) {
    state.takeB = state.take;
    state.bodiesB = solveTake(state.take, { ...options(), filter: false });
  } else if (compare === "file" && state.takeB) state.bodiesB = solveTake(state.takeB, { ...options(), setup: state.takeB.setup });
  else {
    state.takeB = null;
    state.bodiesB = [];
  }
  ghost.setEnabled(!!state.takeB);
  stats = null;
};

// The 2D views.
const overlay = new Overlay($<HTMLCanvasElement>("overlay"), (joint) => select(joint));
const timeline = new Timeline($<HTMLCanvasElement>("timeline"), {
  seek: (t) => {
    if (state.live) return;
    state.t = t;
    state.playing = false;
    timeline.setPlaying(false);
    if (state.videoUrl) {
      video.pause();
      video.currentTime = t / 1000;
    }
  },
  toggle: () => togglePlay(),
});
const togglePlay = (): void => {
  if (state.live || !state.take) return;
  state.playing = !state.playing;
  if (state.playing && state.t >= duration(state.take)) state.t = 0;
  timeline.setPlaying(state.playing);
  if (state.videoUrl) {
    video.currentTime = state.t / 1000;
    if (state.playing) void video.play();
    else video.pause();
  }
};
const select = (joint: JointName | null): void => {
  state.selected = joint;
  overlay.show({ selected: joint });
};

/** Opens a take for replay, with its video if there is one. */
const openTake = (take: Take, videoBlob: Blob | null = null): void => {
  stopLive();
  state.take = take;
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoBlob = videoBlob;
  state.videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : null;
  video.srcObject = null;
  if (state.videoUrl) {
    video.src = state.videoUrl;
    video.loop = false;
  } else video.removeAttribute("src");
  still.hidden = !!state.videoUrl || !take.images?.length;
  cameraBox.classList.toggle("mirrored", !!take.camera.mirrored);
  setupSelect.value = take.setup;
  state.t = 0;
  state.playing = true;
  timeline.setPlaying(true);
  if (state.videoUrl) void video.play().catch(() => undefined);
  overlay.show({ image: { width: take.camera.width, height: take.camera.height }, video: !!state.videoUrl, still: !still.hidden, visible: 0.5, mirrored: !!take.camera.mirrored });
  drawFrustum(take.camera.fov ?? SETUPS[take.setup].fov, take.camera.height / take.camera.width);
  resolve();
  aimViews();
};

// The camera.
const capture = new Capture(video, ({ frame, ms }) => {
  state.inferMs = state.inferMs * 0.9 + ms * 0.1;
  state.liveFrame = frame;
  state.liveBody = liveSolver.solve(frame, capture.camera());
  if (state.recording) {
    state.recording.push(frame);
    timeline.setRecording(state.recording.length, frame.t);
  }
});
const stopLive = (): void => {
  if (!state.live) return;
  state.live = false;
  capture.close();
  recordButton.disabled = true;
};
const startLive = async (facing: "user" | "environment"): Promise<void> => {
  state.live = true;
  state.take = null;
  state.playing = false;
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = null;
  video.removeAttribute("src");
  setupSelect.value = facing === "user" ? "desk" : "rear-person";
  resolve();
  timeline.setTake([], 0);
  try {
    await capture.open(facing);
  } catch (e) {
    state.live = false;
    info.innerHTML = `<h2>The camera didn't open</h2><p>${String((e as Error).message ?? e)}</p><p>Scripted takes and saved takes still work.</p>`;
    return;
  }
  liveSolver = new Solver(options());
  const cam = capture.camera();
  cameraBox.classList.toggle("mirrored", !!cam.mirrored);
  still.hidden = true;
  overlay.show({ image: { width: cam.width, height: cam.height }, video: true, still: false, labels: [], marks: [], mirrored: !!cam.mirrored });
  drawFrustum(SETUPS[setupSelect.value as SetupId].fov, cam.height / cam.width);
  recordButton.disabled = false;
  aimViews();
};

recordButton.addEventListener("click", async () => {
  if (!state.live) return;
  if (!state.recording) {
    state.recording = [];
    state.recLabels = [];
    timeline.setLabels([]);
    capture.record();
    liveSolver = new Solver(options());
    recordButton.textContent = "Stop";
    recordButton.classList.add("on");
    return;
  }
  const frames = state.recording;
  state.recording = null;
  recordButton.textContent = "Record";
  recordButton.classList.remove("on");
  timeline.setRecording(null);
  const blob = await capture.stopRecording();
  const images = capture.takeImages();
  const labels = state.recLabels;
  state.recLabels = [];
  const created = new Date().toISOString();
  const name = `take-${created.slice(0, 19).replace(/[:T]/g, "-")}`;
  const take: Take = {
    version: 1,
    name,
    setup: setupSelect.value as SetupId,
    camera: { ...capture.camera(), fov: SETUPS[setupSelect.value as SetupId].fov },
    created,
    ...(blob ? { video: `${name}.webm` } : {}),
    frames,
    images,
    labels,
  };
  sourceSelect.value = "replay";
  openTake(take, blob);
});

const download = (blob: Blob, name: string): void => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$<HTMLButtonElement>("save").addEventListener("click", () => {
  if (!state.take) return;
  download(new Blob([saveTake(state.take)], { type: "application/json" }), `${state.take.name.replace(/[^\w.-]+/g, "-")}.json`);
  if (state.videoBlob && state.take.video) download(state.videoBlob, state.take.video);
});
const files = $<HTMLInputElement>("files");
$<HTMLButtonElement>("open").addEventListener("click", () => files.click());
files.addEventListener("change", async () => {
  const list = Array.from(files.files ?? []);
  const json = list.find((f) => f.name.endsWith(".json"));
  const vid = list.find((f) => f.type.startsWith("video/"));
  if (!json) return;
  try {
    const take = loadTake(await json.text());
    sourceSelect.value = "replay";
    openTake(take, vid ?? null);
  } catch (e) {
    info.innerHTML = `<h2>That isn't a take</h2><p>${String((e as Error).message ?? e)}</p>`;
  }
  files.value = "";
});
const filesB = $<HTMLInputElement>("filesB");
compareSelect.addEventListener("change", () => {
  if (compareSelect.value === "file") filesB.click();
  else resolve();
});
filesB.addEventListener("change", async () => {
  const f = filesB.files?.[0];
  if (f) {
    try {
      state.takeB = loadTake(await f.text());
    } catch {
      compareSelect.value = "";
    }
  } else compareSelect.value = "";
  filesB.value = "";
  resolve();
});

// The sources: the scripted takes, the cameras, and the take being replayed.
sourceSelect.add(new Option("Choose…", ""));
if (navigator.mediaDevices && "getUserMedia" in navigator.mediaDevices) {
  sourceSelect.add(new Option("Camera, front", "camera:user"));
  sourceSelect.add(new Option("Camera, rear", "camera:environment"));
}
sourceSelect.add(new Option("The take being replayed", "replay"));
for (const s of Object.values(SETUPS)) setupSelect.add(new Option(s.label, s.id));
sourceSelect.addEventListener("change", () => {
  const value = sourceSelect.value;
  if (value.startsWith("camera:")) void startLive(value.slice(7) as "user" | "environment");
});
for (const id of ["setup", "smooth", "minCutoff", "beta", "hold", "height"]) $(id).addEventListener("input", () => resolve());

// The views of the 3D scene.
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".views button"));
const aimViews = (): void => {
  const at = currentRoot();
  orbit.target = new Vector3(at.x, at.y + 0.2, at.z);
  const view = state.view;
  if (view === "camera") {
    const take = state.take;
    seeing.fov = (((take?.camera.fov ?? SETUPS[setupSelect.value as SetupId].fov) * Math.PI) / 180);
    scene.activeCamera = seeing;
  } else {
    scene.activeCamera = orbit;
    if (view === "behind") orbit.alpha = -Math.PI / 2;
    if (view === "side") orbit.alpha = 0;
    if (view === "orbit") orbit.alpha = Math.PI / 2 + 0.6;
    orbit.beta = view === "orbit" ? 1.15 : 1.35;
    orbit.radius = 3.2;
  }
  // As the camera sees it, mirrored the same way the image is shown.
  canvas.style.transform = view === "camera" && cameraBox.classList.contains("mirrored") ? "scaleX(-1)" : "";
  for (const b of viewButtons) b.setAttribute("aria-pressed", String(b.dataset.view === view));
};
for (const b of viewButtons)
  b.addEventListener("click", () => {
    state.view = b.dataset.view as ViewName;
    aimViews();
  });
scene.onPointerObservable.add((p) => {
  if (p.type !== PointerEventTypes.POINTERTAP) return;
  const joint = mannequin.jointOf(p.pickInfo?.pickedMesh);
  select(joint);
});

/** Where the body is shown: where the camera put it, or straight ahead at the setup's distance. */
const currentRoot = (): { x: number; y: number; z: number } => {
  const body = currentBody();
  return body?.root ?? v(0, -0.3, -SETUPS[setupSelect.value as SetupId].distance);
};
const currentBody = (): Body | null => {
  if (state.live) return state.liveBody;
  if (!state.take || !state.bodies.length) return null;
  return state.bodies[frameIndexAt(state.take, state.t)] ?? null;
};
const currentFrame = (): Frame | null => (state.live ? state.liveFrame : state.take ? (state.take.frames[frameIndexAt(state.take, state.t)] ?? null) : null);

/** Where the floor is under a body: under its feet when they were seen, else where its stance says. */
let floorY = -1;
const floorUnder = (body: Body, root: { y: number }): number => {
  const feet = (["leftToe", "rightToe", "leftAnkle", "rightAnkle"] as const).filter((j) => body.joints[j].source === "seen");
  if (feet.length) return root.y + Math.min(...feet.map((j) => body.joints[j].p.y)) - 0.03;
  const p = body.proportions;
  return SETUPS[setupSelect.value as SetupId].stance === "seated" ? root.y - 0.5 : root.y - p.thigh - p.shin - 0.08;
};

// Stats over the whole take, computed once per solve.
let stats: { coverage: ReturnType<typeof coverage>; jitter: ReturnType<typeof jitter>; diff?: ReturnType<typeof boneDifference>; lag?: number } | null = null;
const takeStats = () => {
  if (stats || !state.bodies.length) return stats;
  stats = { coverage: coverage(state.bodies), jitter: jitter(state.bodies) };
  if (state.bodiesB.length) {
    stats.diff = boneDifference(state.bodies, state.bodiesB);
    stats.lag = lag(state.bodiesB, state.bodies, "rightWrist");
  }
  return stats;
};

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "–");
let lastInfo = 0;
const showInfo = (body: Body | null): void => {
  const now = performance.now();
  if (now - lastInfo < 120) return;
  lastInfo = now;
  const take = state.take;
  const parts: string[] = [];
  if (state.live) parts.push(`<h2>Live</h2><p>Trackers take ${fmt(state.inferMs, 0)} ms a frame${state.recording ? `, recording ${state.recording.length} frames` : ""}.</p>`);
  else if (take) parts.push(`<h2>${take.name}</h2><p>${SETUPS[take.setup].label}, ${take.frames.length} frames over ${fmt(duration(take) / 1000, 1)} s${take.notes ? `. ${take.notes}` : ""}</p>`);
  if (body) {
    const p = body.proportions;
    const height = p.torso + p.neck + p.thigh + p.shin + 0.2;
    parts.push(`<h2>Body</h2><p>About ${fmt(height)} m tall from what was seen${body.root ? `, ${fmt(-body.root.z)} m from the camera` : ""}.</p>`);
    const rows = (["head", "chest", "leftElbow", "leftWrist", "rightElbow", "rightWrist", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"] as JointName[])
      .map((j) => `<tr><td>${j}</td><td class="${body.joints[j].source}">${body.joints[j].source}</td></tr>`)
      .join("");
    parts.push(`<table>${rows}</table>`);
    for (const s of ["left", "right"] as const) {
      const h = body.hands[s];
      if (h) parts.push(`<p>${s} hand: pinch ${fmt(h.pinch)}${h.pinch < 0.35 ? " <b>pinched</b>" : ""}, index curl ${fmt(h.curl.index)}, fist ${fmt((h.curl.middle + h.curl.ring + h.curl.pinky) / 3)}</p>`);
    }
    if (state.selected) {
      const j = body.joints[state.selected];
      const bone = (BONE_NAMES as BoneName[]).find((b) => BONES[b][1] === state.selected);
      const r = bone ? body.rotations[bone] : null;
      parts.push(
        `<h2>${state.selected}</h2><p>${j.source}, confidence ${fmt(j.confidence)}<br>at ${fmt(j.p.x)}, ${fmt(j.p.y)}, ${fmt(j.p.z)} m from the hips` +
          (r ? `<br>${bone} turned ${fmt((2 * Math.acos(Math.min(1, Math.abs(r.w))) * 180) / Math.PI, 0)}° from rest` : "") + "</p>",
      );
    }
  }
  const st = !state.live ? takeStats() : null;
  if (st) {
    const seenParts = (["head", "chest", "leftWrist", "rightWrist", "leftAnkle"] as JointName[]).map((j) => `${j} ${fmt(st.coverage[j] * 100, 0)}%`).join(", ");
    parts.push(`<h2>Over the take</h2><p>Seen: ${seenParts}.<br>Shake at the wrists: ${fmt(st.jitter.leftWrist, 1)} and ${fmt(st.jitter.rightWrist, 1)} m/s².</p>`);
    if (st.diff) {
      const worst = (Object.entries(st.diff) as [BoneName, { mean: number }][]).filter(([, d]) => Number.isFinite(d.mean)).sort((a, b) => b[1].mean - a[1].mean).slice(0, 6);
      parts.push(
        `<h2>Against ${compareSelect.value === "raw" ? "unsmoothed" : (state.takeB?.name ?? "the other take")}</h2><p>Lags it by ${st.lag} frames at the right wrist.</p><table>${worst
          .map(([b, d]) => `<tr><td>${b}</td><td>${fmt(d.mean, 1)}°</td></tr>`)
          .join("")}</table>`,
      );
    }
  }
  const labels = takeLabels();
  if (labels?.length) {
    const m = (t: number) => `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, "0")}`;
    parts.push(`<h2>Doing</h2><table>${labels.map((l, i) => `<tr><td>${m(l.t0)}</td><td style="text-align:left">${l.by === "watcher" ? "👁 " : ""}${l.text.replace(/</g, "&lt;")}</td><td><button class="light x" data-unlabel="${i}" title="Remove">×</button></td></tr>`).join("")}</table>`);
  }
  if (!body && !state.live) parts.push("<p>Open the camera and press Record, or open a saved take. While recording, type what you are doing and press Enter: those labels go into the take, beside small pictures from the camera.</p>");
  info.innerHTML = parts.join("");
};

// Labels: what the person says they are doing, typed while recording or while replaying a take.
const takeLabels = (): TakeLabel[] | null => (state.recording ? state.recLabels : state.take && !state.live ? ((state.take as unknown as { labels?: TakeLabel[] }).labels ??= []) : null);
const labelTime = (): number => (state.recording ? (state.recording.at(-1)?.t ?? 0) : state.t);
labelInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const text = labelInput.value.trim();
  const labels = takeLabels();
  if (!text || !labels) return;
  labels.push({ t0: Math.round(labelTime()), text, by: "person" });
  labels.sort((a, b) => a.t0 - b.t0);
  labelInput.value = "";
  timeline.setLabels(labels);
  lastInfo = 0;
});
info.addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>("[data-unlabel]")?.dataset.unlabel;
  const labels = takeLabels();
  if (i === undefined || !labels) return;
  labels.splice(Number(i), 1);
  timeline.setLabels(labels);
  lastInfo = 0;
});
const figureButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".figures button"));
for (const b of figureButtons)
  b.addEventListener("click", () => {
    showing = b.dataset.figure as typeof showing;
    for (const o of figureButtons) o.setAttribute("aria-pressed", String(o === b));
  });

// Each frame: the clock, the mannequins, the overlay, the timeline.
let last = performance.now();
engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = now - last;
  last = now;
  if (!state.live && state.take && state.playing) {
    if (state.videoUrl && !video.paused) state.t = video.currentTime * 1000;
    else state.t += dt;
    const end = duration(state.take);
    if (state.t > end) {
      state.t = 0;
      if (state.videoUrl) {
        video.currentTime = 0;
        void video.play().catch(() => undefined);
      }
    }
  }
  const body = currentBody();
  const root = currentRoot();
  mannequin.show(showing === "robot" ? null : body, root);
  character?.show(showing === "rods" ? null : body, root);
  if (body) {
    const target = floorUnder(body, root);
    floorY = floorY === -1 ? target : floorY + (target - floorY) * Math.min(1, dt / 300);
    floor.position.set(root.x, floorY, root.z);
  }
  if (state.takeB && state.bodiesB.length) {
    const b = state.bodiesB[frameIndexAt(state.takeB, state.t)] ?? null;
    ghost.show(b, b?.root ?? root);
  }
  if (!state.live) timeline.setTime(state.t);
  const take = state.live ? null : state.take;
  if (take && !still.hidden) {
    const img = imageAt(take, state.t);
    if (img && still.getAttribute("src") !== img.src) still.src = img.src;
  }
  const marks = take?.marks?.filter((m) => m.t0 <= state.t && state.t <= (m.t1 ?? m.t0 + 1000)) ?? [];
  overlay.show({ frame: currentFrame(), labels: state.recording ? state.recLabels.slice(-1) : take ? labelsAt(take, state.t) : [], marks });
  showInfo(body);
  scene.render();
});
window.addEventListener("resize", () => engine.resize());
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  }
  if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && state.take) {
    const i = frameIndexAt(state.take, state.t) + (e.code === "ArrowLeft" ? -1 : 1);
    state.t = state.take.frames[Math.max(0, Math.min(state.take.frames.length - 1, i))]!.t;
    state.playing = false;
    timeline.setPlaying(false);
  }
});

sourceSelect.value = "";
drawFrustum(SETUPS.desk.fov, 9 / 16);

(window as unknown as { canvasIrMotion: unknown }).canvasIrMotion = { state, scene, openTake, resolve, select, mannequin, character: () => character };
