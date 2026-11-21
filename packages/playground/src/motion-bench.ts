// The motion bench: a rigged human posed by a scripted movement, rendered through a camera placed as a setup places
// it, and run through the real trackers and the solver. The movement's bones are known, so the solve is scored
// against the truth, bone by bone, for each camera setup: what the camera-only takes can't tell.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import {
  BONES, BONE_NAMES, type Body, type BoneName, type Frame, type JointName, SCRIPTS, SETUPS, type SetupId, type Take, type TakeImage,
  HAND_LINES, type Joints, POSE_LINES, type Quat, angleBetween, boneDifference, Correction, randomScript, boneFrames, coverage, saveTake, solveTake, synthesize,
} from "@canvas-ir/motion";
import { Character, mannequinSpec } from "./motion/character";
import { Trackers } from "./motion/capture";
import mannequinUrl from "./motion/mannequin.glb" with { type: "file" };
// Imported as a file, so the page fetches it only when it is used; TypeScript types it as the JSON regardless.
import correctionUrl from "./motion/correction.json" with { type: "file" };

const params = new URLSearchParams(location.search);
/** With ?correct, runs are solved with the learned correction of MediaPipe's points (see correct.ts in the motion package). */
const correction = params.has("correct") ? fetch(correctionUrl as unknown as string).then(async (r) => new Correction(await r.json())) : Promise.resolve(undefined);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("render");
const overlay = $<HTMLCanvasElement>("overlay");
const info = $<HTMLElement>("info");
const scriptSelect = $<HTMLSelectElement>("script");
const setupSelect = $<HTMLSelectElement>("setup");
const runButton = $<HTMLButtonElement>("run");
const allButton = $<HTMLButtonElement>("all");
const saveButton = $<HTMLButtonElement>("save");

for (const s of SCRIPTS) scriptSelect.add(new Option(s.name, s.name));
for (const n of [1, 2, 3]) scriptSelect.add(new Option(`Random ${n}`, `Random ${n}`));
setupSelect.add(new Option("The movement's own", ""));
for (const s of Object.values(SETUPS)) if (s.sees !== "hand") setupSelect.add(new Option(s.label, s.id));

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, antialias: true });
engine.setHardwareScalingLevel(1);
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.55, 0.58, 0.62, 1);
new HemisphericLight("sky", new Vector3(0.2, 1, 0.4), scene).intensity = 0.75;
const sun = new DirectionalLight("sun", new Vector3(-0.3, -0.8, -0.5), scene);
sun.intensity = 0.7;
// The camera sits at the origin looking down -z, as the motion package's camera space has it.
const camera = new FreeCamera("camera", new Vector3(0, 0, 0), scene);
camera.setTarget(new Vector3(0, 0, -1));
camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
camera.minZ = 0.02;

let character: Character | null = null;
let trackers: Trackers | null = null;
let last: { take: Take; summary: Summary } | null = null;

const loadModel = async (url: string): Promise<void> => {
  character?.setEnabled(false);
  character = await Character.load(scene, mannequinSpec(url));
  await scene.whenReadyAsync();
  solvedFigure?.setEnabled(false);
  truthFigure?.setEnabled(false);
  solvedFigure = await Character.load(replayScene, mannequinSpec(url));
  truthFigure = await Character.load(replayScene, mannequinSpec(url));
  truthFigure.tint(0.96, 0.62, 0.04, 0.35);
  solvedFigure.setEnabled(false);
  truthFigure.setEnabled(false);
  // ?cpu runs the trackers on the CPU, as a machine without a GPU must, so results repeat exactly.
  trackers ??= await Trackers.load(!params.has("cpu"), params.get("pose") === "heavy" ? "heavy" : "full");
  runButton.disabled = allButton.disabled = false;
  info.innerHTML =
    "<p>Ready. Each movement is played on the mannequin, rendered through the camera of a setup, tracked by MediaPipe and solved, and the solve is scored against the bones that were rendered. Pick a movement and a camera and run, or run them all.</p><p>Another model can be opened if its bones are named the same way: hips, spine, chest, neck, head, upper_arm.L, forearm.L, hand.L, thigh.L and so on.</p>";
};

