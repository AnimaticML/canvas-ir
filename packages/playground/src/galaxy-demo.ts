// Stars and planets: a spiral galaxy of a few billion stars, made region by
// region as you look at it. Its sky is a VirtualGroup. The galaxy is split
// into a quadtree of cells, from one cell for all of it down to cells 2 light
// years across, and every cell adds a few stars of its own, placed by a hash
// of where it is, so nothing is stored and the same stars come back. Zoomed
// out, the cells too small to see are a glow and only the stars of the larger
// cells show; zooming in brings in the stars of smaller cells, then a star's
// planets, their moons and the planets' surfaces. The view goes from the
// whole galaxy to a planet's face, about 10^13 times, so the camera keeps its
// position as a whole light year plus a fraction and everything is drawn
// relative to it: the board's own float coordinates would run out long before.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type RecordingContextOptions, type Rect, type Scene, VirtualGroup } from "canvas-ir";
import { WheelGesture } from "./wheel";

export const GALAXY_ID = "galaxy";
export const GALAXY_AT = { x: 1300, y: 3250 };
const W = 1400;
const TITLE = 46;
const H = 840;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** The square the galaxy is made in, in light years: a power of two, so cell corners are whole numbers. */
const SPAN = 2 ** 17;
const HALF = SPAN / 2;
/** The finest cells are a light year across. */
const LEAF = 17;
/** Stars each cell adds, on average, where the density is 1. */
const MEAN = 1.5;
/** The finest cells drawn are about this many screen pixels across. */
const TARGET = 30;
/** Units, in light years. */
const AU = 1.5813e-5;
const EARTH = 6.734e-10;
const SUN = 4.65e-3 * AU;
const KM = 1 / 9.4607e12;

const mix = (a: number): number => {
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return (a ^ (a >>> 16)) >>> 0;
};
const hash = (a: number, b: number, c: number, d: number): number => mix(mix(mix(mix(a + 0x9e3779b9) ^ b) ^ c) ^ d);
const unit = (h: number): number => h / 4294967296;
const random = (seed: number): (() => number) => {
  let s = seed;
  return () => unit((s = mix(s + 0x6d2b79f5)));
};

const lattice = (i: number, j: number, seed: number): number => unit(mix(Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ seed));

/** Smooth noise in [0, 1] on a lattice of whole numbers. */
const noise = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(xi, yi, seed);
  const b = lattice(xi + 1, yi, seed);
  const c = lattice(xi, yi + 1, seed);
  const d = lattice(xi + 1, yi + 1, seed);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
};

/** How far the galaxy reaches from its center, in light years. */
const EDGE = 56_000;

/** Stars per square light year, relatively: a bulge, a disk, two spiral arms with spurs between them, and clumps. */
const density = (x: number, y: number): number => {
  const r2 = x * x + y * y;
  if (r2 > EDGE * EDGE) return 0;
  const r = Math.sqrt(r2);
  const bulge = 3.2 * Math.exp(-r2 / (2600 * 2600)) + 1.2 * Math.exp(-r / 1800);
  const swirl = Math.atan2(y, x) + 0.6 * (noise(x / 9000, y / 9000, 3) - 0.5) - Math.log(Math.max(r, 500) / 4000) / 0.36;
  const arms = Math.max(((1 + Math.cos(2 * swirl)) / 2) ** 5, 0.35 * ((1 + Math.cos(4 * swirl + 0.9)) / 2) ** 8);
  const clumps = 0.6 * noise(x / 2500, y / 2500, 1) + 0.4 * noise(x / 500, y / 500, 2);
  const disk = Math.exp(-r / 13_000) * (1 - Math.min(1, Math.max(0, (r - 38_000) / (EDGE - 38_000))) ** 2);
  return bulge + 2.6 * disk * (0.06 + 0.94 * arms) * (0.3 + 1.4 * clumps);
};

