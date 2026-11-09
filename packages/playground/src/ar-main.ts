import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { intrinsics, median, onTable, toCamera, toTable, length, sub, type Intrinsics, type Pixel, type Pose, type V3 } from "./ar/geometry";
import { MarkerMap, Vision, loadCV, type Fit, type Marker } from "./ar/vision";
import { ARScene, smoothPose } from "./ar/scene";

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = (id: string): HTMLButtonElement => element<HTMLButtonElement>(id);
const select = (id: string): HTMLSelectElement => element<HTMLSelectElement>(id);
const input = (id: string): HTMLInputElement => element<HTMLInputElement>(id);
const text = (id: string, value: string): void => { element(id).textContent = value; };
const notice = (message: string, error = false): void => { text("notice", message); element("notice").classList.toggle("error", error); };
const video = element<HTMLVideoElement>("video"), overlay = element<HTMLCanvasElement>("overlay"), ctx = overlay.getContext("2d")!;
const processing = document.createElement("canvas"), pixels = processing.getContext("2d", { willReadFrequently: true })!;
const map = new MarkerMap(0.06);
let vision: Vision | null = null, scene: ARScene | null = null, hands: HandLandmarker | null = null;
let stream: MediaStream | null = null, running = false, starting = false, cameraGeneration = 0, frame = 0;
let k: Intrinsics | null = null, pose: Pose | null = null, lastPose = 0, lastFrame = 0, lastVideoTime = -1, lastResult = 0, frameMs = 0;
let manualPixels: Pixel[] = [], manualFit: Fit | null = null, found: Marker[] = [];
let latestHeight: number | null = null, touchBias: number | null = null, touchSamples: number[] | null = null, touchStarted = 0;
let trackedHand = "", latestHandError: number | null = null, handEnabled = false;
let jitterSamples: { t: number; p: V3 }[] = [];
let sample: { until: number; reference: number; values: number[]; mode: string; moving: string } | null = null;
const measurements: unknown[] = [];
const skeleton = [[0,1,2,3,4], [0,5,6,7,8], [5,9,10,11,12], [9,13,14,15,16], [13,17,18,19,20], [0,17]];
const resetTouch = (): void => { touchBias = null; touchSamples = null; trackedHand = ""; latestHeight = null; text("touch-note", "Удерживайте указательный палец на реальном столе. Глубина приблизительна."); };
const resetAnchor = (): void => {
  sample = null; map.reset(Number(input("size").value) / 100); pose = null; manualPixels = []; manualFit = null; lastPose = 0; jitterSamples = []; resetTouch(); scene?.hide(); scene?.resetObjects();
  button("freeze").textContent = "Зафиксировать карту";
  const manual = select("anchor").value === "manual";
  button("freeze").disabled = !running || manual; input("size").disabled = manual;
  notice(select("anchor").value === "manual" ? "Выберите 4 угла прямоугольника 60×40 см: дальний левый, дальний правый, ближний правый, ближний левый." : "Покажите маркеры вместе. Не перемещайте их после построения карты.");
};

const layout = (): void => {
  const stage = element("stage"), image = element("image");
  const w = k?.width ?? 640, h = k?.height ?? 480, factor = Math.min(stage.clientWidth / w, stage.clientHeight / h);
  image.style.width = `${w * factor}px`; image.style.height = `${h * factor}px`;
  scene?.resize();
};
new ResizeObserver(layout).observe(element("stage"));

