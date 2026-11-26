// The 2D parts of the motion page, drawn with CanvasIR: the landmarks over the camera's image, and the timeline with a
// lane per body part showing, frame by frame, whether it was seen, held or only assumed.
import { Components, EventRouter, Renderer, Scene, type RecordingContext } from "canvas-ir";
import { type Playback, playButton, scrubber } from "@canvas-ir/toolkit";
import { type Body, type Frame, HAND_LINES, type JointName, P, POSE_LINES, type TakeLabel, type TakeMark } from "@canvas-ir/motion";

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** A canvas kept at its element's size and the screen's pixel density, with a scene, a renderer and a router of its own. */
class Canvas2D {
  readonly scene = new Scene({ version: 1, ops: [] });
  readonly router: EventRouter;
  readonly ui: Components;
  private readonly renderer: Renderer;
  width = 0;
  height = 0;
  private queued = false;

  constructor(readonly canvas: HTMLCanvasElement, private readonly onResize: () => void) {
    this.renderer = new Renderer(this.scene, canvas.getContext("2d")!, { lod: false });
    this.router = new EventRouter(this.scene, { dragThreshold: 2 });
    this.ui = new Components(this.scene, this.router, { onChange: () => this.render() });
    const at = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, pointerId: e.pointerId };
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.router.pointerDown(at(e));
    });
    canvas.addEventListener("pointermove", (e) => {
      this.router.pointerMove(at(e));
      canvas.style.cursor = this.ui.cursor ?? "";
    });
    canvas.addEventListener("pointerup", (e) => this.router.pointerUp(at(e)));
    canvas.addEventListener("pointercancel", () => this.router.pointerCancel());
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.renderer.setView({ a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 }, this.canvas.width, this.canvas.height);
    this.onResize();
    this.render();
  }

  render(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.renderer.render();
    });
  }
}

/** Which skeleton joint each body landmark stands for, to pick a joint by its landmark. */
const LANDMARK_JOINT: Partial<Record<number, JointName>> = {
  [P.nose]: "head", [P.leftEar]: "head", [P.rightEar]: "head",
  [P.leftShoulder]: "leftShoulder", [P.rightShoulder]: "rightShoulder", [P.leftElbow]: "leftElbow", [P.rightElbow]: "rightElbow",
  [P.leftWrist]: "leftWrist", [P.rightWrist]: "rightWrist", [P.leftIndex]: "leftHandTip", [P.rightIndex]: "rightHandTip",
  [P.leftHip]: "leftHip", [P.rightHip]: "rightHip", [P.leftKnee]: "leftKnee", [P.rightKnee]: "rightKnee",
  [P.leftAnkle]: "leftAnkle", [P.rightAnkle]: "rightAnkle", [P.leftFootIndex]: "leftToe", [P.rightFootIndex]: "rightToe",
};

interface OverlayState {
  frame: Frame | null;
  /** The image's size, for its aspect. */
  image: { width: number; height: number };
  /** Whether a video is under the drawing; with none, the image's place is drawn. */
  video: boolean;
  selected: JointName | null;
  visible: number;
  /** What was being done now, by the labels in force. */
  labels: readonly TakeLabel[];
  /** Marks drawn on the image now. */
  marks: readonly TakeMark[];
  /** Whether a still image of the take is under the drawing, in place of a video. */
  still: boolean;
  /** Whether the canvas is shown mirrored, so text is drawn the other way round to read right. */
  mirrored: boolean;
}

/** The landmarks drawn over the image: the body's stick figure, faint where the tracker was unsure, and the hands. */
export class Overlay {
  private readonly c: Canvas2D;
  private readonly handle;

  constructor(canvas: HTMLCanvasElement, private readonly onPick: (joint: JointName) => void) {
    this.c = new Canvas2D(canvas, () => this.handle?.redraw());
    this.handle = this.c.ui.mount<OverlayState>({
      id: "overlay",
      state: { frame: null, image: { width: 640, height: 480 }, video: false, selected: null, visible: 0.5, labels: [], marks: [], still: false, mirrored: false },
      cursor: (_s, ui) => (ui.hoveredParts.some((g) => /lm-\d+$/.test(g.id)) ? "pointer" : null),
      draw: (ctx, s) => this.draw(ctx, s),
      on: {
        down: (e) => {
          const lm = e.path.map((id) => /lm-(\d+)$/.exec(id)).find(Boolean);
          const joint = lm ? LANDMARK_JOINT[Number(lm[1])] : undefined;
          if (joint) this.onPick(joint);
        },
      },
    });
  }

