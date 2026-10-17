// Pelican Ride: the pelican from the playground on a course of hills, crates
// and lakes. Everything is drawn as canvas code into one CanvasIR scene.
// planck.js runs the bicycle (a frame on two sprung wheel joints, the rear
// one driven); each body moves its group by a live transform. The legs pedal
// as the rear wheel turns: the rider is a clip of eight drawn poses per crank
// turn, and the wing a clip of grip, up and down poses, morphed between.
import { Clip, RecordingContext, Renderer, Scene, drawing, easings } from "canvas-ir";
import { Physics } from "@canvas-ir/physics";
import { Box, Circle, type Body, type Contact, type Fixture, WheelJoint } from "planck";
import { PELICAN_GEOMETRY, type WingPose, drawPelican, drawWheel, drawWing } from "./pelican";

// --- The course ---

/** The pelican drawing's scale in the game. */
const K = 0.42;
const WHEEL_R = PELICAN_GEOMETRY.wheelRadius * K;
const AXLES = { x: (PELICAN_GEOMETRY.rear.x + PELICAN_GEOMETRY.front.x) / 2, y: PELICAN_GEOMETRY.rear.y };
const HALF_BASE = ((PELICAN_GEOMETRY.front.x - PELICAN_GEOMETRY.rear.x) / 2) * K;
const BASE = 420;
const END = 7000;

/** Lakes: no ground between their ends, water below. */
const LAKES = [
  { from: 1880, to: 2180 },
  { from: 4100, to: 4720 },
];

const smooth = (t: number): number => t * t * (3 - 2 * t);
const bump = (x: number, at: number, width: number, height: number): number => {
  const d = Math.abs(x - at) / width;
  return d >= 1 ? 0 : -height * smooth(1 - d);
};
const rampUp = (x: number, from: number, to: number, height: number): number => (x <= from ? 0 : x >= to ? -height : -height * smooth((x - from) / (to - from)));

/** The ground's height at x (smaller is higher). */
const groundY = (x: number): number =>
  BASE +
  // Rolling hills.
  bump(x, 900, 260, 60) +
  bump(x, 1350, 200, 34) +
  // A kicker before the first lake: up a ramp that ends at the water.
  (x <= 1880 ? rampUp(x, 1560, 1880, 110) : 0) +
  // Bumps, a crate wall at 2600, a big hill.
  bump(x, 2350, 70, 22) +
  bump(x, 2470, 70, 22) +
  bump(x, 3150, 330, 150) +
  // The long jump: a long ramp to the second lake, which only flight crosses.
  (x <= 4100 ? rampUp(x, 3600, 4100, 160) : 0) +
  // Down to the finish over two humps.
  bump(x, 5200, 160, 50) +
  bump(x, 5600, 120, 40) +
  bump(x, 6300, 400, -60);

const inLake = (x: number): boolean => LAKES.some((l) => x > l.from && x < l.to);

/** Fish to catch: over the lakes, where only a flight reaches, and a few on the hills. */
const FISH: { x: number; y: number }[] = [
  ...[0.2, 0.4, 0.6, 0.8].map((t) => ({ x: LAKES[0]!.from + t * (LAKES[0]!.to - LAKES[0]!.from), y: BASE - 200 - Math.sin(t * Math.PI) * 60 })),
  ...[0.12, 0.3, 0.5, 0.7, 0.88].map((t) => ({ x: LAKES[1]!.from + t * (LAKES[1]!.to - LAKES[1]!.from), y: BASE - 290 - Math.sin(t * Math.PI) * 70 })),
  { x: 900, y: groundY(900) - 50 },
  { x: 3150, y: groundY(3150) - 60 },
  { x: 5200, y: groundY(5200) - 60 },
];

/** Where a fall puts the bike back: flat ground after each hard part. */
const CHECKPOINTS = [120, 1180, 2280, 3540, 4860];

const C = {
  grass: "#4ade80",
  grassDark: "#16a34a",
  dirt: "#a16207",
  dirtDark: "#854d0e",
  water: "#38bdf8",
  waterDeep: "#0284c7",
  crate: "#b45309",
  crateDark: "#78350f",
};