const stop = (): void => {
  sample = null; running = false; starting = false; cameraGeneration++; cancelAnimationFrame(frame);
  stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
  scene?.hide(); pose = null; manualFit = null; manualPixels = []; k = null; latestHeight = null; resetTouch();
  ctx.clearRect(0, 0, overlay.width, overlay.height); element("welcome").hidden = false;
  found = []; lastResult = 0;
  for (const id of ["pose-error", "jitter", "latency", "hand-error", "quality", "holding"]) text(id, "—");
  text("marker-count", `0 / ${map.markers.size}`);
  button("start").disabled = !scene || !vision; button("stop").disabled = true;
  button("freeze").disabled = button("recalibrate").disabled = button("touch").disabled = button("sample").disabled = true;
  text("state", "КАМЕРА ВЫКЛЮЧЕНА"); element("state").dataset.state = "off"; text("height", "—"); text("hand-state", "—"); text("fps", "— fps"); text("age", "—");
};
button("start").onclick = async () => {
  if (running || starting) return;
  if (!navigator.mediaDevices?.getUserMedia) { notice("Камера доступна только через HTTPS или localhost в поддерживаемом браузере.", true); return; }
  starting = true; const generation = ++cameraGeneration; button("start").disabled = true;
  try {
    const incoming = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (generation !== cameraGeneration) { incoming.getTracks().forEach(t => t.stop()); return; }
    stream = incoming; video.srcObject = stream;
    await video.play();
    if (generation !== cameraGeneration) return;
    const scale = Math.min(1, 800 / video.videoWidth);
    const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
    if (!width || !height) throw new Error("Камера не вернула размер кадра");
    overlay.width = processing.width = width; overlay.height = processing.height = height;
    k = intrinsics(width, height, Number(input("fov").value));
    running = true; starting = false; lastFrame = 0; lastVideoTime = -1; frameMs = 0;
    resetAnchor(); element("welcome").hidden = true;
    button("stop").disabled = button("recalibrate").disabled = false; button("freeze").disabled = select("anchor").value === "manual";
    layout(); frame = requestAnimationFrame(tick);
    incoming.getVideoTracks()[0]!.addEventListener("ended", () => { if (stream === incoming) { stop(); notice("Камера отключена. Включите её снова."); } });
  } catch (error) { if (generation === cameraGeneration) { stop(); notice(`Не удалось включить камеру: ${String(error)}`, true); } }
};
button("stop").onclick = () => { stop(); notice("Камера остановлена. Обработка видео выполняется локально."); };
video.addEventListener("resize", () => {
  if (!running || !video.videoWidth || !video.videoHeight) return;
  const factor = Math.min(1, 800 / video.videoWidth);
  const width = Math.round(video.videoWidth * factor), height = Math.round(video.videoHeight * factor);
  if (k?.width === width && k?.height === height) return;
  overlay.width = processing.width = width; overlay.height = processing.height = height;
  k = intrinsics(width, height, Number(input("fov").value)); resetAnchor(); layout();
});
window.addEventListener("pagehide", () => { stop(); hands?.close(); vision?.dispose(); scene?.dispose(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && (running || starting)) { stop(); notice("Камера остановлена при уходе со страницы. Включите её снова."); } });
button("recalibrate").onclick = resetAnchor;
button("reset-objects").onclick = () => scene?.resetObjects();
select("anchor").onchange = resetAnchor;
input("size").onchange = () => {
  if (!Number.isFinite(Number(input("size").value)) || Number(input("size").value) < 2 || Number(input("size").value) > 20) input("size").value = "6";
  resetAnchor(); updateMarkerSize();
};
input("fov").oninput = () => {
  text("fov-value", `${input("fov").value}°`);
  if (k) k = intrinsics(k.width, k.height, Number(input("fov").value)); resetAnchor();
};
button("freeze").onclick = () => {
  if (!map.markers.size) { notice("Сначала покажите хотя бы один маркер."); return; }
  map.learning = !map.learning; button("freeze").textContent = map.learning ? "Зафиксировать карту" : "Добавлять маркеры";
  notice(map.learning ? "Обучение карты: покажите новые ID вместе с известными." : "Карта зафиксирована. Теперь можно перемещать телефон и перекрывать часть маркеров.");
};
overlay.addEventListener("pointerdown", e => {
  if (!running || !k || select("anchor").value !== "manual" || manualPixels.length >= 4 || !vision) return;
  const rect = overlay.getBoundingClientRect();
  manualPixels.push({ x: (e.clientX - rect.left) * k.width / rect.width, y: (e.clientY - rect.top) * k.height / rect.height });
  if (manualPixels.length === 4) {
    const fit = vision.fit(manualCorners, manualPixels, k);
    if (!fit || fit.error > 8 || toTable(fit.pose, [0, 0, 0])[1] < 0.03) { manualPixels = []; notice("Углы не соответствуют прямоугольнику 60×40 см. Выберите их заново по порядку.", true); }
    else { manualFit = fit; resetTouch(); notice("Ручная привязка готова. Она верна только при неподвижном телефоне."); }
  }
});
const manualCorners: V3[] = [[-0.3,0,-0.2], [0.3,0,-0.2], [0.3,0,0.2], [-0.3,0,0.2]];

