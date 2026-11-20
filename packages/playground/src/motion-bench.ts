// The motion bench: a rigged human posed by a scripted movement, rendered through a camera placed as a setup places
// it, and run through the real trackers and the solver. The movement's bones are known, so the solve is scored
// against the truth, bone by bone, for each camera setup: what the camera-only takes can't tell.
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
  type Joints, type Quat, boneDifference, boneFrames, coverage, saveTake, solveTake, synthesize,
} from "@canvas-ir/motion";
import { Character, mannequinSpec } from "./motion/character";
import { Trackers } from "./motion/capture";
import mannequinUrl from "./motion/mannequin.glb" with { type: "file" };

const params = new URLSearchParams(location.search);
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
  // ?cpu runs the trackers on the CPU, as a machine without a GPU must, so results repeat exactly.
  trackers ??= await Trackers.load(!params.has("cpu"));
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
  readonly bones: Record<BoneName, { mean: number; max: number; seen: number }>;
  /** The same over every frame, held and assumed parts included. */
  readonly overall: number;
  readonly overallSeen: number;
  /** How far the posed character was from the script's bones: the bench's own error, which should be small. */
  readonly posing: number;
}

const drawLandmarks = (f: Frame): void => {
  const c = overlay.getContext("2d")!;
  c.clearRect(0, 0, overlay.width, overlay.height);
  const pts = f.pose?.image;
  c.fillStyle = "#22c55e";
  for (const l of pts ?? []) if ((l.visibility ?? 1) > 0.5) c.fillRect(l.x * overlay.width - 2, l.y * overlay.height - 2, 4, 4);
  c.fillStyle = "#60a5fa";
  for (const h of f.hands) for (const l of h.image) c.fillRect(l.x * overlay.width - 1.5, l.y * overlay.height - 1.5, 3, 3);
};

/** Plays a movement on the character under a setup, tracks every rendered frame and scores the solve. */
const run = async (scriptName: string, setupId?: SetupId, fps = 15): Promise<{ take: Take; summary: Summary; bodies: Body[]; rendered: { bones: Record<BoneName, Quat> }[] }> => {
  if (!character || !trackers) throw new Error("load a model first");
  const script = SCRIPTS.find((s) => s.name === scriptName)!;
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
  trackers = await Trackers.load(!params.has("cpu"));
  const clock = performance.now();
  // The truth is what was rendered: the character's own joints, measured the way the solver measures a body. How far
  // that is from the script's bones says how faithfully the character was posed.
  const rendered: { bones: Record<BoneName, Quat> }[] = [];
  for (let i = 0; i < synth.truth.length; i++) {
    const truth = synth.truth[i]!;
    const t = synth.take.frames[i]!.t;
    const body = { bones: truth.bones, hands: { left: { points: truth.hands.left }, right: { points: truth.hands.right } }, proportions: synth.proportions } as unknown as Body;
    character.show(body, truth.root);
    const seenNow = character.joints();
    const J = Object.fromEntries(Object.entries(seenNow.joints).map(([k, p]) => [k, { x: p!.x - truth.root.x, y: p!.y - truth.root.y, z: p!.z - truth.root.z }])) as Joints;
    rendered.push({ bones: boneFrames(J, { palmAcross: seenNow.palmAcross, headLeft: { x: J.leftShoulder.x - J.rightShoulder.x, y: J.leftShoulder.y - J.rightShoulder.y, z: J.leftShoulder.z - J.rightShoulder.z } }) });
    scene.render();
    const frame = trackers.detect(canvas, t, clock + t);
    frames.push(frame);
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
  const bodies = solveTake(take);
  const seenAt = (bone: BoneName, i: number) => bodies[i]!.joints[BONES[bone][1] as JointName].source === "seen";
  const seen = boneDifference(bodies, rendered, seenAt);
  const all = boneDifference(bodies, rendered);
  const posing = boneDifference(rendered, synth.truth);
  const cov = coverage(bodies);
  const bones = {} as Summary["bones"];
  for (const b of BONE_NAMES) bones[b] = { mean: seen[b].mean, max: seen[b].max, seen: cov[BONES[b][1] as JointName] };
  const avg = (r: Record<BoneName, { mean: number }>) => {
    const v = BONE_NAMES.map((b) => r[b].mean).filter(Number.isFinite);
    return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  };
  const summary: Summary = { script: script.name, setup: setup.id, frames: frames.length, found: frames.filter((f) => f.pose).length, bones, overall: avg(all), overallSeen: avg(seen), posing: avg(posing) };
  last = { take, summary };
  saveButton.disabled = false;
  return { ...last, bodies, rendered };
};

const grade = (deg: number) => (!Number.isFinite(deg) ? "" : deg < 10 ? "good" : deg < 20 ? "ok" : "bad");
const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");
const showSummary = (s: Summary): string =>
  `<h2>${s.script}, ${SETUPS[s.setup].label}</h2><p>A body was found in ${fmt((100 * s.found) / s.frames)}% of ${s.frames} frames. Mean error ${fmt(s.overallSeen, 1)}° where seen, ${fmt(s.overall, 1)}° over everything. The character was posed within ${fmt(s.posing, 1)}° of the movement.</p>` +
  `<table><tr><th>bone</th><th>seen</th><th>mean</th><th>max</th></tr>${BONE_NAMES.map(
    (b) => `<tr><td>${b}</td><td>${fmt(s.bones[b].seen * 100)}%</td><td class="${grade(s.bones[b].mean)}">${fmt(s.bones[b].mean, 1)}°</td><td>${fmt(s.bones[b].max)}°</td></tr>`,
  ).join("")}</table>`;

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