  /** Text that reads right on a canvas shown mirrored: drawn flipped about where it starts. */
  private text(ctx: RecordingContext, s: OverlayState, text: string, x: number, y: number, box?: string): void {
    const w = ctx.measureText(text).width;
    ctx.save();
    if (s.mirrored) {
      ctx.translate(x, 0);
      ctx.scale(-1, 1);
      x = 0;
    }
    if (box) {
      const fill = ctx.fillStyle;
      ctx.fillStyle = box;
      ctx.fillRect(x - 5, y - 15, w + 10, 20);
      ctx.fillStyle = fill;
    }
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawMarks(ctx: RecordingContext, s: OverlayState, marks: readonly TakeMark[], X: (l: { x: number }) => number, Y: (l: { y: number }) => number): void {
    for (const m of marks) {
      const pts = m.points.map(([x, y]) => ({ x: X({ x }), y: Y({ y }) }));
      if (!pts.length) continue;
      ctx.strokeStyle = m.color ?? "#facc15";
      ctx.fillStyle = m.color ?? "#facc15";
      ctx.lineWidth = 3;
      ctx.setLineDash(m.kind === "line" ? [8, 6] : []);
      if (m.kind === "box" && pts.length >= 2) ctx.strokeRect(pts[0]!.x, pts[0]!.y, pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      if ((m.kind === "line" || m.kind === "arrow") && pts.length >= 2) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        if (m.kind === "arrow") {
          const a = pts[pts.length - 2]!;
          const c = pts[pts.length - 1]!;
          const angle = Math.atan2(c.y - a.y, c.x - a.x);
          ctx.beginPath();
          ctx.moveTo(c.x - 14 * Math.cos(angle - 0.5), c.y - 14 * Math.sin(angle - 0.5));
          ctx.lineTo(c.x, c.y);
          ctx.lineTo(c.x - 14 * Math.cos(angle + 0.5), c.y - 14 * Math.sin(angle + 0.5));
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      if (m.text) {
        ctx.font = `600 14px ${FONT}`;
        const at = pts[0]!;
        ctx.fillStyle = m.color ?? "#facc15";
        this.text(ctx, s, m.text, at.x + 5, at.y - 5, "rgba(15, 23, 42, 0.75)");
      }
    }
  }

  /** Where the image is on the canvas: fitted inside it, as the video element shows it. */
  private box(s: OverlayState): { x: number; y: number; w: number; h: number } {
    const k = Math.min(this.c.width / s.image.width, this.c.height / s.image.height);
    const w = s.image.width * k;
    const h = s.image.height * k;
    return { x: (this.c.width - w) / 2, y: (this.c.height - h) / 2, w, h };
  }

  show(next: Partial<OverlayState>): void {
    this.handle.setState(next);
  }

  private draw(ctx: RecordingContext, s: OverlayState): void {
    const b = this.box(s);
    if (!s.video && !s.still) {
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#64748b";
      ctx.font = `13px ${FONT}`;
      this.text(ctx, s, "no images in this take", s.mirrored ? b.x + b.w - 12 : b.x + 12, b.y + 22);
    }
    const X = (l: { x: number }) => b.x + l.x * b.w;
    const Y = (l: { y: number }) => b.y + l.y * b.h;
    this.drawMarks(ctx, s, s.marks, X, Y);
    // What the person (or a watcher) said was being done now, along the image's bottom.
    ctx.font = `600 14px ${FONT}`;
    s.labels.forEach((l, i) => {
      ctx.fillStyle = l.by === "watcher" ? "#facc15" : "#f8fafc";
      const y = b.y + b.h - 14 - i * 24;
      this.text(ctx, s, l.text, s.mirrored ? b.x + b.w - 14 : b.x + 14, y, "rgba(15, 23, 42, 0.7)");
    });
    const f = s.frame;
    if (!f) return;
    ctx.lineCap = "round";
    const img = f.pose?.image;
    if (img) {
      for (const [a, c] of POSE_LINES) {
        const vis = Math.min(img[a]!.visibility ?? 1, img[c]!.visibility ?? 1);
        ctx.strokeStyle = vis >= s.visible ? "rgba(52, 211, 153, 0.95)" : "rgba(248, 113, 113, 0.35)";
        ctx.lineWidth = vis >= s.visible ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(X(img[a]!), Y(img[a]!));
        ctx.lineTo(X(img[c]!), Y(img[c]!));
        ctx.stroke();
      }
      img.forEach((l, i) => {
        if (i > 0 && i < 11 && i !== P.leftEar && i !== P.rightEar) return;
        const joint = LANDMARK_JOINT[i];
        const vis = l.visibility ?? 1;
        ctx.save();
        ctx.beginGroup({ id: `lm-${i}` });
        ctx.fillStyle = joint && joint === s.selected ? "#facc15" : vis >= s.visible ? "#ecfdf5" : "rgba(248, 113, 113, 0.5)";
        ctx.beginPath();
        ctx.arc(X(l), Y(l), joint && joint === s.selected ? 8 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.endGroup();
        ctx.restore();
      });
    }
    for (const h of f.hands) {
      ctx.strokeStyle = h.side === "left" ? "#93c5fd" : h.side === "right" ? "#fca5a5" : "#e2e8f0";
      ctx.lineWidth = 2;
      for (const [a, c] of HAND_LINES) {
        ctx.beginPath();
        ctx.moveTo(X(h.image[a]!), Y(h.image[a]!));
        ctx.lineTo(X(h.image[c]!), Y(h.image[c]!));
        ctx.stroke();
      }
    }
  }
}

/** The parts the timeline has a lane for, and the joint whose source each lane shows. */
const LANES: readonly { label: string; joint?: JointName; hand?: "left" | "right" }[] = [
  { label: "Head", joint: "head" },
  { label: "Torso", joint: "chest" },
  { label: "Left arm", joint: "leftWrist" },
  { label: "Right arm", joint: "rightWrist" },
  { label: "Left hand", hand: "left" },
  { label: "Right hand", hand: "right" },
  { label: "Legs", joint: "leftAnkle" },
];
const SOURCE_COLORS = { seen: "#10b981", held: "#f59e0b", assumed: "#cbd5e1", none: "#f1f5f9" } as const;

interface TimelineState {
  labels: readonly TakeLabel[];
  bodies: readonly Body[];
  duration: number;
  /** Frames recorded so far while recording, for the count. */
  recording: number | null;
}

/**
 * The timeline: a play button, the time, and a lane per part, scrubbed by dragging anywhere on the lanes. It plays a
 * `Playback` (the toolkit's), and shows its time and whether it plays; the arrows step a frame and Space plays.
 */
export class Timeline {
  private readonly c: Canvas2D;
  private readonly lanes;
  private readonly head;
  private readonly play;
  private static readonly LEFT = 96;
  private static readonly TOP = 48;
  private static readonly LANE = 15;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly playback: Playback,
  ) {
    this.c = new Canvas2D(canvas, () => {
      this.lanes?.redraw();
      this.head?.redraw();
      this.c?.ui.get("scrub")?.redraw();
    });
    this.lanes = this.c.ui.mount<TimelineState>({
      id: "lanes",
      state: { labels: [], bodies: [], duration: 0, recording: null },
      draw: (ctx, s) => this.drawLanes(ctx, s),
    });
    // Over the lanes, a scrub bar as wide as them: it holds no drawing of its own but takes the presses, drags and keys.
    this.c.ui.mount(
      scrubber({
        id: "scrub",
        playback,
        label: "Take time",
        timeAt: (e) => Math.max(0, Math.min(1, (e.point.x - Timeline.LEFT) / (this.c.width - Timeline.LEFT - 12))) * playback.duration,
        draw: (ctx) => {
          // A transparent target, kept for hit tests.
          ctx.beginGroup({ id: "area", meta: { hitArea: true } });
          ctx.fillStyle = "rgba(0,0,0,0)";
          ctx.fillRect(Timeline.LEFT, Timeline.TOP - Timeline.LANE - 6, Math.max(0, this.c.width - Timeline.LEFT - 12), (LANES.length + 1) * Timeline.LANE + 6);
          ctx.endGroup();
        },
      }),
    );
    this.head = this.c.ui.mount<{ t: number }>({
      id: "playhead",
      state: { t: 0 },
      draw: (ctx, s) => this.drawHead(ctx, s.t),
    });
    this.play = this.c.ui.mount(
      playButton({
      id: "play",
      playback,
      draw: (ctx, s, ui) => {
        ctx.fillStyle = ui.hovered ? "#1e293b" : "#0f172a";
        ctx.beginPath();
        ctx.arc(20, 15, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        if (s.playing) {
          ctx.fillRect(15, 9, 4, 12);
          ctx.fillRect(21, 9, 4, 12);
        } else {
          ctx.beginPath();
          ctx.moveTo(16, 8);
          ctx.lineTo(26, 15);
          ctx.lineTo(16, 22);
          ctx.closePath();
          ctx.fill();
        }
      },
      }),
    );
    playback.onChange((t, playing) => {
      if (this.head.state.t !== t) this.head.setState({ t });
      if (this.play.state.playing !== playing) this.play.setState({ playing });
    });
  }

  setTake(bodies: readonly Body[], duration: number, labels: readonly TakeLabel[] = []): void {
    this.lanes.setState({ bodies, duration, recording: null, labels });
    this.head.setState({ t: this.playback.t });
  }

  setRecording(frames: number | null, duration = 0): void {
    this.lanes.setState(frames === null ? { recording: null } : { recording: frames, duration });
    this.head.redraw();
  }

  setLabels(labels: readonly TakeLabel[]): void {
    this.lanes.setState({ labels });
  }

  private drawLanes(ctx: RecordingContext, s: TimelineState): void {
    const left = Timeline.LEFT;
    const w = this.c.width - left - 12;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.c.width, this.c.height);
    ctx.font = `12px ${FONT}`;
    ctx.textBaseline = "middle";
    if (s.recording !== null) {
      ctx.fillStyle = "#dc2626";
      ctx.fillText(`● Recording, ${s.recording} frames`, 44, 15);
    }
    // The labels: what was being done, as bars with their words.
    {
      const y = Timeline.TOP - Timeline.LANE - 4;
      ctx.fillStyle = "#475569";
      ctx.fillText("Doing", 8, y + Timeline.LANE / 2);
      const sorted = [...s.labels].sort((a, b) => a.t0 - b.t0);
      const end = s.duration || Math.max(0, ...sorted.map((l) => l.t1 ?? l.t0));
      sorted.forEach((l, i) => {
        if (!end) return;
        const next = sorted.slice(i + 1).find((n) => (n.by ?? "person") === (l.by ?? "person"));
        const t1 = l.t1 ?? next?.t0 ?? end;
        const x0 = left + (l.t0 / end) * w;
        const x1 = left + (t1 / end) * w;
        ctx.fillStyle = l.by === "watcher" ? (i % 2 ? "#ddd6fe" : "#c4b5fd") : i % 2 ? "#bfdbfe" : "#93c5fd";
        ctx.fillRect(x0, y + 1, Math.max(2, x1 - x0 - 1), Timeline.LANE - 2);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, Math.max(0, x1 - x0 - 2), Timeline.LANE);
        ctx.clip();
        ctx.fillStyle = "#0f172a";
        ctx.font = `11px ${FONT}`;
        ctx.fillText(l.text, x0 + 3, y + Timeline.LANE / 2);
        ctx.restore();
        ctx.font = `12px ${FONT}`;
      });
    }
    LANES.forEach((lane, li) => {
      const y = Timeline.TOP + li * Timeline.LANE;
      ctx.fillStyle = "#475569";
      ctx.fillText(lane.label, 8, y + Timeline.LANE / 2);
      ctx.fillStyle = SOURCE_COLORS.none;
      ctx.fillRect(left, y + 2, w, Timeline.LANE - 4);
      const n = s.bodies.length;
      if (!n || !s.duration) return;
      const sourceAt = (b: Body): keyof typeof SOURCE_COLORS => (lane.hand ? (b.hands[lane.hand] ? "seen" : "none") : b.joints[lane.joint!].source);
      // Runs of one source are drawn as one bar.
      let start = 0;
      for (let i = 1; i <= n; i++) {
        const src = sourceAt(s.bodies[start]!);
        if (i < n && sourceAt(s.bodies[i]!) === src) continue;
        const x0 = left + (s.bodies[start]!.t / s.duration) * w;
        const x1 = left + ((i < n ? s.bodies[i]!.t : s.duration) / s.duration) * w;
        ctx.fillStyle = SOURCE_COLORS[src];
        ctx.fillRect(x0, y + 2, Math.max(1, x1 - x0), Timeline.LANE - 4);
        start = i;
      }
    });
    const legendY = Timeline.TOP + LANES.length * Timeline.LANE + 12;
    let x = left;
    for (const [name, color] of [["seen", SOURCE_COLORS.seen], ["held", SOURCE_COLORS.held], ["assumed", SOURCE_COLORS.assumed]] as const) {
      ctx.fillStyle = color;
      ctx.fillRect(x, legendY - 5, 10, 10);
      ctx.fillStyle = "#475569";
      ctx.fillText(name, x + 14, legendY);
      x += 80;
    }
  }

  private drawHead(ctx: RecordingContext, t: number): void {
    const s = this.lanes.state;
    const left = Timeline.LEFT;
    const w = this.c.width - left - 12;
    ctx.font = `600 12px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f172a";
    if (s.recording !== null) return;
    ctx.fillText(`${(t / 1000).toFixed(2)} s / ${(s.duration / 1000).toFixed(2)} s`, 44, 15);
    if (!s.duration) return;
    const x = left + (Math.min(t, s.duration) / s.duration) * w;
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, Timeline.TOP - Timeline.LANE - 6);
    ctx.lineTo(x, Timeline.TOP + LANES.length * Timeline.LANE);
    ctx.stroke();
  }
}
