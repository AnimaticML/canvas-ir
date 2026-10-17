import { type ComponentSpec, type IRDocument, type Morph, RecordingContext, morph } from "canvas-ir";

// A pelican riding a bicycle, drawn with plain canvas calls. Every moving
// part is drawn in its own frame (translate, then rotate), so a pose is a set
// of angles: the morph between two poses turns each part about its joint.

/** The canvas calls the drawing uses: a real 2D context or a recorder. */
type Ctx = CanvasRenderingContext2D;

export interface Pose {
  /** The crank's angle, radians, clockwise from pointing forward. */
  readonly crank: number;
  /** How far the bike has gone, which slides the road and the clouds back. */
  readonly travel: number;
  /**
   * Where the clouds last wrapped around, in travel. Two poses with the same
   * value place the clouds without a wrap between them, so a morph never
   * sweeps a cloud across the sky.
   */
  readonly wrapFrom?: number;
}

/** How far the bike goes for each turn of the crank: the wheels turn twice. */
export const TRAVEL_PER_TURN = 2 * 2 * Math.PI * 74;

export const PELICAN_SIZE = { width: 640, height: 440 };

const GROUND = 396;
const WHEEL_R = 74;
const REAR = { x: 168, y: GROUND - WHEEL_R };
const FRONT = { x: 478, y: GROUND - WHEEL_R };
const BB = { x: 300, y: 316 };
const SEAT = { x: 262, y: 206 };
const HEAD_TOP = { x: 420, y: 196 };
const HEAD_BOTTOM = { x: 432, y: 236 };
const BAR = { x: 412, y: 166 };
const CRANK = 26;
const HIP = { x: 264, y: 182 };
const THIGH = 92;
const SHIN = 72;

const C = {
  sky: "#e0f2fe",
  road: "#cbd5e1",
  roadLine: "#f8fafc",
  frame: "#0e7490",
  frameLight: "#22d3ee",
  tire: "#1f2937",
  rim: "#94a3b8",
  spoke: "#cbd5e1",
  body: "#ffffff",
  bodyShade: "#e2e8f0",
  outline: "#475569",
  wing: "#f1f5f9",
  wingTip: "#334155",
  beak: "#fbbf24",
  beakEdge: "#d97706",
  pouch: "#fb923c",
  leg: "#f97316",
  legDark: "#c2410c",
  eye: "#0f172a",
  crest: "#fde68a",
};

/** Hip, knee and foot for a pedal, with the knee forward of the line from hip to pedal. */
const legFor = (pedal: { x: number; y: number }) => {
  const dx = pedal.x - HIP.x;
  const dy = pedal.y - HIP.y;
  const d = Math.min(Math.hypot(dx, dy), THIGH + SHIN - 0.5);
  const toPedal = Math.atan2(dy, dx);
  const bend = Math.acos((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d));
  // Of the two knees, the one forward of the line (a rider's knee points ahead).
  const options = [toPedal - bend, toPedal + bend].map((a) => ({ a, knee: { x: HIP.x + THIGH * Math.cos(a), y: HIP.y + THIGH * Math.sin(a) } }));
  const { a, knee } = options[0]!.knee.x > options[1]!.knee.x ? options[0]! : options[1]!;
  const shin = Math.atan2(pedal.y - knee.y, pedal.x - knee.x);
  return { thigh: a, knee, shin };
};

