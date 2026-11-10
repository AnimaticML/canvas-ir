// Where the viewer's eyes are, from the front camera. MediaPipe's face landmarker finds the face and both irises each
// frame; an iris is about 11.7 mm across in nearly everyone, so how big it looks says how far away it is, with no
// calibration, and where the eyes are in the image says which way. That gives the eye in meters from the camera, and,
// with the camera above the middle of the screen, from the middle of the screen.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { type Eye, OneEuro } from "./viewer";

/** An iris's diameter, in meters. */
const IRIS = 0.0117;
/** MediaPipe's iris landmarks: the left and right irises' centers, and the points on each iris's rim, across. */
const LEFT = { center: 468, across: [469, 471] } as const;
const RIGHT = { center: 473, across: [474, 476] } as const;

export interface FaceOptions {
  /** The camera's horizontal field of view, in degrees: most built-in cameras see about 60 to 70. */
  fov: number;
  /** Where the camera is from the middle of the screen, in meters (x right, y up): above its top edge, by default. */
  camera: { x: number; y: number };
}

/** Tracks the viewer's eyes from the front camera and calls back with where they are (null when the face is lost). */
export class FaceTracker {
  private readonly video = document.createElement("video");
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private running = false;
  private lastVideoTime = -1;
  private readonly filters = [new OneEuro(1.2, 0.8), new OneEuro(1.2, 0.8), new OneEuro(0.8, 0.5)];
  /** The last eye seen, before smoothing, and how big the iris looked in pixels: for a status line. */
  last: { eye: Eye; iris: number } | null = null;

  constructor(
    private readonly onEye: (eye: Eye | null) => void,
    public options: FaceOptions,
  ) {
    this.video.playsInline = true;
    this.video.muted = true;
  }

  get active(): boolean {
    return this.running;
  }

  /** Asks for the front camera and the model, and starts tracking. Throws if the camera is refused or missing. */
  async start(): Promise<void> {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.landmarker) {
      const files = await FilesetResolver.forVisionTasks("./ar-vendor/mediapipe");
      const create = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: "./ar-vendor/face_landmarker.task", delegate }, runningMode: "VIDEO", numFaces: 1 });
      this.landmarker = await create("GPU").catch(() => create("CPU"));
    }
    this.running = true;
    for (const f of this.filters) f.reset();
    const loop = (): void => {
      if (!this.running) return;
      this.detect();
      this.video.requestVideoFrameCallback ? this.video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    };
    loop();
  }

  stop(): void {
    this.running = false;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.last = null;
  }

  private detect(): void {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    const face = this.landmarker.detectForVideo(v, now).faceLandmarks[0];
    const eye = face ? eyeFrom(face, v.videoWidth, v.videoHeight, this.options) : null;
    if (!eye) {
      this.last = null;
      for (const f of this.filters) f.reset();
      this.onEye(null);
      return;
    }
    this.last = eye;
    const [x, y, z] = this.filters as [OneEuro, OneEuro, OneEuro];
    this.onEye({ x: x.filter(eye.eye.x, now), y: y.filter(eye.eye.y, now), z: z.filter(eye.eye.z, now) });
  }
}

/**
 * The point between the eyes, in meters from the middle of the screen, from a face's landmarks (normalized to the image)
 * and the image's size; null when the irises are missing or too small to measure.
 */
export const eyeFrom = (face: readonly { x: number; y: number }[], width: number, height: number, o: FaceOptions): { eye: Eye; iris: number } | null => {
  const px = (i: number): { x: number; y: number } | null => (face[i] ? { x: face[i]!.x * width, y: face[i]!.y * height } : null);
  const across = (iris: typeof LEFT | typeof RIGHT): number | null => {
    const a = px(iris.across[0]);
    const b = px(iris.across[1]);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  };
  const l = px(LEFT.center);
  const r = px(RIGHT.center);
  const dl = across(LEFT);
  const dr = across(RIGHT);
  if (!l || !r || !dl || !dr) return null;
  // The larger iris is the nearer and the less foreshortened when the head turns.
  const iris = Math.max(dl, dr);
  if (iris < 2) return null;
  const f = width / 2 / Math.tan((o.fov * Math.PI) / 360);
  const z = (f * IRIS) / iris;
  const u = (l.x + r.x) / 2 - width / 2;
  const v = (l.y + r.y) / 2 - height / 2;
  // The front camera faces the viewer: the image's right is the viewer's left, and its down is down.
  return { eye: { x: o.camera.x - (u * z) / f, y: o.camera.y - (v * z) / f, z }, iris };
};
