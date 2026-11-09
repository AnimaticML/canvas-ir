import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

export type Delegate = "GPU" | "CPU";
type Image = Parameters<HandLandmarker["detectForVideo"]>[0];
export interface HandModel { detectForVideo(image: Image, time: number): HandLandmarkerResult; close(): void }
export type HandModelFactory = (delegate: Delegate) => Promise<HandModel>;
const createModel: HandModelFactory = async delegate => {
  const files = await FilesetResolver.forVisionTasks("./ar-vendor/mediapipe");
  return HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: "./ar-vendor/hand_landmarker.task", delegate },
    runningMode: "VIDEO", numHands: 1,
    minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55,
  });
};

/** GPU is attempted first; unsupported/lost WebGL falls back once to CPU.
 * The selected delegate is reported, rather than inferring acceleration from FPS. */
export class HandRuntime {
  private model: HandModel | null = null;
  private pending: Promise<void> | null = null;
  requested: Delegate = "GPU";
  active: Delegate | null = null;
  fallbackReason: string | null = null;
  private closed = false;
  constructor(private readonly event: (kind: string, data: unknown) => void, private readonly factory: HandModelFactory = createModel) {}
  snapshot(): { requested: Delegate; active: Delegate | null; loading: boolean; fallbackReason: string | null } {
    return { requested: this.requested, active: this.active, loading: this.pending !== null, fallbackReason: this.fallbackReason };
  }
  load(preferred: Delegate = this.requested): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Hand runtime is closed"));
    if (this.pending) return this.pending;
    if (this.model) return Promise.resolve();
    this.requested = preferred;
    this.pending = (async () => {
      for (const delegate of preferred === "GPU" ? ["GPU", "CPU"] as const : ["CPU"] as const) {
        try {
          const model = await this.factory(delegate);
          if (this.closed) { model.close(); return; }
          this.model = model; this.active = delegate;
          this.event("hands-ready", this.snapshot());
          return;
        } catch (error) {
          if (delegate === "CPU") { this.event("hands-load-error", String(error)); throw error; }
          this.fallbackReason = String(error);
          this.event("hands-gpu-fallback", { phase: "initialization", reason: this.fallbackReason });
        }
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  detect(image: Image, time: number): HandLandmarkerResult | null {
    if (!this.model) return null;
    try { return this.model.detectForVideo(image, time); }
    catch (error) {
      if (this.active !== "GPU") throw error;
      this.fallbackReason = String(error);
      this.event("hands-gpu-fallback", { phase: "inference", reason: this.fallbackReason });
      try { this.model.close(); } catch { /* A lost GPU context may already be disposed. */ }
      this.model = null; this.active = null;
      // Keep the camera/table alive while replacing only the hand backend.
      const requested=this.requested;void this.load("CPU").catch(() => {});this.requested=requested;
      return null;
    }
  }
  close(): void {
    this.closed = true; this.model?.close(); this.model = null; this.active = null;
  }
}