// --- Drawing ---

const drawFish = (ctx: RecordingContext, x: number, y: number): void => {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#f8fafc";
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.quadraticCurveTo(0, -11, 14, 0);
  ctx.quadraticCurveTo(0, 11, -14, 0);
  ctx.moveTo(-12, 0);
  ctx.lineTo(-22, -8);
  ctx.lineTo(-22, 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(7, -2, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const drawCloud = (ctx: RecordingContext, x: number, y: number, s: number): void => {
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  // Each puff its own subpath, so no line joins them.
  for (const [dx, dy, rx, ry] of [
    [0, 0, 60, 22],
    [36, -16, 40, 24],
    [-30, -8, 32, 18],
  ] as const) {
    ctx.moveTo(x + (dx + rx) * s, y + dy * s);
    ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
  }
  ctx.fill();
};

/** The scenery, the ground in chunks, the lakes and the flag: drawn once. */
const drawCourse = (ctx: RecordingContext): { chunks: string[]; lakes: string[] } => {
  ctx.beginGroup({ id: "sky", meta: { name: "sky" } });
  for (let x = 200, i = 0; x < END + 600; x += 520 + ((i * 137) % 300), i++) drawCloud(ctx, x, 90 + ((i * 53) % 110), 0.7 + ((i * 29) % 50) / 100);
  ctx.endGroup();

  const lakes: string[] = [];
  LAKES.forEach((lake, i) => {
    const id = `lake ${i}`;
    lakes.push(id);
    ctx.beginGroup({ id, meta: { name: "lake" } });
    const top = BASE + 70;
    const g = ctx.createLinearGradient(0, top, 0, top + 200);
    g.addColorStop(0, C.water);
    g.addColorStop(1, C.waterDeep);
    ctx.fillStyle = g;
    ctx.fillRect(lake.from - 2, top, lake.to - lake.from + 4, 400);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = lake.from + 20; x < lake.to - 30; x += 46) {
      ctx.moveTo(x, top + 16);
      ctx.quadraticCurveTo(x + 8, top + 10, x + 16, top + 16);
    }
    ctx.stroke();
    ctx.endGroup();
  });

  // The ground between the lakes, each stretch one body with its outline as the collider. (Stretches
  // cut into chunks would catch the wheels on the walls where two chunks meet.)
  const chunks: string[] = [];
  const edges: number[] = [-800];
  for (const lake of LAKES) edges.push(lake.from, lake.to);
  // Ground runs on past the finish.
  edges.push(END + 900);
  for (let e = 0; e < edges.length - 1; e += 2) {
    const from = edges[e]!;
    const to = edges[e + 1]!;
    {
      const x0 = from;
      const x1 = to;
      const id = `ground ${chunks.length}`;
      chunks.push(id);
      ctx.beginGroup({ id, meta: { name: "ground" } });
      const top: { x: number; y: number }[] = [];
      for (let x = x0; x <= x1; x += 10) top.push({ x, y: groundY(x) });
      if (top.at(-1)!.x !== x1) top.push({ x: x1, y: groundY(x1) });
      ctx.fillStyle = C.dirt;
      ctx.beginPath();
      ctx.moveTo(x0, BASE + 400);
      for (const p of top) ctx.lineTo(p.x, p.y);
      ctx.lineTo(x1, BASE + 400);
      ctx.closePath();
      ctx.fill();
      // Grass along the top.
      ctx.strokeStyle = C.grass;
      ctx.lineWidth = 10;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const p of top) ctx.lineTo(p.x, p.y + 4);
      ctx.stroke();
      ctx.strokeStyle = C.grassDark;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const p of top) ctx.lineTo(p.x, p.y + 9);
      ctx.stroke();
      ctx.endGroup();
    }
  }

  ctx.beginGroup({ id: "flag", meta: { name: "finish" } });
  const fx = END - 300;
  const fy = groundY(fx);
  ctx.fillStyle = "#334155";
  ctx.fillRect(fx - 3, fy - 150, 6, 150);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? "#0f172a" : "#ffffff";
      ctx.fillRect(fx + 3 + c * 12, fy - 150 + r * 12, 12, 12);
    }
  }
  ctx.font = "700 20px system-ui, sans-serif";
  ctx.fillStyle = "#0f172a";
  ctx.fillText("FINISH", fx - 30, fy - 160);
  ctx.endGroup();

  ctx.beginGroup({ id: "signs", meta: { name: "signs" } });
  const sign = (x: number, text: string): void => {
    const y = groundY(x);
    ctx.fillStyle = "#78350f";
    ctx.fillRect(x - 2, y - 70, 4, 70);
    ctx.fillStyle = "#fef3c7";
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - 90, y - 104, 180, 38, 6);
    ctx.fill();
    ctx.stroke();
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = "#78350f";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y - 85);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  };
  sign(260, "→ to pedal, ← to brake");
  sign(1500, "Space to flap!");
  sign(2470, "Crates! Flap to hop");
  sign(3560, "Fish refill your wings");
  ctx.endGroup();
  return { chunks, lakes };
};

