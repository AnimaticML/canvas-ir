// The camera and the trackers: a camera stream through MediaPipe's pose and hand landmarkers, frame by frame, into the
// motion package's frames; and the video recorded beside them while a take is being recorded.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { CameraInfo, Frame, HandObservation, Landmark, TakeImage } from "@canvas-ir/motion";

export interface Captured {
  readonly frame: Frame;
  /** How long the trackers took on it, in milliseconds. */
  readonly ms: number;
}

const toLandmarks = (list: readonly { x: number; y: number; z: number; visibility?: number }[]): Landmark[] =>
  list.map((l) => (l.visibility !== undefined && l.visibility !== 0 ? { x: l.x, y: l.y, z: l.z, visibility: l.visibility } : { x: l.x, y: l.y, z: l.z }));

export class Capture {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private pose: PoseLandmarker | null = null;
  private hands: HandLandmarker | null = null;
  private running = false;
  private start = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** Small pictures of the camera kept while recording, to go in the take itself. */
  private images: TakeImage[] | null = null;
  private lastImage = -Infinity;
  private readonly still = document.createElement("canvas");
  /** How often a picture is kept while recording, in milliseconds, and how wide it is in pixels. */
  imageEvery = 250;
  imageWidth = 320;
  facing: "user" | "environment" = "user";

  constructor(video: HTMLVideoElement, private readonly onFrame: (c: Captured) => void) {
    this.video = video;
    video.playsInline = true;
    video.muted = true;
  }

  get active(): boolean {
    return this.running;
  }

  /** What is known of the camera: its image size, which way it faces and whether it is shown mirrored. */
  camera(): CameraInfo {
    return { width: this.video.videoWidth || 640, height: this.video.videoHeight || 480, facing: this.facing, mirrored: this.facing === "user" };
  }

  /** Opens the camera facing the given way and loads the trackers. Throws if the camera is refused or missing. */
  async open(facing: "user" | "environment"): Promise<void> {
    this.close();
    this.facing = facing;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.pose || !this.hands) {
      const files = await FilesetResolver.forVisionTasks("./ar-vendor/mediapipe");
      const pose = (delegate: "GPU" | "CPU") =>
        PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: "./ar-vendor/pose_landmarker_full.task", delegate }, runningMode: "VIDEO", numPoses: 1 });
      const hands = (delegate: "GPU" | "CPU") =>
        HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: "./ar-vendor/hand_landmarker.task", delegate }, runningMode: "VIDEO", numHands: 2 });
      this.pose = await pose("GPU").catch(() => pose("CPU"));
      this.hands = await hands("GPU").catch(() => hands("CPU"));
    }
    this.running = true;
    this.start = performance.now();
    const loop = (): void => {
      if (!this.running) return;
      this.detect();
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    loop();
  }

  /** Restarts the clock: frames from now on are timed from zero, as a new take's are. */
  restartClock(): void {
    this.start = performance.now();
  }

  private lastVideoTime = -1;
  private detect(): void {
    if (!this.pose || !this.hands || this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const now = performance.now();
    const p = this.pose.detectForVideo(this.video, now);
    const h = this.hands.detectForVideo(this.video, now);
    const ms = performance.now() - now;
    const hands: HandObservation[] = h.landmarks.map((image, i) => {
      const label = h.handedness[i]?.[0];
      // MediaPipe names hands as if the image were mirrored; this one is as captured, so its "Left" is the right hand.
      const side = label ? (label.categoryName === "Left" ? "right" : "left") : null;
      return { side, score: label?.score ?? 0, image: toLandmarks(image), world: toLandmarks(h.worldLandmarks[i] ?? []) };
    });
    const pose = p.landmarks[0] && p.worldLandmarks[0] ? { image: toLandmarks(p.landmarks[0]), world: toLandmarks(p.worldLandmarks[0]) } : undefined;
    const t = now - this.start;
    if (this.images && t - this.lastImage >= this.imageEvery) {
      this.lastImage = t;
      const w = this.imageWidth;
      const h = Math.round((w * this.video.videoHeight) / this.video.videoWidth);
      this.still.width = w;
      this.still.height = h;
      this.still.getContext("2d")!.drawImage(this.video, 0, 0, w, h);
      this.images.push({ t, src: this.still.toDataURL("image/jpeg", 0.7) });
    }
    this.onFrame({ frame: { t, ...(pose ? { pose } : {}), hands }, ms });
  }

  /** Starts recording the camera's video, for a take. */
  record(): void {
    if (!this.stream) return;
    this.images = [];
    this.lastImage = -Infinity;
    this.chunks = [];
    const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : {});
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.restartClock();
  }

  /** The pictures kept while recording, taken away. */
  takeImages(): TakeImage[] {
    const images = this.images ?? [];
    this.images = null;
    return images;
  }

  /** Stops recording and gives the video. */
  stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) return Promise.resolve(null);
    return new Promise((done) => {
      recorder.onstop = () => done(new Blob(this.chunks, { type: recorder.mimeType || "video/webm" }));
      recorder.stop();
    });
  }

  close(): void {
    this.running = false;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