export interface Summary {
  readonly script: string;
  readonly setup: SetupId;
  readonly frames: number;
  /** Frames where a body was found at all. */
  readonly found: number;
  /** Per bone: the mean angle to the truth over frames where its far end was seen, and the share seen. */
  readonly bones: Record<BoneName, { mean: number; max: number; seen: number; direction: number; twist: number }>;
  /** The same over every frame, held and assumed parts included. */
  readonly overall: number;
  readonly overallSeen: number;
  /** How far the posed character was from the script's bones: the bench's own error, which should be small. */
  readonly posing: number;
}

const drawLandmarks = (f: Frame): void => {
  const c = overlay.getContext("2d")!;
  const W = overlay.width;
  const H = overlay.height;
  c.clearRect(0, 0, W, H);
  c.lineCap = "round";
  const pts = f.pose?.image;
  if (pts) {
    for (const [a, b] of POSE_LINES) {
      const p = pts[a]!;
      const q = pts[b]!;
      const sure = Math.min(p.visibility ?? 1, q.visibility ?? 1) > 0.5;
      c.strokeStyle = sure ? "#22c55e" : "rgba(239, 68, 68, 0.6)";
      c.lineWidth = sure ? 3 : 1.5;
      c.beginPath();
      c.moveTo(p.x * W, p.y * H);
      c.lineTo(q.x * W, q.y * H);
      c.stroke();
    }
    c.fillStyle = "#f8fafc";
    for (const l of pts) if ((l.visibility ?? 1) > 0.5) c.fillRect(l.x * W - 2, l.y * H - 2, 4, 4);
  }
  for (const h of f.hands) {
    c.strokeStyle = h.side === "left" ? "#60a5fa" : "#f472b6";
    c.lineWidth = 1.5;
    for (const [a, b] of HAND_LINES) {
      c.beginPath();
      c.moveTo(h.image[a]!.x * W, h.image[a]!.y * H);
      c.lineTo(h.image[b]!.x * W, h.image[b]!.y * H);
      c.stroke();
    }
  }
};

// The replay: the run frame by frame, what the camera saw beside the mannequin re-animated from what was found and,
// see-through, the mannequin as it was played.
const replayCanvas = $<HTMLCanvasElement>("replay");
const picture = $<HTMLImageElement>("picture");
const controls = $<HTMLElement>("controls");
const scrub = $<HTMLInputElement>("scrub");
const playButton = $<HTMLButtonElement>("play");
const when = $<HTMLElement>("when");
const replayEngine = new Engine(replayCanvas, true, { antialias: true });
const replayScene = new Scene(replayEngine);
replayScene.useRightHandedSystem = true;
replayScene.clearColor = new Color4(0.89, 0.91, 0.94, 1);
new HemisphericLight("sky", new Vector3(0.2, 1, 0.4), replayScene).intensity = 0.8;
new DirectionalLight("sun", new Vector3(-0.3, -0.8, -0.5), replayScene).intensity = 0.6;
const orbit = new ArcRotateCamera("orbit", Math.PI / 2, 1.35, 3.1, new Vector3(0, 0.15, 0), replayScene);
orbit.lowerRadiusLimit = 0.8;
orbit.upperRadiusLimit = 10;
orbit.wheelDeltaPercentage = 0.02;
orbit.minZ = 0.02;
orbit.attachControl(replayCanvas, true);
let solvedFigure: Character | null = null;
let truthFigure: Character | null = null;
let replayView: "front" | "side" | "apart" = "front";
interface Replay {
  readonly frames: readonly Frame[];
  readonly pictures: readonly string[];
  readonly bodies: readonly Body[];
  readonly truth: readonly Body[];
  readonly rendered: readonly { bones: Record<BoneName, Quat> }[];
}
let replay: Replay | null = null;
let replayAt = 0;
let replayPlaying = false;
let replayFps = 15;