/** Records the rider (frame, legs, body, head) or the wing at the game's scale, with the axle midpoint at the origin. */
const atScale = (draw: (ctx: CanvasRenderingContext2D) => void) => (ctx: RecordingContext) => {
  ctx.scale(K, K);
  ctx.translate(-AXLES.x, -AXLES.y);
  draw(ctx as unknown as CanvasRenderingContext2D);
};

const POSES = 8;
const riderClip = new Clip(
  Array.from({ length: POSES }, (_, i) => ({
    at: i / POSES,
    drawing: () => drawing("bike/rider", atScale((ctx) => drawPelican(ctx, { crank: (i * 2 * Math.PI) / POSES, travel: 0 }, { scenery: false, wheels: false, wing: false }))),
  })),
  { loop: true },
);

const wingDrawing = (pose: WingPose) => () => drawing("bike/wing", atScale((ctx) => drawWing(ctx, pose)));
const flapClip = new Clip(
  [
    { at: 0, drawing: wingDrawing("up"), ease: easings.inOut },
    { at: 0.11, drawing: wingDrawing("down"), ease: easings.inOut },
  ],
  { loop: true, duration: 0.22 },
);
const unfoldClip = new Clip([
  { at: 0, drawing: wingDrawing("grip"), ease: easings.out },
  { at: 0.12, drawing: wingDrawing("up") },
]);
const foldClip = new Clip([
  { at: 0, drawing: wingDrawing("down"), ease: easings.inOut },
  { at: 0.3, drawing: wingDrawing("grip") },
]);

// --- The game ---

export interface GameUi {
  readonly canvas: HTMLCanvasElement;
  readonly hud: (state: { fish: number; total: number; stamina: number; time: number; speed: number }) => void;
  readonly message: (text: string | null) => void;
}

/** Which keys or touch buttons are held. */
export const input = { right: false, left: false, flap: false };