button("hands").onclick = async () => {
  if (hands) {
    handEnabled = !handEnabled; button("hands").textContent = handEnabled ? "Выключить MediaPipe" : "Включить MediaPipe";
    if (!handEnabled) { sample = null; scene?.loseHand(true); resetTouch(); } return;
  }
  button("hands").disabled = true; notice("Загрузка модели кисти с этого сайта…");
  try {
    const files = await FilesetResolver.forVisionTasks("./ar-vendor/mediapipe");
    hands = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "./ar-vendor/hand_landmarker.task", delegate: "CPU" },
      runningMode: "VIDEO", numHands: 1, minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.65, minTrackingConfidence: 0.65,
    });
    handEnabled = true; button("hands").textContent = "Выключить MediaPipe";
    notice("Руки включены. Начните с проекции на стол, затем сравните с режимом 3D.");
  } catch (error) { notice(`Не удалось загрузить MediaPipe: ${String(error)}. Можно повторить попытку.`, true); }
  finally { button("hands").disabled = false; }
};
select("depth").onchange = () => { sample = null; scene?.loseHand(true); latestHeight = null; touchSamples = null; };
button("touch").onclick = () => {
  if (latestHeight === null || !pose) return;
  touchSamples = []; touchStarted = performance.now();
  text("touch-note", "Касайтесь стола неподвижным указательным пальцем примерно 1 секунду…");
};
const processHand = (result: HandLandmarkerResult, now: number): void => {
  const landmarks = result.landmarks[0], world = result.worldLandmarks[0];
  if (!landmarks || !world || !k || !pose || !vision) { lostHand(); return; }
  const side = result.handedness[0]?.[0]?.categoryName ?? "Unknown";
  if (trackedHand && trackedHand !== side) resetTouch();
  trackedHand = side; text("hand-state", `${side} · 21 точки`);
  const imagePoints = landmarks.map(p => ({ x: p.x * k!.width, y: p.y * k!.height }));
  drawSkeleton(imagePoints);
  const projected = onTable(pose, k, imagePoints[8]!);
  if (!projected) { lostHand(); return; }
  ctx.fillStyle = "#ff86a5"; ctx.beginPath(); ctx.arc(imagePoints[8]!.x, imagePoints[8]!.y, 6, 0, Math.PI * 2); ctx.fill();
  const depthMode = select("depth").value;
  if (depthMode === "projection") {
    latestHeight = null; text("height", "2D"); text("quality", "только луч"); text("hand-error", "—");
    const projectedPoints = imagePoints.map(p => onTable(pose!, k!, p) ?? projected);
    scene?.hand(projectedPoints, false, now); button("touch").disabled = button("sample").disabled = true; return;
  }
  const objectPoints: V3[] = world.map(p => [p.x, p.y, p.z]);
  const fit = vision.fit(objectPoints, imagePoints, k);
  latestHandError = fit?.error ?? null;
  if (!fit || fit.error > 8) { lostHand(); text("quality", "отклонено"); return; }
  let points = objectPoints.map(p => toTable(pose!, toCamera(fit.pose, p)));
  const height = points[8]![1];
  // Reject implausible depth and scale solutions rather than emitting a false touch.
  if (height < -0.15 || height > 0.65 || length(sub(points[0]!, points[9]!)) < 0.025 || length(sub(points[0]!, points[9]!)) > 0.16) { lostHand(); return; }
  if (touchSamples) {
    touchSamples.push(height);
    if (touchSamples.length >= 12 && now - touchStarted >= 800) {
      const middle = median(touchSamples);
      if (Math.max(...touchSamples) - Math.min(...touchSamples) < 0.018) {
        touchBias = middle; select("depth").value = "touch";
        text("touch-note", `Касание сохранено · коррекция ${(middle * 100).toFixed(1)} см. При дрейфе повторите.`);
      } else text("touch-note", "Высота нестабильна. Удерживайте палец на столе и повторите калибровку.");
      touchSamples = null;
    }
  }
  const calibrated = select("depth").value === "touch";
  if (calibrated && touchBias === null) {
    text("touch-note", "Сначала откалибруйте касание. Сейчас отображается исходная оценка 3D; взаимодействие отключено.");
  }
  const bias = calibrated ? touchBias ?? 0 : 0;
  points = points.map(p => [p[0], p[1] - bias, p[2]]);
  latestHeight = points[8]![1] * 100;
  text("height", latestHeight.toFixed(1)); text("hand-error", `${fit.error.toFixed(1)} px`);
  text("quality", `${Math.round(100 * Math.max(0, 1 - fit.error / 8))}% · эвристика`);
  scene?.hand(points, !calibrated || touchBias !== null, now);
  button("touch").disabled = !!touchSamples; button("sample").disabled = !!sample;
  if (sample) sample.values.push(latestHeight);
};
const lostHand = (): void => {
  latestHeight = null; latestHandError = null; touchSamples = null;
  text("height", "—"); text("hand-state", "не видна"); text("hand-error", "—"); text("quality", "—");
  button("touch").disabled = button("sample").disabled = true; scene?.loseHand();
};
const drawSkeleton = (points: Pixel[]): void => {
  ctx.strokeStyle = "#9fffe5"; ctx.lineWidth = 2;
  for (const chain of skeleton) { ctx.beginPath(); chain.forEach((id, i) => { const p = points[id]!; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }); ctx.stroke(); }
  ctx.fillStyle = "#ecfff9";
  for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI); ctx.fill(); }
};
const drawMarkers = (): void => {
  ctx.lineWidth = 2; ctx.font = "15px system-ui";
  for (const m of found) {
    ctx.strokeStyle = ctx.fillStyle = map.markers.has(m.id) ? "#91f5ca" : "#ffcb87";
    ctx.beginPath(); m.pixels.forEach((p, i) => { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); ctx.stroke();
    ctx.fillText(`#${m.id}`, m.pixels[0]!.x, m.pixels[0]!.y - 7);
  }
  manualPixels.forEach((p, i) => { ctx.fillStyle = "#ffcb87"; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillText(String(i + 1), p.x + 8, p.y); });
};
const tick = (now: number): void => {
  if (!running) return;
  frame = requestAnimationFrame(tick);
  text("age", lastResult ? `${Math.round(now - lastResult)} ms` : "—");
  // No frame queue: use the newest camera image, capped at 15 inference passes/s.
  if (!k || !vision || !scene || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastFrame < 66) return;
  const start = performance.now(), dt = lastFrame ? (start - lastFrame) / 1000 : 1 / 15;
  frameMs = frameMs ? frameMs * 0.8 + (start - lastFrame) * 0.2 : 66;
  lastFrame = start; lastVideoTime = video.currentTime;
  pixels.drawImage(video, 0, 0, k.width, k.height); ctx.clearRect(0, 0, k.width, k.height);
  try {
    let fit: Fit | null;
    if (select("anchor").value === "aruco") {
      found = vision.detect(pixels.getImageData(0, 0, k.width, k.height)); fit = map.update(found, vision, k);
    } else { found = []; fit = manualFit; }
    drawMarkers();
    if (fit) {
      pose = smoothPose(start - lastPose > 300 ? null : pose, fit.pose, dt, Number(select("smoothing").value));
      lastPose = start; scene.pose(pose, k);
      text("state", select("anchor").value === "manual" ? "РУЧНАЯ · ТЕЛЕФОН НЕПОДВИЖЕН" : "СТОЛ ПРИВЯЗАН"); element("state").dataset.state = "tracked";
      text("pose-error", `${fit.error.toFixed(2)} px`);
      jitterSamples.push({ t: start, p: toTable(pose, [0,0,0]) }); jitterSamples = jitterSamples.filter(s => start - s.t < 2000);
      const center: V3 = [0,1,2].map(i => jitterSamples.reduce((s, v) => s + v.p[i]!, 0) / jitterSamples.length) as V3;
      const rms = Math.sqrt(jitterSamples.reduce((s, v) => s + length(sub(v.p, center)) ** 2, 0) / jitterSamples.length);
      text("jitter", `${(rms * 1000).toFixed(1)} mm`);
      if (hands && handEnabled) processHand(hands.detectForVideo(processing, start), start); else lostHand();
    } else {
      // Never show a stale pose against a moving live camera frame.
      pose = null; scene.hide(); lostHand();
      text("state", map.markers.size ? "ТРЕКИНГ ПОТЕРЯН" : "ПОИСК СТОЛА"); element("state").dataset.state = "lost"; text("pose-error", "—");
    }
    lastResult = start;
    text("marker-count", `${found.length} / ${map.markers.size}`); text("holding", scene.holding);
    text("counts", `${scene.presses} / ${scene.grabs} / ${scene.releases}`);
    text("fps", `${Math.round(1000 / frameMs)} fps · трекинг`);
    text("latency", `${Math.round(performance.now() - start)} ms`);
    text("map-note", `${map.learning ? "Обучение" : "Карта зафиксирована"} · ID: ${[...map.markers.keys()].join(", ") || "—"}. Маркеры нельзя перемещать.`);
    if (sample && now >= sample.until) finishSample();
  } catch (error) { stop(); notice(`Обработка остановлена: ${String(error)}`, true); }
};

button("sample").onclick = () => {
  sample = { until: performance.now() + 2000, reference: Number(select("reference").value), values: [], mode: select("depth").value, moving: (element<HTMLTextAreaElement>("notes").value) };
  button("sample").disabled = true; text("sample-note", "Идёт замер · держите палец неподвижно 2 секунды…");
};
const finishSample = (): void => {
  if (!sample) return;
  const s = sample; sample = null;
  if (s.values.length < 10) { text("sample-note", "Мало достоверных кадров. Повторите замер."); return; }
  const mean = s.values.reduce((a,b) => a+b,0) / s.values.length;
  const std = Math.sqrt(s.values.reduce((a,b) => a+(b-mean)**2,0) / s.values.length);
  measurements.push({ referenceCm: s.reference, mode: s.mode, samples: s.values, meanCm: mean, biasCm: mean-s.reference, stdCm: std, notes: s.moving, time: new Date().toISOString() });
  text("sample-note", `${s.reference} см → ${mean.toFixed(1)} см; σ ${std.toFixed(1)} см; ${s.values.length} кадров. Всего замеров: ${measurements.length}.`);
};
button("export").onclick = () => {
  const report = { demo: "canvas-ir-ar-table-v1", date: new Date().toISOString(), intrinsics: k, intrinsicsSource: "approximate horizontal FOV; zero lens distortion", markerSideCm: map.size * 100, markerMap: [...map.markers], anchor: select("anchor").value, depth: select("depth").value, touchBiasM: touchBias, inferenceMs: Number(element("latency").textContent?.replace(" ms", "")) || null, handReprojectionPx: latestHandError, counts: { touches: scene?.presses, grabs: scene?.grabs, releases: scene?.releases }, measurements, comfort: Number(input("comfort").value), notes: element<HTMLTextAreaElement>("notes").value };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "ar-table-report.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const dialog = element<HTMLDialogElement>("marker-dialog");
const updateMarkerSize = (): void => { dialog.style.setProperty("--marker-mm", `${Number(input("size").value) * 10}mm`); };
button("markers").onclick = () => { if (!element("marker-sheet").children.length && vision) for (const id of [0,1,2]) { const holder = document.createElement("div"); holder.className = "marker"; const label = document.createElement("b"); label.textContent = `DICT_4X4_50 · ID ${id}`; holder.append(vision.marker(id), label); element("marker-sheet").append(holder); } updateMarkerSize(); dialog.showModal(); };
button("close-markers").onclick = () => dialog.close(); button("print").onclick = () => window.print();

void (async () => {
  const results = await Promise.allSettled([loadCV().then(cv => { vision = new Vision(cv); button("markers").disabled = false; }), ARScene.create(element<HTMLCanvasElement>("scene")).then(s => { scene = s; layout(); button("reset-objects").disabled = false;
    // Like canvasIrBabylon, expose the scene for browser diagnostics and repeatable synthetic tests.
    (window as unknown as { canvasIrAR: unknown }).canvasIrAR = { scene: s, map, snapshot: () => ({ running, pose, intrinsics: k, heightCm: latestHeight, touchBias, handEnabled }) }; })]);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) { notice(failures.map(f => String(f.reason)).join("; "), true); return; }
  button("start").disabled = button("hands").disabled = false;
  notice("Готово. Подготовьте маркеры и включите камеру. Видео обрабатывается на устройстве.");
})();