const showReplay = (i: number): void => {
  if (!replay) return;
  replayAt = Math.max(0, Math.min(replay.frames.length - 1, i));
  scrub.value = String(replayAt);
  const f = replay.frames[replayAt]!;
  if (picture.getAttribute("src") !== replay.pictures[replayAt]) picture.src = replay.pictures[replayAt]!;
  drawLandmarks(f);
  const body = replay.bodies[replayAt]!;
  const apart = replayView === "apart" ? 0.45 : 0;
  // Both at the played body's size, so only the pose differs; the size the solver guessed is said in words.
  const truth = replay.truth[replayAt]!;
  solvedFigure?.show({ ...body, proportions: truth.proportions }, { x: -apart, y: 0, z: 0 });
  truthFigure?.show(truth, { x: apart, y: 0, z: 0 });
  const tall = (p: Body["proportions"]) => p.torso + p.neck + p.thigh + p.shin + 0.2;
  // How far off each bone is now, where its end was seen.
  const off: [BoneName, number][] = [];
  for (const b of BONE_NAMES) {
    if (body.joints[BONES[b][1] as JointName].source !== "seen") continue;
    off.push([b, (angleBetween(body.bones[b], replay.rendered[replayAt]!.bones[b]) * 180) / Math.PI]);
  }
  off.sort((a, b) => b[1] - a[1]);
  const mean = off.reduce((a, [, d]) => a + d, 0) / Math.max(1, off.length);
  when.textContent =
    `${(f.t / 1000).toFixed(2)} s · ${f.pose ? `off by ${mean.toFixed(0)}° on average${off[0] ? `, most at ${off[0][0]} (${off[0][1].toFixed(0)}°)` : ""}` : "no body found"}` +
    ` · height guessed ${tall(body.proportions).toFixed(2)} m of ${tall(truth.proportions).toFixed(2)} m`;
};

const startReplay = (r: Replay, fps: number): void => {
  replay = r;
  replayFps = fps;
  canvas.hidden = true;
  picture.hidden = false;
  controls.hidden = false;
  scrub.max = String(r.frames.length - 1);
  replayPlaying = true;
  playButton.textContent = "Pause";
  showReplay(0);
};
scrub.addEventListener("input", () => {
  replayPlaying = false;
  playButton.textContent = "Play";
  showReplay(Number(scrub.value));
});
playButton.addEventListener("click", () => {
  replayPlaying = !replayPlaying;
  playButton.textContent = replayPlaying ? "Pause" : "Play";
});
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".views button"))) {
  b.addEventListener("click", () => {
    replayView = b.dataset.view as typeof replayView;
    for (const o of Array.from(document.querySelectorAll<HTMLButtonElement>(".views button"))) o.setAttribute("aria-pressed", String(o === b));
    orbit.alpha = replayView === "side" ? 0 : Math.PI / 2;
    orbit.beta = 1.35;
    showReplay(replayAt);
  });
}
let replayClock = 0;
replayEngine.runRenderLoop(() => {
  if (replay && replayPlaying) {
    replayClock += replayEngine.getDeltaTime();
    if (replayClock >= 1000 / replayFps) {
      replayClock = 0;
      showReplay(replayAt + 1 >= replay.frames.length ? 0 : replayAt + 1);
    }
  }
  replayScene.render();
});
addEventListener("resize", () => replayEngine.resize());