export const drawPelican = (ctx: Ctx, pose: Pose): void => {
  const rec = ctx as unknown as { beginGroup?: (o: { id?: string; meta?: object }) => string; endGroup?: () => void };
  const part = (name: string, body: () => void): void => {
    rec.beginGroup?.({ meta: { name } });
    ctx.save();
    body();
    ctx.restore();
    rec.endGroup?.();
  };
  const { crank, travel } = pose;
  const wrapFrom = pose.wrapFrom ?? travel;
  // The wheels turn twice for each turn of the crank; the body bobs a little with the pedals.
  const wheel = crank * 2;
  const bob = Math.sin(crank * 2) * 1.5;

  part("sky", () => {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND);
    g.addColorStop(0, "#bae6fd");
    g.addColorStop(1, "#f0f9ff");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, 0, PELICAN_SIZE.width, GROUND + 20, 14);
    ctx.fill();
    // Clouds stay in the sky as they drift out of it.
    ctx.clip();
    // Clouds drift back slowly, a little each turn of the crank.
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    for (const [x, y, s] of [[90, 70, 1], [520, 110, 0.8], [600, 240, 0.55]] as const) {
      // Wrapped into [-80, 720) where the clouds were at wrapFrom, then moved on from there.
      const at0 = x - wrapFrom * 0.05 * s;
      const cx = (((at0 + 80) % 800) + 800) % 800 - 80 - (travel - wrapFrom) * 0.05 * s;
      ctx.beginPath();
      ctx.ellipse(cx, y, 34 * s, 13 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 20 * s, y - 9 * s, 22 * s, 14 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - 18 * s, y - 5 * s, 18 * s, 11 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  part("road", () => {
    ctx.fillStyle = C.road;
    ctx.beginPath();
    ctx.roundRect(0, GROUND, PELICAN_SIZE.width, 28, 6);
    ctx.fill();
    // Dashes slide back as the bike moves: the dash offset follows the wheel.
    ctx.strokeStyle = C.roadLine;
    ctx.lineWidth = 4;
    ctx.setLineDash([26, 22]);
    ctx.lineDashOffset = travel;
    ctx.beginPath();
    ctx.moveTo(8, GROUND + 14);
    ctx.lineTo(PELICAN_SIZE.width - 8, GROUND + 14);
    ctx.stroke();
    ctx.setLineDash([]);
    // The bike's shadow.
    ctx.fillStyle = "rgba(15, 23, 42, 0.18)";
    ctx.beginPath();
    ctx.ellipse((REAR.x + FRONT.x) / 2, GROUND + 2, 200, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  const pedalAt = (a: number) => ({ x: BB.x + CRANK * Math.cos(a), y: BB.y + CRANK * Math.sin(a) });
  const near = pedalAt(crank);
  const far = pedalAt(crank + Math.PI);

  const drawLeg = (name: string, pedal: { x: number; y: number }, shade: boolean) =>
    part(name, () => {
      const { thigh, knee, shin } = legFor(pedal);
      const color = shade ? C.legDark : C.leg;
      ctx.fillStyle = color;
      // Thigh: feathered at the top, from the hip.
      ctx.save();
      ctx.translate(HIP.x, HIP.y);
      ctx.rotate(thigh);
      ctx.fillStyle = shade ? C.bodyShade : C.body;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(THIGH * 0.42, 0, THIGH * 0.58, 17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      // Shin: a thin orange leg from the knee to the pedal.
      ctx.save();
      ctx.translate(knee.x, knee.y);
      ctx.rotate(shin);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(-3, -3.5, SHIN + 2, 7, 3.5);
      ctx.fill();
      // A webbed foot on the pedal, toes forward, flat whatever the shin's angle.
      ctx.translate(SHIN, 0);
      ctx.rotate(-shin);
      ctx.beginPath();
      ctx.moveTo(-6, -4);
      ctx.quadraticCurveTo(12, -8, 28, -4);
      ctx.lineTo(25, 0);
      ctx.lineTo(29, 3);
      ctx.lineTo(24, 5);
      ctx.quadraticCurveTo(8, 8, -8, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });

  const drawPedal = (name: string, a: number) =>
    part(name, () => {
      ctx.translate(BB.x, BB.y);
      ctx.rotate(a);
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(CRANK, 0);
      ctx.stroke();
      // The pedal stays level as the crank turns.
      ctx.translate(CRANK, 0);
      ctx.rotate(-a);
      ctx.fillStyle = "#475569";
      ctx.fillRect(-11, -3, 22, 6);
    });

  const drawWheel = (name: string, center: { x: number; y: number }) =>
    part(name, () => {
      ctx.translate(center.x, center.y);
      ctx.strokeStyle = C.tire;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(0, 0, WHEEL_R - 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = C.rim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, WHEEL_R - 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.rotate(wheel);
      ctx.strokeStyle = C.spoke;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const s = (i * Math.PI) / 6;
        ctx.moveTo(4 * Math.cos(s + 0.4), 4 * Math.sin(s + 0.4));
        ctx.lineTo((WHEEL_R - 10) * Math.cos(s), (WHEEL_R - 10) * Math.sin(s));
      }
      ctx.stroke();
      ctx.fillStyle = "#64748b";
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
    });

  // Far side first: the far leg and pedal, then the bike, then the near leg, body, neck and head.
  drawLeg("far leg", far, true);
  drawPedal("far pedal", crank + Math.PI);
  drawWheel("rear wheel", REAR);
  drawWheel("front wheel", FRONT);

  part("frame", () => {
    ctx.strokeStyle = C.frame;
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    // Chain stay, seat stay, seat tube, top tube, down tube.
    ctx.moveTo(REAR.x, REAR.y);
    ctx.lineTo(BB.x, BB.y);
    ctx.lineTo(SEAT.x + 4, SEAT.y + 14);
    ctx.lineTo(REAR.x, REAR.y);
    ctx.moveTo(SEAT.x + 6, SEAT.y + 22);
    ctx.lineTo(HEAD_TOP.x, HEAD_TOP.y + 6);
    ctx.moveTo(BB.x, BB.y);
    ctx.lineTo(HEAD_BOTTOM.x, HEAD_BOTTOM.y);
    ctx.stroke();
    // Head tube and fork.
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(HEAD_TOP.x, HEAD_TOP.y);
    ctx.lineTo(HEAD_BOTTOM.x, HEAD_BOTTOM.y);
    ctx.quadraticCurveTo(HEAD_BOTTOM.x + 14, FRONT.y - 40, FRONT.x, FRONT.y);
    ctx.stroke();
    // A highlight along the top tube.
    ctx.strokeStyle = C.frameLight;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(SEAT.x + 14, SEAT.y + 19);
    ctx.lineTo(HEAD_TOP.x - 8, HEAD_TOP.y + 3);
    ctx.stroke();
    // Stem and handlebar, curving back to the grip.
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(HEAD_TOP.x, HEAD_TOP.y);
    ctx.lineTo(HEAD_TOP.x + 2, BAR.y + 6);
    ctx.quadraticCurveTo(HEAD_TOP.x + 6, BAR.y - 6, BAR.x - 6, BAR.y - 4);
    ctx.stroke();
    // The chain, from the chainring round the rear cog.
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(BB.x, BB.y - 17);
    ctx.lineTo(REAR.x, REAR.y - 9);
    ctx.arc(REAR.x, REAR.y, 9, -Math.PI / 2, Math.PI / 2, true);
    ctx.lineTo(BB.x, BB.y + 17);
    ctx.stroke();
    // The chainring.
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(BB.x, BB.y, 17, 0, Math.PI * 2);
    ctx.stroke();
    // Saddle.
    ctx.fillStyle = "#1f2937";
    ctx.beginPath();
    ctx.moveTo(SEAT.x - 26, SEAT.y + 4);
    ctx.quadraticCurveTo(SEAT.x - 10, SEAT.y - 6, SEAT.x + 22, SEAT.y + 2);
    ctx.quadraticCurveTo(SEAT.x + 6, SEAT.y + 12, SEAT.x - 26, SEAT.y + 4);
    ctx.fill();
  });

  drawPedal("near pedal", crank);
  // The near leg goes under the body, which covers the top of the thigh.
  drawLeg("near leg", near, false);

  part("rider", () => {
    ctx.translate(0, bob);
    part("tail", () => {
      ctx.fillStyle = C.bodyShade;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(196, 150);
      ctx.lineTo(150, 168);
      ctx.lineTo(160, 176);
      ctx.lineTo(148, 186);
      ctx.lineTo(202, 182);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
    part("body", () => {
      ctx.fillStyle = C.body;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(258, 152, 72, 46, -0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Shade under the belly.
      ctx.fillStyle = C.bodyShade;
      ctx.beginPath();
      ctx.ellipse(250, 176, 52, 16, -0.25, 0, Math.PI);
      ctx.fill();
    });
    part("neck", () => {
      // An S from the chest up and back over the body to the head.
      ctx.fillStyle = C.body;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(300, 132);
      ctx.bezierCurveTo(338, 110, 306, 72, 318, 46);
      ctx.lineTo(346, 44);
      ctx.bezierCurveTo(334, 76, 360, 112, 318, 150);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
    part("wing", () => {
      // The wing reaches forward to the handlebar and holds it with its tip.
      ctx.fillStyle = C.wing;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(214, 132);
      ctx.bezierCurveTo(262, 104, 330, 118, BAR.x - 2, BAR.y - 10);
      ctx.bezierCurveTo(BAR.x + 6, BAR.y - 6, BAR.x + 2, BAR.y + 6, BAR.x - 10, BAR.y + 4);
      ctx.bezierCurveTo(338, 170, 270, 176, 214, 132);
      ctx.fill();
      ctx.stroke();
      // Dark flight feathers along the trailing edge.
      ctx.fillStyle = C.wingTip;
      ctx.beginPath();
      ctx.moveTo(222, 140);
      ctx.bezierCurveTo(270, 168, 320, 166, 352, 158);
      ctx.lineTo(344, 168);
      ctx.lineTo(330, 164);
      ctx.lineTo(318, 172);
      ctx.lineTo(304, 166);
      ctx.lineTo(290, 172);
      ctx.lineTo(278, 164);
      ctx.bezierCurveTo(254, 162, 236, 154, 222, 140);
      ctx.fill();
    });
    part("head", () => {
      ctx.translate(332, 40);
      // Pouch under the beak, then the beak, then the head over its root.
      ctx.fillStyle = C.pouch;
      ctx.strokeStyle = C.beakEdge;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(14, 8);
      ctx.bezierCurveTo(40, 52, 110, 52, 150, 30);
      ctx.lineTo(150, 22);
      ctx.bezierCurveTo(110, 26, 60, 18, 14, 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = C.beak;
      ctx.beginPath();
      ctx.moveTo(10, -6);
      ctx.bezierCurveTo(60, -6, 120, 8, 156, 20);
      // A hooked tip.
      ctx.quadraticCurveTo(164, 26, 154, 30);
      ctx.bezierCurveTo(116, 24, 60, 14, 10, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = C.beakEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(24, 1);
      ctx.bezierCurveTo(70, 6, 116, 15, 150, 25);
      ctx.stroke();
      ctx.fillStyle = C.body;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(-2, -1, 26, 21, -0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // A tuft of pale crest feathers.
      ctx.fillStyle = C.crest;
      ctx.beginPath();
      ctx.moveTo(-14, -12);
      ctx.quadraticCurveTo(-30, -26, -36, -14);
      ctx.quadraticCurveTo(-26, -16, -18, -6);
      ctx.closePath();
      ctx.fill();
      // The eye, with a highlight.
      ctx.fillStyle = C.eye;
      ctx.beginPath();
      ctx.arc(6, -4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(7.5, -5.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
    });
  });

};

export const PELICAN_ID = "pelican";

/** One pose, recorded as the pelican's group at `at` on the board. */
const recordPose = (pose: Pose, at: { x: number; y: number }): IRDocument => {
  const ctx = new RecordingContext();
  ctx.beginGroup({ id: PELICAN_ID, meta: { source: "pelican", role: "img", label: "A pelican riding a bicycle" } });
  ctx.translate(at.x, at.y);
  drawPelican(ctx as unknown as CanvasRenderingContext2D, pose);
  ctx.endGroup();
  return ctx.getDocument();
};

/** Poses drawn per turn of the crank; the morph fills in between them. */
export const POSES_PER_TURN = 8;
const STEP = TRAVEL_PER_TURN / POSES_PER_TURN;

/**
 * The ride as a sequence of drawn poses, an eighth of a crank turn apart.
 * `at(p)` gives the drawing at pose `p` (fractional): the morph from pose
 * floor(p) to the next, which turns each part about its joint. Each pair of
 * poses shares where the clouds wrapped, so none sweeps across the sky.
 */
export class Ride {
  private pair = -1;
  private current: Morph | null = null;

  constructor(private readonly at: { x: number; y: number }) {}

  pose(k: number, wrapFrom = k * STEP): Pose {
    return { crank: (k * 2 * Math.PI) / POSES_PER_TURN, travel: k * STEP, wrapFrom };
  }

  frame(p: number): IRDocument {
    const k = Math.floor(p);
    if (k !== this.pair || !this.current) {
      this.pair = k;
      this.current = morph(recordPose(this.pose(k), this.at), recordPose(this.pose(k + 1, k * STEP), this.at));
    }
    return this.current.at(p - k);
  }

  /** How many ops the last morph paired, faded out and faded in. */
  get stats(): { paired: number; removed: number; added: number } | null {
    return this.current && { paired: this.current.paired, removed: this.current.removed, added: this.current.added };
  }
}

/** A Ride / Stop button drawn on the board under the picture. */
export const rideButton = (at: { x: number; y: number }, toggle: () => void): ComponentSpec<{ riding: boolean }> => {
  const x = at.x;
  const y = at.y + PELICAN_SIZE.height + 22;
  return {
    id: "pelican-ride",
    state: { riding: true },
    meta: ({ riding }) => ({ source: "pelican controls", role: "button", label: riding ? "Stop pedaling" : "Ride" }),
    cursor: "pointer",
    draw: (c, { riding }, ui) => {
      c.fillStyle = ui.pressed ? "#c2410c" : ui.hovered ? "#fb923c" : "#f97316";
      c.beginPath();
      c.roundRect(x, y - 16, 96, 32, 16);
      c.fill();
      if (ui.focused) {
        c.strokeStyle = "#fed7aa";
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = "#ffffff";
      if (riding) c.fillRect(x + 18, y - 6, 12, 12);
      else {
        c.beginPath();
        c.moveTo(x + 18, y - 8);
        c.lineTo(x + 31, y);
        c.lineTo(x + 18, y + 8);
        c.closePath();
        c.fill();
      }
      c.font = "600 13px system-ui, sans-serif";
      c.textBaseline = "middle";
      c.fillText(riding ? "Stop" : "Ride", x + 40, y + 1);
      c.fillStyle = "#6b7280";
      c.font = "12px system-ui, sans-serif";
      c.fillText(`${POSES_PER_TURN} poses drawn per pedal turn; the morph draws every frame between them`, x + 112, y + 1);
    },
    on: {
      click: (e) => {
        e.stopPropagation();
        toggle();
      },
    },
  };
};