/** The galaxy's light, as a picture: drawn under the stars while the stars that make it are too small to draw one by one. */
const GLOW = 768;
const glowImage = (): HTMLCanvasElement | null => {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GLOW;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(GLOW, GLOW);
  for (let j = 0; j < GLOW; j++) {
    for (let i = 0; i < GLOW; i++) {
      const x = -EDGE + ((i + 0.5) * 2 * EDGE) / GLOW;
      const y = -EDGE + ((j + 0.5) * 2 * EDGE) / GLOW;
      const v = Math.min(1, Math.sqrt(density(x, y) / 3.5));
      // Warm in the bulge, bluer out along the arms.
      const t = Math.min(1, Math.hypot(x, y) / 14_000);
      const k = 4 * (j * GLOW + i);
      image.data[k] = 255 - 85 * t;
      image.data[k + 1] = 214 - 19 * t;
      image.data[k + 2] = 160 + 95 * t;
      image.data[k + 3] = 235 * v;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
};

const CLASSES = [
  { name: "O", share: 0.003, color: "#9bb0ff", radius: 8, reach: 6, boost: 0.8 },
  { name: "B", share: 0.013, color: "#aabfff", radius: 4, reach: 4, boost: 0.5 },
  { name: "A", share: 0.04, color: "#cad7ff", radius: 1.8, reach: 2, boost: 0.25 },
  { name: "F", share: 0.1, color: "#f8f7ff", radius: 1.3, reach: 1.3, boost: 0.1 },
  { name: "G", share: 0.2, color: "#fff4ea", radius: 1, reach: 1, boost: 0 },
  { name: "K", share: 0.45, color: "#ffd2a1", radius: 0.8, reach: 0.7, boost: 0 },
  { name: "M", share: 1, color: "#ffcc6f", radius: 0.4, reach: 0.35, boost: -0.1 },
] as const;

const SYLLABLES = ["ka", "ri", "ve", "lo", "an", "tor", "mi", "sa", "del", "ur", "ny", "xe", "qua", "bel", "ion", "ar", "ce", "po", "zan", "hel", "os", "tri", "em", "vin"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

interface Star {
  readonly id: string;
  /** Where it is, in light years from the galaxy's center: exact, so a camera beside it keeps its precision. */
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly cls: (typeof CLASSES)[number];
  readonly seed: number;
}

type Kind = "molten" | "rocky" | "ocean" | "ice" | "gas";
interface Moon {
  readonly orbit: number;
  readonly radius: number;
  readonly angle: number;
}
interface Planet {
  readonly index: number;
  /** Orbit, in AU; radius, in Earth radii. */
  readonly orbit: number;
  readonly radius: number;
  readonly angle: number;
  readonly kind: Kind;
  readonly seed: number;
  readonly moons: readonly Moon[];
}

const starName = (seed: number): string => {
  const next = random(seed ^ 0x51ed);
  const parts = 2 + (next() < 0.3 ? 1 : 0);
  let name = "";
  for (let i = 0; i < parts; i++) name += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
  return `${name[0]!.toUpperCase()}${name.slice(1)}-${Math.floor(next() * 1000)}`;
};

const planetsOf = (star: Star): Planet[] => {
  const next = random(star.seed);
  const count = next() < 0.15 ? 0 : 1 + Math.floor(next() * next() * 9);
  const planets: Planet[] = [];
  for (let i = 0; i < count; i++) {
    const orbit = 0.3 * 1.8 ** i * (0.85 + 0.3 * next()) * star.cls.reach;
    const warmth = orbit / star.cls.reach;
    const roll = next();
    const kind: Kind =
      warmth < 0.6 ? (roll < 0.4 ? "molten" : "rocky") : warmth < 1.8 ? (roll < 0.5 ? "ocean" : "rocky") : warmth < 4 ? (roll < 0.5 ? "gas" : roll < 0.75 ? "ice" : "rocky") : roll < 0.7 ? "gas" : "ice";
    const size = { molten: [0.4, 1.2], rocky: [0.4, 1.6], ocean: [0.8, 1.5], ice: [0.5, 3.8], gas: [3.5, 11.5] }[kind];
    const radius = size[0]! + (size[1]! - size[0]!) * next();
    const moons: Moon[] = [];
    const moonCount = kind === "gas" ? Math.floor(next() * 5) : next() < 0.3 ? 1 : 0;
    for (let m = 0; m < moonCount; m++) moons.push({ orbit: radius * (4 + m * 5 + next() * 4), radius: 0.12 + next() * 0.33, angle: next() * Math.PI * 2 });
    planets.push({ index: i, orbit, radius, angle: next() * Math.PI * 2, kind, seed: mix(star.seed + i * 977), moons });
  }
  return planets;
};

/** A length the eye can read: light years, AU or kilometers. */
const distance = (ly: number): string => {
  if (ly >= 0.1) return `${ly >= 100 ? Math.round(ly).toLocaleString("en-US") : ly.toPrecision(2)} ly`;
  if (ly >= 0.01 * AU) return `${(ly / AU).toPrecision(2)} AU`;
  return `${Math.round(ly / KM).toLocaleString("en-US")} km`;
};

/** A position the camera can hold at any zoom: a whole light year and a fraction. */
interface At {
  readonly whole: number;
  readonly part: number;
}
const at = (whole: number, part: number): At => {
  const carry = Math.floor(part);
  return { whole: whole + carry, part: part - carry };
};

interface Camera {
  x: At;
  y: At;
  /** Content units (board units, before the board's zoom) per light year. */
  scale: number;
}

interface FrameState {
  readonly note: string;
}

export interface GalaxyHost {
  readonly components: () => Components;
  /** The board's zoom: screen pixels per world unit. */
  readonly zoom: () => number;
  readonly render: () => void;
  readonly log: (line: string) => void;
  /** How the sky records: a recorder that can store the glow's picture, without stack captures. */
  readonly recorder: RecordingContextOptions;
}

const FIT = (0.92 * H) / (2 * EDGE);
const MIN_SCALE = FIT / 2;
/** A small rocky planet nearly fills the view. */
const MAX_SCALE = (0.45 * H) / (0.4 * EARTH);

export class StarsAndPlanets {
  private x = GALAXY_AT.x;
  private y = GALAXY_AT.y;
  private camera: Camera = { x: at(0, 0), y: at(0, 0), scale: FIT };
  private readonly sky: VirtualGroup;
  private readonly frame: ComponentHandle<FrameState>;
  private readonly total: number;
  private unlisten: (() => void)[] = [];
  private readonly gesture = new WheelGesture();
  /** What a click on a drawn star or planet flies to. */
  private targets = new Map<string, { x: At; y: At; scale: number }>();
  private drawn = 0;
  /** The stars last drawn and where, for a click near one. */
  private spots: (Star | number)[] = [];
  private readonly glow = glowImage();
  private flight = 0;

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly host: GalaxyHost,
  ) {
    // How many stars there are: every level adds MEAN stars per cell where the density is 1.
    const n = 256;
    let sum = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sum += density(-HALF + ((i + 0.5) * SPAN) / n, -HALF + ((j + 0.5) * SPAN) / n);
    this.total = ((MEAN * sum) / (n * n)) * ((4 ** (LEAF + 1) - 1) / 3);
    host.log(`stars and planets: ${(this.total / 1e9).toFixed(1)} billion stars, none stored`);
    scene.addGroup({ id: GALAXY_ID, meta: { role: "figure", label: "Stars and planets", source: "stars and planets" } });
    this.frame = host.components().mount(this.frameSpec());
    this.sky = new VirtualGroup(scene, {
      id: `${GALAXY_ID}:sky`,
      parent: GALAXY_ID,
      meta: { role: "img", label: "A galaxy of stars" },
      extent: { x: 0, y: 0, width: W, height: H },
      draw: (ctx, window) => this.draw(ctx, window),
    }, { recorder: host.recorder });
    this.show();
    this.listen();
  }

  get alive(): boolean {
    return this.scene.getGroup(GALAXY_ID) !== undefined;
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: W, height: TITLE + H };
  }

  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.sky.bind(scene);
    this.listen();
  }

  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.show();
  }

  /** The board zoomed: stars are sized in screen pixels, so the sky draws again. */
  zoomed(): void {
    if (this.alive) this.show();
  }

  private listen(): void {
    for (const off of this.unlisten) off();
    const sky = `${GALAXY_ID}:sky`;
    let moved = false;
    this.unlisten = [
      this.router.on(GALAXY_ID, "wheel", (e) => {
        const input = e.input as { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
        if (input.ctrlKey || input.metaKey) return;
        e.stopPropagation();
        this.land();
        // A sideways gesture pans, as on the chart; up and down zooms about the pointer.
        const { zoom: dy, pan } = this.gesture.read(input);
        const c = this.camera;
        if (pan !== 0) {
          c.x = at(c.x.whole, c.x.part + pan / (this.host.zoom() * c.scale));
        } else {
          const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, c.scale * Math.exp(-dy * 0.0025)));
          const px = (e.point.x - this.x - W / 2) / c.scale;
          const py = (e.point.y - this.y - TITLE - H / 2) / c.scale;
          const k = 1 - c.scale / scale;
          c.x = at(c.x.whole, c.x.part + px * k);
          c.y = at(c.y.whole, c.y.part + py * k);
          c.scale = scale;
        }
        this.redraw();
      }),
      this.router.on(sky, "down", (e) => {
        e.stopPropagation();
        moved = false;
        this.land();
      }),
      this.router.on(sky, "dragstart", (e) => e.stopPropagation()),
      this.router.on(sky, "drag", (e) => {
        e.stopPropagation();
        moved = true;
        const c = this.camera;
        c.x = at(c.x.whole, c.x.part - e.delta!.x / c.scale);
        c.y = at(c.y.whole, c.y.part - e.delta!.y / c.scale);
        this.redraw();
      }),
      // A click on a star flies to its planets; on a planet, to its face.
      this.router.on(sky, "click", (e) => {
        e.stopPropagation();
        if (moved) return;
        // The scene names groups drawn in the sky after it: `galaxy:sky/<id>`.
        const target = e.path.map((id) => this.targets.get(id.slice(sky.length + 1))).find((t) => t !== undefined) ?? this.nearest(e.point.x - this.x, e.point.y - this.y - TITLE);
        if (target) this.fly(target);
      }),
    ];
  }

  /** Where to fly for the star drawn nearest a point in the sky, if one is within a few pixels. */
  private nearest(px: number, py: number): { x: At; y: At; scale: number } | null {
    let best: Star | null = null;
    let reach = 12 / this.host.zoom();
    for (let k = 0; k < this.spots.length; k += 3) {
      const d = Math.hypot((this.spots[k + 1] as number) - px, (this.spots[k + 2] as number) - py);
      if (d < reach) {
        reach = d;
        best = this.spots[k] as Star;
      }
    }
    return best ? this.target(best) : null;
  }

  /** Where to fly to see a star's planets. */
  private target(star: Star): { x: At; y: At; scale: number } {
    const planets = planetsOf(star);
    const reach = planets.length > 0 ? planets.at(-1)!.orbit : 2 * star.cls.reach;
    return { x: at(Math.floor(star.x), star.x - Math.floor(star.x)), y: at(Math.floor(star.y), star.y - Math.floor(star.y)), scale: (0.42 * H) / (reach * AU) };
  }

  /** Stops a flight where it is. */
  private land(): void {
    if (this.flight) cancelAnimationFrame(this.flight);
    this.flight = 0;
  }

  /** Moves the camera to a target over a second, zooming at a steady rate and keeping the target's screen distance shrinking evenly. */
  private fly(to: { x: At; y: At; scale: number }): void {
    this.land();
    const from = { ...this.camera };
    // The way from the target back to the start, so the end lands exactly on the target.
    const back = { x: from.x.whole - to.x.whole + (from.x.part - to.x.part), y: from.y.whole - to.y.whole + (from.y.part - to.y.part) };
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, to.scale));
    const start = performance.now();
    const ms = 900 + 120 * Math.abs(Math.log10(scale / from.scale));
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const s = from.scale * (scale / from.scale) ** e;
      // The share of the way still to go: on a zoom in, so the target nears the center evenly on screen.
      const rest = scale > from.scale ? (1 - e) * (from.scale / s) : 1 - e;
      this.camera = { x: at(to.x.whole, to.x.part + back.x * rest), y: at(to.y.whole, to.y.part + back.y * rest), scale: s };
      this.redraw();
      this.flight = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flight = requestAnimationFrame(step);
  }

  /** Back to the whole galaxy. */
  home(): void {
    this.fly({ x: at(0, 0), y: at(0, 0), scale: FIT });
  }

  private redraw(): void {
    const t0 = performance.now();
    this.sky.refresh();
    this.note(performance.now() - t0);
    this.host.render();
  }

  private show(): void {
    const t0 = performance.now();
    const redrew = this.sky.show({
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y + TITLE },
      // A pixel short of the frame's bottom, so the sky leaves its border showing.
      visible: { x: this.x, y: this.y + TITLE, width: W, height: H - 1 },
      clip: true,
      // Stars are sized in screen pixels: a few steps per doubling of the board's zoom.
      detail: Math.round(Math.log2(this.host.zoom()) * 3),
    });
    if (redrew) this.note(performance.now() - t0);
    this.host.render();
  }

  private note(ms: number): void {
    this.frame.setState({ note: `${distance(W / this.camera.scale)} across: ${this.drawn.toLocaleString("en-US")} stars drawn in ${ms.toFixed(1)} ms` });
  }

  private draw(ctx: RecordingContext, window: Rect): void {
    const c = this.camera;
    const z = this.host.zoom();
    const s = c.scale;
    const pxPerLy = s * z;
    // Content coordinates of a position: relative to the camera first, so the difference is exact.
    const lx = (x: number): number => W / 2 + (x - c.x.whole - c.x.part) * s;
    const ly = (y: number): number => H / 2 + (y - c.y.whole - c.y.part) * s;
    this.targets = new Map();
    this.spots = [];
    this.drawn = 0;
    ctx.fillStyle = "#04060d";
    ctx.fillRect(window.x, window.y, window.width, window.height);

    const cx = c.x.whole + c.x.part;
    const cy = c.y.whole + c.y.part;
    // Levels: cells of the finest one drawn are about TARGET pixels across, more where the stars are thick, as in the core.
    // (Only up close: zoomed out, the core is a small part of the view.)
    const thick = W / s > 3000 ? 0 : Math.max(density(cx, cy), density(cx - W / 3 / s, cy), density(cx + W / 3 / s, cy), density(cx, cy - H / 3 / s), density(cx, cy + H / 3 / s));
    const kf = Math.log2((SPAN * pxPerLy) / (TARGET * Math.sqrt(Math.max(1, thick / 1.2))));
    const top = Math.max(0, Math.min(LEAF, Math.ceil(kf)));
    const systems = pxPerLy * AU > 0.02;
    const margin = 6 / pxPerLy + (systems ? 120 * AU : 0);
    const x0 = cx + (window.x - W / 2) / s - margin;
    const x1 = cx + (window.x + window.width - W / 2) / s + margin;
    const y0 = cy + (window.y - H / 2) / s - margin;
    const y1 = cy + (window.y + window.height - H / 2) / s + margin;
    const cells = (level: number, visit: (i: number, j: number, size: number) => void): void => {
      const size = SPAN / 2 ** level;
      const last = 2 ** level - 1;
      const i0 = Math.max(0, Math.floor((x0 + HALF) / size));
      const i1 = Math.min(last, Math.floor((x1 + HALF) / size));
      const j0 = Math.max(0, Math.floor((y0 + HALF) / size));
      const j1 = Math.min(last, Math.floor((y1 + HALF) / size));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          // Cells wholly outside the galaxy's edge have nothing.
          const nx = Math.max(Math.abs(-HALF + (i + 0.5) * size) - size / 2, 0);
          const ny = Math.max(Math.abs(-HALF + (j + 0.5) * size) - size / 2, 0);
          if (nx * nx + ny * ny < EDGE * EDGE) visit(i, j, size);
        }
      }
    };

    // The glow of the stars too small to draw, fading out as the finest cells come into view: the part of the picture that shows.
    const fade = Math.max(0, Math.min(1, (LEAF - 3 - kf) / 4));
    if (fade > 0 && this.glow) {
      const scale = GLOW / (2 * EDGE);
      const gx0 = Math.max(-EDGE, cx + (window.x - W / 2) / s);
      const gx1 = Math.min(EDGE, cx + (window.x + window.width - W / 2) / s);
      const gy0 = Math.max(-EDGE, cy + (window.y - H / 2) / s);
      const gy1 = Math.min(EDGE, cy + (window.y + window.height - H / 2) / s);
      if (gx1 > gx0 && gy1 > gy0) {
        ctx.globalAlpha = fade;
        ctx.drawImage(this.glow, (gx0 + EDGE) * scale, (gy0 + EDGE) * scale, (gx1 - gx0) * scale, (gy1 - gy0) * scale, lx(gx0), ly(gy0), (gx1 - gx0) * s, (gy1 - gy0) * s);
        ctx.globalAlpha = 1;
      }
    }

    // Stars: each level's cells add their own, by a hash of the cell. Faint ones go into one path per color and brightness.
    const batches = new Map<string, { color: string; alpha: number; stars: number[] }>();
    const near: { star: Star; r: number }[] = [];
    for (let level = 0; level <= top; level++) {
      const alpha = Math.max(0, Math.min(1, kf - level + 1));
      cells(level, (i, j, size) => {
        const ox = -HALF + i * size;
        const oy = -HALF + j * size;
        // In a big cell the density changes across it: candidates are made for where it is densest and kept by the
        // density where each lands, so stars follow the arms. In a small one it hardly changes, and its center's will do.
        const small = size <= 64;
        const most = small ? density(ox + size / 2, oy + size / 2) : 7;
        const tries = Math.floor(MEAN * most + unit(hash(level, i, j, 7)));
        for (let t = 0; t < tries; t++) {
          const x = ox + unit(hash(level, i, j, 100 + t)) * size;
          const y = oy + unit(hash(level, i, j, 200 + t)) * size;
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          if (!small && unit(hash(level, i, j, 300 + t)) * most > density(x, y)) continue;
          const roll = unit(hash(level, i, j, 400 + t));
          const cls = CLASSES.find((k) => roll < k.share)!;
          const star: Star = { id: `s${level}-${i}-${j}-${t}`, x, y, level, cls, seed: hash(level, i, j, 500 + t) };
          const r = Math.max(0.7 + 0.42 * Math.min(5, kf - level) + cls.boost, cls.radius * SUN * pxPerLy);
          this.drawn++;
          this.spots.push(star, lx(x), ly(y));
          if (r >= 2 || systems) {
            near.push({ star, r });
            continue;
          }
          const key = `${cls.name}${Math.round(alpha * 4)}`;
          let batch = batches.get(key);
          if (!batch) batches.set(key, (batch = { color: cls.color, alpha: Math.round(alpha * 4) / 4, stars: [] }));
          batch.stars.push(lx(x), ly(y), r / z);
        }
      });
    }
    for (const { color, alpha, stars } of batches.values()) {
      if (alpha === 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < stars.length; k += 3) {
        ctx.moveTo(stars[k]! + stars[k + 2]!, stars[k + 1]!);
        ctx.arc(stars[k]!, stars[k + 1]!, stars[k + 2]!, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Bright and nearby stars one by one, each a group with its name for the board's tooltip and a click that flies to it.
    for (const { star, r } of near) this.star(ctx, star, r, lx(star.x), ly(star.y), window, z, pxPerLy);
  }

  private star(ctx: RecordingContext, star: Star, r: number, sx: number, sy: number, window: Rect, z: number, pxPerLy: number): void {
    const planets = planetsOf(star);
    const reach = planets.length > 0 ? planets.at(-1)!.orbit : 2 * star.cls.reach;
    const name = starName(star.seed);
    const s = this.camera.scale;
    const orbitPx = reach * AU * pxPerLy;
    const fromCore = Math.round(Math.hypot(star.x, star.y)).toLocaleString("en-US");
    const inView = (x: number, y: number, pad: number) => x + pad >= window.x && x - pad <= window.x + window.width && y + pad >= window.y && y - pad <= window.y + window.height;
    if (orbitPx >= 10) {
      // The planets' orbits, then the planets, nearer ones over farther.
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = "rgba(150, 170, 220, 0.28)";
      for (const p of planets) this.ring(ctx, sx, sy, p.orbit * AU * s, window);
      for (const p of planets) {
        const R = p.orbit * AU * s;
        const px = sx + Math.cos(p.angle) * R;
        const py = sy + Math.sin(p.angle) * R;
        const radius = p.radius * EARTH * s;
        const reachMoons = p.moons.length > 0 ? p.moons.at(-1)!.orbit * EARTH * s : 0;
        if (!inView(px, py, Math.max(radius, reachMoons) + 40 / z)) continue;
        const pr = Math.max(3.5 / z, radius);
        const id = `${star.id}-p${p.index}`;
        const label = `${name} ${ROMAN[p.index]}`;
        ctx.beginGroup({ id, meta: { datum: `${label}\n${p.kind === "gas" ? "gas giant" : `${p.kind} planet`}, ${p.radius.toFixed(1)} Earth radii\n${p.orbit.toPrecision(2)} AU from ${name}` } });
        if (pr * z >= 20) this.planet(ctx, p, px, py, pr, Math.atan2(sy - py, sx - px), window);
        else {
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fillStyle = PLANET_COLORS[p.kind][3];
          ctx.fill();
        }
        // Its numeral, in its group, so a click on either flies to it.
        if (pr * z < 20 && p.orbit * AU * pxPerLy * 0.3 > 40) {
          ctx.font = `${11 / z}px ${FONT}`;
          ctx.fillStyle = "rgba(226, 232, 240, 0.7)";
          ctx.fillText(ROMAN[p.index]!, px + pr + 4 / z, py - 4 / z);
        }
        ctx.endGroup();
        this.targets.set(id, { x: at(Math.floor(star.x), star.x - Math.floor(star.x) + Math.cos(p.angle) * p.orbit * AU), y: at(Math.floor(star.y), star.y - Math.floor(star.y) + Math.sin(p.angle) * p.orbit * AU), scale: (0.28 * H) / (p.radius * EARTH) });
        // Moons, once their orbits are big enough to tell apart.
        for (const m of p.moons) {
          const mr = m.orbit * EARTH * s;
          if (mr * z < 8) continue;
          ctx.lineWidth = 1 / z;
          ctx.strokeStyle = "rgba(150, 170, 220, 0.2)";
          this.ring(ctx, px, py, mr, window);
          ctx.beginPath();
          ctx.arc(px + Math.cos(m.angle) * mr, py + Math.sin(m.angle) * mr, Math.max(1.4 / z, m.radius * EARTH * s), 0, Math.PI * 2);
          ctx.fillStyle = "#cbd5e1";
          ctx.fill();
        }
      }
    }
    // Seen with its planets, a star is a small sun.
    if (orbitPx >= 10) r = Math.max(r, 4);
    if (!inView(sx, sy, r / z + 4 / z)) return;
    ctx.beginGroup({ id: star.id, meta: { datum: `${name}\n${star.cls.name}-type star, ${planets.length === 0 ? "no planets" : planets.length === 1 ? "1 planet" : `${planets.length} planets`}\n${fromCore} ly from the core` } });
    if (r >= 2.5) {
      // A soft halo around the brightest.
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = star.cls.color;
      this.disc(ctx, sx, sy, (r * 2.4) / z, window);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = star.cls.color;
    this.disc(ctx, sx, sy, r / z, window);
    ctx.fill();
    ctx.endGroup();
    this.targets.set(star.id, this.target(star));
    if (orbitPx >= 40) {
      ctx.font = `${12 / z}px ${FONT}`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
      ctx.fillText(name, sx + r / z + 6 / z, sy - 6 / z);
    }
  }

  /** A planet's face, lit from its star. */
  private planet(ctx: RecordingContext, p: Planet, cx: number, cy: number, r: number, light: number, window: Rect): void {
    const [base, land, haze] = PLANET_COLORS[p.kind];
    const next = random(p.seed);
    if (p.kind === "ocean" || p.kind === "gas") {
      ctx.fillStyle = haze;
      this.disc(ctx, cx, cy, r * 1.05, window);
      ctx.fill();
    }
    ctx.save();
    this.disc(ctx, cx, cy, r, window);
    ctx.clip();
    ctx.fillStyle = base;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    if (p.kind === "gas") {
      // Bands, and a storm.
      let y = cy - r;
      for (let k = 0; y < cy + r; k++) {
        const h = r * (0.06 + 0.14 * next());
        ctx.fillStyle = k % 2 === 0 ? land : base;
        ctx.globalAlpha = 0.5 + 0.5 * next();
        ctx.fillRect(cx - r, y, 2 * r, h);
        y += h;
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#b45309";
      ctx.beginPath();
      ctx.ellipse(cx + r * (next() - 0.5), cy + r * (next() - 0.5) * 0.8, r * 0.16, r * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Continents, or patches: blobs with wavy coasts.
      ctx.fillStyle = land;
      const blobs = 5 + Math.floor(next() * 5);
      for (let b = 0; b < blobs; b++) {
        const bx = cx + r * (next() * 1.6 - 0.8);
        const by = cy + r * (next() * 1.6 - 0.8);
        const br = r * (0.12 + 0.3 * next());
        const w = [next() * 6, next() * 6, next() * 6];
        ctx.beginPath();
        for (let k = 0; k <= 40; k++) {
          const a = (k / 40) * Math.PI * 2;
          const rr = br * (1 + 0.28 * Math.sin(3 * a + w[0]!) + 0.16 * Math.sin(5 * a + w[1]!) + 0.08 * Math.sin(11 * a + w[2]!));
          ctx.lineTo(bx + Math.cos(a) * rr, by + Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
      }
      if (p.kind === "ocean" || p.kind === "ice") {
        ctx.fillStyle = "rgba(241, 245, 249, 0.92)";
        ctx.beginPath();
        ctx.ellipse(cx, cy - r, r * 0.55, r * 0.16, 0, 0, Math.PI * 2);
        ctx.ellipse(cx, cy + r, r * 0.5, r * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Night on the side away from the star.
    const dx = Math.cos(light) * r;
    const dy = Math.sin(light) * r;
    const shade = ctx.createLinearGradient(cx + dx, cy + dy, cx - dx, cy - dy);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(0.45, "rgba(0, 0, 0, 0.12)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0.88)");
    ctx.fillStyle = shade;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.restore();
  }

  /**
   * A disc as a path. A huge one (a star seen from beside one of its
   * planets) becomes the slice of it that can show, so no coordinate runs off
   * past what the canvas draws well.
   */
  private disc(ctx: RecordingContext, cx: number, cy: number, r: number, window: Rect): void {
    ctx.beginPath();
    if (r < 3000) {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      return;
    }
    const mx = window.x + window.width / 2;
    const my = window.y + window.height / 2;
    const diag = Math.hypot(window.width, window.height);
    const d = Math.hypot(mx - cx, my - cy);
    if (d + diag < r) {
      ctx.rect(window.x - 10, window.y - 10, window.width + 20, window.height + 20);
      return;
    }
    if (d - diag > r) return;
    const toward = Math.atan2(my - cy, mx - cx);
    const half = Math.min(Math.PI, (1.5 * diag) / r);
    // The center, or a point toward it far enough outside the view.
    const back = Math.min(d, diag * 4);
    ctx.moveTo(mx - Math.cos(toward) * back, my - Math.sin(toward) * back);
    for (let k = 0; k <= 48; k++) {
      const a = toward - half + (2 * half * k) / 48;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  /** An orbit, stroked; a huge one only where it crosses the view. */
  private ring(ctx: RecordingContext, cx: number, cy: number, r: number, window: Rect): void {
    ctx.beginPath();
    if (r < 3000) {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const mx = window.x + window.width / 2;
    const my = window.y + window.height / 2;
    const diag = Math.hypot(window.width, window.height);
    if (Math.abs(Math.hypot(mx - cx, my - cy) - r) > diag) return;
    const toward = Math.atan2(my - cy, mx - cx);
    const half = Math.min(Math.PI, (1.5 * diag) / r);
    for (let k = 0; k <= 48; k++) {
      const a = toward - half + (2 * half * k) / 48;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.stroke();
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const button = { x: W - 14 - 120, y: 10, width: 120, height: 26 };
    return {
      id: `${GALAXY_ID}:frame`,
      parent: GALAXY_ID,
      state: { note: "" },
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y },
      cursor: () => "default",
      draw: (c, s) => {
        c.shadowColor = "rgba(15, 23, 42, 0.3)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(0, 0, W, TITLE + H, 10);
        c.fillStyle = "#0b1020";
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = "#1e293b";
        c.lineWidth = 1;
        c.stroke();
        c.textBaseline = "middle";
        c.font = `600 15px ${FONT}`;
        c.fillStyle = "#f1f5f9";
        c.fillText(`Stars and planets: a galaxy of ${(this.total / 1e9).toFixed(1)} billion stars`, 14, TITLE / 2);
        c.font = `12px ${FONT}`;
        c.fillStyle = "#94a3b8";
        c.textAlign = "right";
        c.fillText(`${s.note}. Wheel zooms, drag pans, click a star or planet to fly there.`, button.x - 14, TITLE / 2);
        c.beginPath();
        c.roundRect(button.x, button.y, button.width, button.height, 6);
        c.fillStyle = "#1e293b";
        c.fill();
        c.fillStyle = "#e2e8f0";
        c.textAlign = "center";
        c.fillText("Whole galaxy", button.x + button.width / 2, button.y + button.height / 2);
        c.textAlign = "left";
      },
      on: {
        click: (e) => {
          const px = e.point.x - this.x;
          const py = e.point.y - this.y;
          if (px < button.x || px > button.x + button.width || py < button.y || py > button.y + button.height) return;
          e.stopPropagation();
          this.home();
        },
      },
    };
  }
}

/** A planet's base, its land or bands, its haze, and its color as a dot far away. */
const PLANET_COLORS: Record<Kind, readonly [string, string, string, string]> = {
  molten: ["#3f1d16", "#f97316", "rgba(249, 115, 22, 0.2)", "#fb923c"],
  rocky: ["#a16207", "#78350f", "rgba(253, 230, 138, 0.15)", "#d6a35c"],
  ocean: ["#1d4ed8", "#15803d", "rgba(147, 197, 253, 0.35)", "#60a5fa"],
  ice: ["#cbd5e1", "#94a3b8", "rgba(226, 232, 240, 0.25)", "#e2e8f0"],
  gas: ["#d6b48a", "#a47148", "rgba(253, 230, 138, 0.25)", "#f2c88f"],
};