/** Plays a movement on the character under a setup, tracks every rendered frame and scores the solve. */
const run = async (scriptName: string, setupId?: SetupId, fps = 15): Promise<{ take: Take; summary: Summary; bodies: Body[]; rendered: { bones: Record<BoneName, Quat> }[] }> => {
  if (!character || !trackers) throw new Error("load a model first");
  // "Random 12" is the made-up movement of seed 12, played under the chosen setup.
  const seed = /^Random (\d+)$/.exec(scriptName)?.[1];
  const script = seed !== undefined ? randomScript(Number(seed), setupId ?? "phone-stand") : SCRIPTS.find((s) => s.name === scriptName)!;
  const synth = synthesize(script, { fps, height: 1.8, camera: { width: canvas.width, height: canvas.height }, ...(setupId ? { setup: setupId } : {}) });
  const setup = SETUPS[synth.take.setup];
  camera.fov = (setup.fov * Math.PI) / 180;
  const frames: Frame[] = [];
  const images: TakeImage[] = [];
  const still = document.createElement("canvas");
  still.width = 320;
  still.height = Math.round((320 * canvas.height) / canvas.width);
  // Fresh trackers for every run: in video mode they follow a body from frame to frame, and what they followed in the
  // last run would change this one.
  trackers.close();
  trackers = await Trackers.load(!params.has("cpu"), params.get("pose") === "heavy" ? "heavy" : "full");
  const clock = performance.now();
  // The truth is what was rendered: the character's own joints, measured the way the solver measures a body. How far
  // that is from the script's bones says how faithfully the character was posed.
  const rendered: { bones: Record<BoneName, Quat> }[] = [];
  const pictures: string[] = [];
  const truthBodies: Body[] = [];
  replay = null;
  replayPlaying = false;
  canvas.hidden = false;
  picture.hidden = true;
  for (let i = 0; i < synth.truth.length; i++) {
    const truth = synth.truth[i]!;
    const t = synth.take.frames[i]!.t;
    const body = { bones: truth.bones, hands: { left: { points: truth.hands.left }, right: { points: truth.hands.right } }, proportions: synth.proportions } as unknown as Body;
    truthBodies.push(body);
    character.show(body, truth.root);
    const seenNow = character.joints();
    const J = Object.fromEntries(Object.entries(seenNow.joints).map(([k, p]) => [k, { x: p!.x - truth.root.x, y: p!.y - truth.root.y, z: p!.z - truth.root.z }])) as Joints;
    rendered.push({ bones: boneFrames(J, { palmAcross: seenNow.palmAcross, headLeft: { x: J.leftShoulder.x - J.rightShoulder.x, y: J.leftShoulder.y - J.rightShoulder.y, z: J.leftShoulder.z - J.rightShoulder.z } }) });
    scene.render();
    const frame = trackers.detect(canvas, t, clock + t);
    frames.push(frame);
    pictures.push(canvas.toDataURL("image/jpeg", 0.8));
    if (images.length === 0 || t - images[images.length - 1]!.t >= 250) {
      still.getContext("2d")!.drawImage(canvas, 0, 0, still.width, still.height);
      images.push({ t, src: still.toDataURL("image/jpeg", 0.7) });
    }
    if (i % 3 === 0) {
      drawLandmarks(frame);
      info.innerHTML = `<p>${script.name}, ${setup.label}: frame ${i + 1} of ${synth.truth.length}</p>`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const take: Take = {
    version: 1,
    name: `bench-${script.name.toLowerCase().replace(/\W+/g, "-")}-${setup.id}`,
    setup: setup.id,
    camera: { width: canvas.width, height: canvas.height, facing: setup.facing, mirrored: false, fov: setup.fov },
    created: new Date().toISOString(),
    notes: `Rendered mannequin: ${script.notes}`,
    frames,
    images,
    labels: [{ t0: 0, text: script.name, by: "watcher" }],
  };
  const corrected = await correction;
  const bodies = solveTake(take, corrected ? { correction: corrected } : {});
  const seenAt = (bone: BoneName, i: number) => bodies[i]!.joints[BONES[bone][1] as JointName].source === "seen";
  const seen = boneDifference(bodies, rendered, seenAt);
  const all = boneDifference(bodies, rendered);
  const posing = boneDifference(rendered, synth.truth);
  const cov = coverage(bodies);
  const bones = {} as Summary["bones"];
  for (const b of BONE_NAMES) bones[b] = { mean: seen[b].mean, max: seen[b].max, seen: cov[BONES[b][1] as JointName], direction: seen[b].direction, twist: seen[b].twist };
  const avg = (r: Record<BoneName, { mean: number }>) => {
    const v = BONE_NAMES.map((b) => r[b].mean).filter(Number.isFinite);
    return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  };
  const summary: Summary = { script: script.name, setup: setup.id, frames: frames.length, found: frames.filter((f) => f.pose).length, bones, overall: avg(all), overallSeen: avg(seen), posing: avg(posing) };
  last = { take, summary };
  saveButton.disabled = false;
  startReplay({ frames, pictures, bodies, truth: truthBodies, rendered }, fps);
  return { ...last, bodies, rendered };
};

const grade = (deg: number) => (!Number.isFinite(deg) ? "" : deg < 10 ? "good" : deg < 20 ? "ok" : "bad");
const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");
const showSummary = (s: Summary): string =>
  `<h2>${s.script}, ${SETUPS[s.setup].label}</h2><p>A body was found in ${fmt((100 * s.found) / s.frames)}% of ${s.frames} frames. Mean error ${fmt(s.overallSeen, 1)}° where seen, ${fmt(s.overall, 1)}° over everything. The character was posed within ${fmt(s.posing, 1)}° of the movement.</p>` +
  `<table><tr><th>bone</th><th>seen</th><th>mean</th><th>points</th><th>twist</th><th>max</th></tr>${BONE_NAMES.map(
    (b) =>
      `<tr><td>${b}</td><td>${fmt(s.bones[b].seen * 100)}%</td><td class="${grade(s.bones[b].mean)}">${fmt(s.bones[b].mean, 1)}°</td><td>${fmt(s.bones[b].direction, 1)}°</td><td>${fmt(s.bones[b].twist, 1)}°</td><td>${fmt(s.bones[b].max)}°</td></tr>`,
  ).join("")}</table><p>Mean is the whole difference in each bone's turn; points is how far off its direction is, and twist how far it is turned about its length.</p>`;

runButton.addEventListener("click", async () => {
  runButton.disabled = allButton.disabled = true;
  const r = await run(scriptSelect.value, (setupSelect.value || undefined) as SetupId | undefined);
  info.innerHTML = showSummary(r.summary);
  runButton.disabled = allButton.disabled = false;
});

/** Every movement under every setup that sees a body: the table to watch as the solver changes. */
const runAll = async (): Promise<Summary[]> => {
  const out: Summary[] = [];
  for (const s of SCRIPTS) for (const setup of ["desk", "phone-stand", "selfie"] as const) out.push((await run(s.name, setup)).summary);
  info.innerHTML =
    `<h2>Every movement, every camera</h2><table><tr><th>movement</th><th>camera</th><th>found</th><th>seen</th><th>all</th></tr>${out
      .map((s) => `<tr><td>${s.script}</td><td>${s.setup}</td><td>${fmt((100 * s.found) / s.frames)}%</td><td class="${grade(s.overallSeen)}">${fmt(s.overallSeen, 1)}°</td><td class="${grade(s.overall)}">${fmt(s.overall, 1)}°</td></tr>`)
      .join("")}</table><p>Mean angle between the solved bones and the true ones: where the bone's end was seen, and over every frame.</p>`;
  return out;
};
allButton.addEventListener("click", async () => {
  runButton.disabled = allButton.disabled = true;
  await runAll();
  runButton.disabled = allButton.disabled = false;
});

saveButton.addEventListener("click", () => {
  if (!last) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([saveTake(last.take)], { type: "application/json" }));
  a.download = `${last.take.name}.json`;
  a.click();
});

$<HTMLInputElement>("model").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadModel(URL.createObjectURL(file));
});
// The mannequin by default; another model by ?model=, or opened from a file, if its bones are named the same way.
void loadModel(params.get("model") ?? mannequinUrl);

(window as unknown as { bench: unknown }).bench = { run, runAll, loadModel, scene };
