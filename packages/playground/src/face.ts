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
  /** The last reading, before smoothing: for a status line. */
  last: FaceReading | null = null;
  /** How far apart this viewer's eyes' outer corners are, in meters: learned from the irises while both eyes are open. */
  span = SPAN;
  private spans: number[] = [];
  /** Irises measured while calibrating the webcam's field of view. */
  private measuring: number[] | null = null;

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

  /**
   * Measures the webcam's field of view with the eyes held at a known distance from the screen (in meters): how big the
   * irises look there says how far a pixel reaches, for this webcam and these eyes. Resolves with the angle, in degrees,
   * and keeps it; rejects when the face wasn't seen steadily enough.
   */
  async calibrate(distance: number, ms = 1500): Promise<number> {
    this.measuring = [];
    await new Promise((done) => setTimeout(done, ms));
    const irises = this.measuring.sort((a, b) => a - b);
    this.measuring = null;
    if (irises.length < 8) throw new Error("the face wasn't seen long enough");
    const iris = irises[Math.floor(irises.length / 2)]!;
    const fov = fovFromIris(iris, distance, this.video.videoWidth);
    this.options = { ...this.options, fov };
    return fov;
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
    const eye = face ? eyeFrom(face, v.videoWidth, v.videoHeight, this.options, this.span) : null;
    if (!eye) {
      this.last = null;
      for (const f of this.filters) f.reset();
      this.onEye(null);
      return;
    }
    this.last = eye;
    if (eye.iris) {
      this.measuring?.push(eye.iris);
      // The irises are the same size in everyone, so they say how far apart these eyes' corners really are.
      this.spans.push((eye.span * IRIS) / eye.iris);
      if (this.spans.length > 120) this.spans.shift();
      if (this.spans.length >= 15) this.span = [...this.spans].sort((a, b) => a - b)[this.spans.length >> 1]!;
    }
    const [x, y, z] = this.filters as [OneEuro, OneEuro, OneEuro];
    this.onEye({ x: x.filter(eye.eye.x, now), y: y.filter(eye.eye.y, now), z: z.filter(eye.eye.z, now) });
  }
}

/** The eyes' corners and lids: the outer and inner corners and the upper and lower lids of each eye. */
const EYES = [
  { outer: 33, inner: 133, upper: 159, lower: 145 },
  { outer: 263, inner: 362, upper: 386, lower: 374 },
] as const;
/** An eye counts as closed when its lids are nearer than this to each other, over its width. */
const CLOSED = 0.15;

/** What one frame of a face says about the eyes. */
export interface FaceReading {
  /** Where the eye that looks is, in meters from the middle of the screen. */
  readonly eye: Eye;
  /** How wide the irises look, in pixels, when both eyes are open (null otherwise): to learn `span` from, and to measure the webcam. */
  readonly iris: number | null;
  /** How far apart the eyes' outer corners look, in pixels, with the head's turn taken out. */
  readonly span: number;
  /** Which eyes are open: the viewer's right, then left. */
  readonly open: readonly [boolean, boolean];
}

/**
 * Where the viewer's eye is, from a face's landmarks (normalized to the image) and the image's size. Its place is the
 * eyes' corners, which stay put when the eyes look around or blink, as the irises don't; its distance is how far apart
 * the outer corners look (in 3D, so turning the head doesn't change it), at `span` meters apart, learned from the irises.
 */
export const eyeFrom = (face: readonly { x: number; y: number; z?: number }[], width: number, height: number, o: FaceOptions, span = SPAN): FaceReading | null => {
  if (face.length < 478) return null;
  const px = (i: number) => ({ x: face[i]!.x * width, y: face[i]!.y * height, z: (face[i]!.z ?? 0) * width });
  const d2 = (a: number, b: number): number => Math.hypot(px(a).x - px(b).x, px(a).y - px(b).y);
  const eyes = EYES.map((e) => {
    const a = px(e.outer);
    const b = px(e.inner);
    const wide = Math.max(1, d2(e.outer, e.inner));
    return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, open: d2(e.upper, e.lower) / wide > CLOSED };
  });
  const [right, left] = eyes as [(typeof eyes)[0], (typeof eyes)[0]];
  const a = px(EYES[0].outer);
  const b = px(EYES[1].outer);
  const across = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  if (across < 8) return null;
  const f = width / 2 / Math.tan((o.fov * Math.PI) / 360);
  const z = (f * span) / across;
  // Between the eyes, whichever are open: the head's place, which doesn't move when an eye closes.
  const at = { x: (right.at.x + left.at.x) / 2, y: (right.at.y + left.at.y) / 2 };
  const irisWide = (c: typeof LEFT | typeof RIGHT): number => d2(c.across[0], c.across[1]);
  const iris = right.open && left.open ? Math.max(irisWide(LEFT), irisWide(RIGHT)) : null;
  const u = at.x - width / 2;
  const v = at.y - height / 2;
  // The front camera faces the viewer: the image's right is the viewer's left, and its down is down.
  return { eye: { x: o.camera.x - (u * z) / f, y: o.camera.y - (v * z) / f, z }, iris, span: across, open: [right.open, left.open] };
};

/** How far apart the eyes' outer corners are in most adults, in meters, until it's learned for this face. */
export const SPAN = 0.09;

/** The webcam's horizontal field of view, in degrees, from how big an iris looks (pixels) at a known distance (meters) in an image so wide. */
export const fovFromIris = (iris: number, distance: number, width: number): number => {
  const f = (iris * distance) / IRIS;
  return (2 * Math.atan(width / 2 / f) * 180) / Math.PI;
};