export const startGame = (ui: GameUi): { restart: () => void; scene: Scene } => {
  const record = new RecordingContext();
  const { chunks, lakes } = drawCourse(record);
  const scene = new Scene(record.getDocument());
  const physics = new Physics(scene, { gravity: { x: 0, y: 900 } });
  for (const id of chunks) physics.add(id, { collider: "outline", friction: 0.9 });
  for (const id of lakes) physics.add(id, { type: "static", sensor: true });

  // Crates: a wall to push through or hop over, and a stack on the big hill.
  const crates: string[] = [];
  const crate = (x: number, y: number, size: number): void => {
    const id = `crate ${crates.length}`;
    crates.push(id);
    scene.replaceGroup(
      id,
      drawing(id, (ctx) => {
        ctx.fillStyle = C.crate;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        ctx.strokeStyle = C.crateDark;
        ctx.lineWidth = 3;
        ctx.strokeRect(x - size / 2 + 3, y - size / 2 + 3, size - 6, size - 6);
        ctx.beginPath();
        ctx.moveTo(x - size / 2 + 4, y + size / 2 - 4);
        ctx.lineTo(x + size / 2 - 4, y - size / 2 + 4);
        ctx.stroke();
      }),
    );
    physics.add(id, { density: 1.2, friction: 0.7 });
  };
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2 - r; c++) crate(2620 + c * 34 + r * 17, groundY(2620) - 17 - r * 34, 32);
  for (let r = 0; r < 2; r++) crate(5850, groundY(5850) - 17 - r * 34, 32);

  const fish = FISH.map((_, i) => `fish ${i}`);
  const addFish = (i: number): void => {
    const id = fish[i]!;
    scene.replaceGroup(id, drawing(id, (ctx) => drawFish(ctx, FISH[i]!.x, FISH[i]!.y), { name: "fish", role: "img", label: "A fish" }));
    physics.add(id, { type: "static", sensor: true, collider: "circle" });
  };
  fish.forEach((_, i) => addFish(i));

  // The bicycle: wheels first (drawn under the frame), then the frame with the rider and the wing.
  for (const id of ["wheel rear", "wheel front"]) {
    scene.replaceGroup(
      id,
      drawing(id, (ctx) => {
        ctx.scale(K, K);
        drawWheel(ctx as unknown as CanvasRenderingContext2D, 0);
      }),
    );
  }
  scene.addGroup({ id: "bike", meta: { name: "bike", role: "img", label: "A pelican riding a bicycle" } });
  scene.replaceGroup("bike/rider", riderClip.frame(0), { parent: "bike" });
  scene.replaceGroup("bike/wing", wingDrawing("grip")(), { parent: "bike" });

  const world = physics.world;
  const spawn = CHECKPOINTS[0]!;
  const start = physics.meters({ x: spawn, y: groundY(spawn) - WHEEL_R - 4 });
  const chassis = world.createBody({ type: "dynamic", position: start, angularDamping: 2 });
  const m = (px: number): number => px / physics.scale;
  // Fixtures in px around the axle midpoint: the frame low between the wheels, the body above it, the head as a sensor.
  const bikeFilter = { filterGroupIndex: -1 };
  chassis.createFixture(new Box(m(HALF_BASE * 0.85), m(9), { x: 0, y: m(-18) }, 0), { density: 3, friction: 0.3, ...bikeFilter });
  chassis.createFixture(new Circle({ x: m(-22), y: m(-66) }, m(20)), { density: 0.3, friction: 0.3, ...bikeFilter });
  const head = chassis.createFixture(new Circle({ x: m(2), y: m(-118) }, m(11)), { density: 0.05, isSensor: true, ...bikeFilter });
  head.setUserData("head");
  physics.attach("bike", chassis, { x: 0, y: 0 });

  const wheelBody = (dx: number): Body => {
    const b = world.createBody({ type: "dynamic", position: { x: start.x + m(dx), y: start.y } });
    b.createFixture(new Circle(m(WHEEL_R)), { density: 1, friction: 1.4, restitution: 0.05, ...bikeFilter });
    return b;
  };
  const rear = wheelBody(-HALF_BASE);
  const front = wheelBody(HALF_BASE);
  physics.attach("wheel rear", rear, { x: 0, y: 0 });
  physics.attach("wheel front", front, { x: 0, y: 0 });
  const axis = { x: 0, y: 1 };
  const drive = world.createJoint(new WheelJoint({ enableMotor: true, maxMotorTorque: 0, motorSpeed: 0, frequencyHz: 4.5, dampingRatio: 0.7 }, chassis, rear, rear.getPosition(), axis))!;
  world.createJoint(new WheelJoint({ frequencyHz: 4.5, dampingRatio: 0.7 }, chassis, front, front.getPosition(), axis));

  // Contacts, kept until the step is over: the world can't change during one.
  const events: { kind: "crash" | "splash" | "fish"; id?: string }[] = [];
  const isBike = (f: Fixture): boolean => {
    const b = f.getBody();
    return b === chassis || b === rear || b === front;
  };
  world.on("begin-contact", (contact: Contact) => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!isBike(mine) || isBike(other)) continue;
      const id = physics.idOf(other.getBody()) ?? "";
      if (id.startsWith("fish")) events.push({ kind: "fish", id });
      else if (id.startsWith("lake")) events.push({ kind: "splash" });
      else if (mine.getUserData() === "head" && !other.isSensor()) events.push({ kind: "crash" });
    }
  });

  const ctx = ui.canvas.getContext("2d")!;
  const renderer = new Renderer(scene, ctx);
  let caught = 0;
  let stamina = 1;
  let time = 0;
  let finished = false;
  let checkpoint = 0;
  let wing: { mode: "grip" | "unfold" | "flap" | "fold"; t: number } = { mode: "grip", t: 0 };
  let crank = -1;
  let cam = { x: start.x * physics.scale - 300, y: groundY(spawn) - 360 };
  let dead: number | null = null;
  let stuck = 0;
  let hinted = false;

  const place = (x: number): void => {
    // Each wheel just above the ground under it, the frame tilted to match.
    const back = groundY(x - HALF_BASE) - WHEEL_R - 6;
    const ahead = groundY(x + HALF_BASE) - WHEEL_R - 6;
    const tilt = Math.atan2(ahead - back, 2 * HALF_BASE);
    for (const [body, dx, y] of [
      [chassis, 0, (back + ahead) / 2],
      [rear, -HALF_BASE, back],
      [front, HALF_BASE, ahead],
    ] as const) {
      body.setPosition(physics.meters({ x: x + dx, y }));
      body.setAngle(body === chassis ? tilt : 0);
      body.setLinearVelocity({ x: 0, y: 0 });
      body.setAngularVelocity(0);
      body.setAwake(true);
    }
  };

  const restart = (): void => {
    fish.forEach((id, i) => {
      if (!physics.body(id)) addFish(i);
    });
    caught = 0;
    stamina = 1;
    time = 0;
    finished = false;
    checkpoint = 0;
    dead = null;
    place(CHECKPOINTS[0]!);
    ui.message(null);
  };

  const grounded = (wheel: Body): boolean => {
    const p = wheel.getPosition();
    let hit = false;
    world.rayCast(p, { x: p.x, y: p.y + m(WHEEL_R + 5) }, (fixture) => {
      if (isBike(fixture) || fixture.isSensor()) return -1;
      hit = true;
      return 0;
    });
    return hit;
  };

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const onGround = grounded(rear) || grounded(front);

    // Pedals drive the rear wheel; in the air the arrows lean the bike instead.
    const speed = 14;
    if (dead === null && !finished && input.right) {
      drive.setMotorSpeed(speed);
      drive.setMaxMotorTorque(onGround ? 60 : 4);
    } else if (dead === null && !finished && input.left) {
      drive.setMotorSpeed(-6);
      drive.setMaxMotorTorque(30);
    } else {
      drive.setMotorSpeed(0);
      drive.setMaxMotorTorque(0.4);
    }
    if (!onGround && dead === null) {
      if (input.right) chassis.applyTorque(4);
      if (input.left) chassis.applyTorque(-4);
    }
    // Flapping: lift and a push forward while stamina lasts. Fish refill it.
    const flapping = dead === null && !finished && input.flap && stamina > 0;
    if (flapping) {
      const mass = chassis.getMass() + rear.getMass() + front.getMass();
      const v = chassis.getLinearVelocity();
      // Enough to climb, more when falling, and a little forward.
      chassis.applyForceToCenter({ x: mass * 4, y: -mass * (v.y > 0 ? 30 : 22) }, true);
      // A flying pelican keeps itself level.
      chassis.applyTorque(-chassis.getAngle() * 14 - chassis.getAngularVelocity() * 3);
      stamina = Math.max(0, stamina - dt * 0.4);
    } else if (onGround) stamina = Math.min(1, stamina + dt * 0.08);

    physics.step(dt);
    if (!finished && dead === null) time += dt;

    for (const e of events.splice(0)) {
      if (e.kind === "fish" && e.id && physics.body(e.id)) {
        physics.remove(e.id);
        scene.remove(e.id);
        caught++;
        stamina = Math.min(1, stamina + 0.45);
      } else if ((e.kind === "crash" || e.kind === "splash") && dead === null && !finished) {
        dead = now;
        ui.message(e.kind === "splash" ? "Splash! Flap over the water." : "Ouch! Keep the beak up.");
      }
    }
    const p = chassis.getPosition();
    const x = p.x * physics.scale;
    const y = p.y * physics.scale;
    if (dead === null && y > BASE + 300) {
      dead = now;
      ui.message("Splash! Flap over the water.");
    }
    // Pedaling and going nowhere for a while: say how to get out.
    if (dead === null && !finished && input.right && Math.abs(chassis.getLinearVelocity().x) < 0.2 && onGround) stuck += dt;
    else stuck = 0;
    if (stuck > 2.5 && !hinted) {
      hinted = true;
      ui.message("Stuck? Flap to hop, or press R to start over.");
    } else if (stuck === 0 && hinted && dead === null && !finished) {
      hinted = false;
      ui.message(null);
    }
    if (dead !== null && now - dead > 1200) {
      dead = null;
      place(CHECKPOINTS[checkpoint]!);
      ui.message(null);
    }
    while (checkpoint + 1 < CHECKPOINTS.length && x > CHECKPOINTS[checkpoint + 1]! + 60 && !inLake(x)) checkpoint++;
    if (!finished && x > END - 300) {
      finished = true;
      ui.message(`Finished in ${time.toFixed(1)} s with ${caught} of ${FISH.length} fish! Press R to ride again.`);
    }

    // The rider pedals as the rear wheel turns: the crank turns once for two turns of the wheel.
    const turn = (rear.getAngle() - chassis.getAngle()) / 2 / (2 * Math.PI);
    const pose = turn - Math.floor(turn);
    if (Math.abs(pose - crank) > 0.002) {
      crank = pose;
      scene.replaceGroup("bike/rider", riderClip.frame(pose));
    }
    // The wing: grip on the ground, unfold and flap while flapping, fold back after.
    const before = wing.mode;
    if (flapping) wing = wing.mode === "grip" || wing.mode === "fold" ? { mode: "unfold", t: 0 } : wing;
    else if (wing.mode === "flap" || wing.mode === "unfold") wing = { mode: "fold", t: 0 };
    wing.t += dt;
    if (wing.mode === "unfold" && wing.t >= unfoldClip.duration) wing = { mode: "flap", t: 0 };
    if (wing.mode === "fold" && wing.t >= foldClip.duration) wing = { mode: "grip", t: 0 };
    if (wing.mode !== "grip" || before !== "grip") {
      const clip = wing.mode === "unfold" ? unfoldClip : wing.mode === "flap" ? flapClip : wing.mode === "fold" ? foldClip : null;
      scene.replaceGroup("bike/wing", clip ? clip.frame(wing.t) : wingDrawing("grip")());
    }

    // The camera leads the bike a little; it moves in whole device pixels, so the renderer scrolls what it drew.
    const dpr = window.devicePixelRatio || 1;
    const width = ui.canvas.clientWidth;
    const height = ui.canvas.clientHeight;
    const v = chassis.getLinearVelocity();
    const target = { x: x - width * 0.35 + v.x * physics.scale * 0.25, y: Math.min(y - height * 0.55, BASE + 140 - height) };
    cam = { x: cam.x + (target.x - cam.x) * Math.min(1, dt * 4), y: cam.y + (target.y - cam.y) * Math.min(1, dt * 3) };
    if (ui.canvas.width !== Math.round(width * dpr) || ui.canvas.height !== Math.round(height * dpr)) {
      ui.canvas.width = Math.round(width * dpr);
      ui.canvas.height = Math.round(height * dpr);
    }
    renderer.setView({ a: dpr, b: 0, c: 0, d: dpr, e: -Math.round(cam.x * dpr), f: -Math.round(cam.y * dpr) }, ui.canvas.width, ui.canvas.height);
    renderer.render();
    ui.hud({ fish: caught, total: FISH.length, stamina, time, speed: Math.abs(v.x) });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // For tests and the curious: where the bike is.
  (globalThis as { pelicanRide?: unknown }).pelicanRide = { chassis, rear, front, physics, scene, drive, state: () => ({ dead, finished, checkpoint, input }) };
  return { restart, scene };
};
